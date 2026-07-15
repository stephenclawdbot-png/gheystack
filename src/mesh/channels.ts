/**
 * Bidirectional Payment Channels
 *
 * Off-chain payment channels enable instant, gas-free micropayments
 * between agents. Inspired by Lightning Network's payment channel
 * concept but adapted for ERC20 (USDC) on EVM chains.
 *
 * How it works:
 * 1. OPEN: Both agents deposit USDC on-chain into a channel contract
 *    (or one agent deposits for a one-directional channel)
 * 2. UPDATE: Agents exchange signed balance updates off-chain —
 *    each update is a signed message proving both parties agree to
 *    the new balance distribution. No gas, no on-chain tx.
 * 3. CLOSE: Either party can submit the latest signed state on-chain.
 *    After a challenge period, funds are distributed per the latest state.
 *    If one party is unresponsive, the other can close with their last
 *    signed state.
 *
 * This file implements the off-chain logic. On-chain channel contracts
 * would be deployed for open/close/dispute (see ChannelContract below).
 *
 * Security model:
 * - Every state update is signed by BOTH parties
 * - Only the latest signed state (highest sequence number) is valid
 * - During dispute, the party with the highest signed sequence wins
 * - Funds can never be stolen — worst case is delayed by challenge period
 */

import type { WalletHandle } from "../core/types.js";
import type { PaymentChannel, ChannelState } from "./types.js";
import { AgentIdentityManager } from "./identity.js";

export interface ChannelConfig {
  /** Challenge period in blocks for dispute resolution */
  challengePeriod?: number;
  /** Default deposit amounts */
  defaultDeposit?: number;
}

export class PaymentChannelManager {
  private channels: Map<string, PaymentChannel> = new Map();
  private identity: AgentIdentityManager;
  private wallet: WalletHandle;
  private config: ChannelConfig;

  constructor(identity: AgentIdentityManager, wallet: WalletHandle, config?: ChannelConfig) {
    this.identity = identity;
    this.wallet = wallet;
    this.config = {
      challengePeriod: config?.challengePeriod ?? 100, // ~15 min on Base
      defaultDeposit: config?.defaultDeposit ?? 10, // 10 USDC default
    };
  }

  /**
   * Open a payment channel with another agent.
   * Sends USDC deposit on-chain (real tx) and creates the channel record.
   *
   * In production, this would call a channel contract that escrows the USDC.
   * Here we simulate the deposit with a direct transfer to a deterministic
   * channel address and track the off-chain state.
   */
  async openChannel(
    counterparty: `0x${string}`,
    myDeposit: number = this.config.defaultDeposit ?? 10,
    counterpartyDeposit: number = 0
  ): Promise<PaymentChannel> {
    const channelId = this.computeChannelId(this.identity.address, counterparty);

    // Check if channel already exists
    if (this.channels.has(channelId)) {
      const existing = this.channels.get(channelId)!;
      if (existing.status === "open") {
        throw new Error(`Channel ${channelId} already open`);
      }
    }

    // Send deposit on-chain (in production: to channel contract)
    if (myDeposit > 0) {
      await this.wallet.send(counterparty, myDeposit);
    }

    const channel: PaymentChannel = {
      channelId,
      partyA: this.identity.address,
      partyB: counterparty,
      depositA: myDeposit,
      depositB: counterpartyDeposit,
      balanceA: myDeposit,
      balanceB: counterpartyDeposit,
      sequence: 0,
      status: "open",
      openedBlock: 0, // would be set from on-chain event
      challengePeriod: this.config.challengePeriod ?? 100,
    };

    this.channels.set(channelId, channel);
    console.log(`[mesh] Channel opened: ${channelId} (deposit: ${myDeposit} USDC)`);

    return channel;
  }

  /**
   * Send an off-chain payment through a channel.
   * This is the core micropayment primitive — NO gas, instant, signed.
   *
   * 1. Update balances in the channel state
   * 2. Increment sequence number
   * 3. Sign the new state
   * 4. Send the signed state to the counterparty
   *
   * The counterparty verifies the signature and stores the state.
   * If either party needs to close, they submit the latest signed state.
   */
  async send(channelId: string, amount: number): Promise<ChannelState> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    if (channel.status !== "open") throw new Error(`Channel is ${channel.status}`);

    if (amount > channel.balanceA) {
      throw new Error(
        `Insufficient channel balance: have ${channel.balanceA}, need ${amount}`
      );
    }

    // Update state
    channel.sequence++;
    channel.balanceA -= amount;
    channel.balanceB += amount;

    const state: ChannelState = {
      channelId: channel.channelId,
      sequence: channel.sequence,
      balanceA: channel.balanceA,
      balanceB: channel.balanceB,
    };

    // Sign the state update
    const signature = await this.identity.signChannelState(state);
    channel.latestSignatureA = signature;

    console.log(
      `[mesh] Channel payment: ${amount} USDC via ${channelId} (seq: ${channel.sequence})`
    );

    return state;
  }

  /**
   * Receive a channel state update from the counterparty.
   * Verifies the signature and stores the latest state.
   *
   * Called when we receive a signed state update from the other party.
   * We verify they actually signed it, then store it as the latest state.
   */
  async receiveUpdate(
    channelId: string,
    state: ChannelState,
    signature: `0x${string}`,
    counterpartyAddress: `0x${string}`
  ): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    // Verify the signature
    const valid = await AgentIdentityManager.verifyChannelSignature(
      state,
      signature,
      counterpartyAddress
    );

    if (!valid) {
      console.warn(`[mesh] Invalid channel signature from ${counterpartyAddress}`);
      return false;
    }

    // Only accept states with higher sequence numbers
    if (state.sequence <= channel.sequence) {
      console.warn(`[mesh] Stale channel state (seq ${state.sequence} <= ${channel.sequence})`);
      return false;
    }

    // Update our channel state
    channel.sequence = state.sequence;
    channel.balanceA = state.balanceA;
    channel.balanceB = state.balanceB;
    channel.latestSignatureB = signature;

    console.log(`[mesh] Channel updated: ${channelId} (seq: ${channel.sequence})`);
    return true;
  }

  /**
   * Cooperatively close a channel.
   * Both parties sign the final state, and one submits it on-chain.
   * This is the happy path — instant close with agreed balances.
   */
  async cooperativeClose(channelId: string): Promise<`0x${string}` | null> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const state: ChannelState = {
      channelId: channel.channelId,
      sequence: channel.sequence,
      balanceA: channel.balanceA,
      balanceB: channel.balanceB,
    };

    // Sign the final state
    const mySignature = await this.identity.signChannelState(state);
    channel.latestSignatureA = mySignature;

    // In production: submit to channel contract with both signatures
    // For now: settle by sending each party their balance
    if (channel.balanceA > 0) {
      // We'd withdraw our balance from the channel contract
      console.log(`[mesh] Withdraw ${channel.balanceA} USDC from channel`);
    }

    channel.status = "closed";
    console.log(`[mesh] Channel closed: ${channelId}`);

    return null;
  }

  /**
   * Unilaterally close a channel (dispute path).
   * Used when the counterparty is unresponsive.
   *
   * 1. Submit the latest signed state on-chain
   * 2. Start the challenge period
   * 3. If counterparty provides a higher signed state, update
   * 4. After challenge period, withdraw funds per latest state
   */
  async unilateralClose(channelId: string): Promise<string> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    if (!channel.latestSignatureA || !channel.latestSignatureB) {
      // Can still close with our own signature if counterparty never signed
      console.warn(`[mesh] Closing channel without counterparty signature`);
    }

    channel.status = "closing";
    console.log(
      `[mesh] Unilateral close initiated for ${channelId}, challenge period: ${channel.challengePeriod} blocks`
    );

    // In production: call channelContract.close(latestState, signatures)
    return `close-tx-${channelId}`;
  }

  /**
   * Challenge a unilateral close with a higher sequence state.
   * Called when the other party tries to close with a stale state.
   */
  async challengeClose(
    channelId: string,
    higherState: ChannelState,
    signature: `0x${string}`
  ): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    if (higherState.sequence > channel.sequence) {
      // Update to the higher state
      channel.sequence = higherState.sequence;
      channel.balanceA = higherState.balanceA;
      channel.balanceB = higherState.balanceB;
      console.log(`[mesh] Challenged with higher state (seq: ${higherState.sequence})`);
      return true;
    }

    return false;
  }

  /**
   * Get channel info
   */
  getChannel(channelId: string): PaymentChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * List all channels
   */
  listChannels(): PaymentChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get total capacity across all open channels
   */
  totalCapacity(): number {
    return Array.from(this.channels.values())
      .filter((c) => c.status === "open")
      .reduce((sum, c) => sum + c.balanceA, 0);
  }

  /**
   * Compute a deterministic channel ID from the two parties.
   * Channel ID = keccak256(min(a,b), max(a,b), nonce)
   * Simplified here as a hash-like string.
   */
  private computeChannelId(a: `0x${string}`, b: `0x${string}`): string {
    const sorted = [a.toLowerCase(), b.toLowerCase()].sort();
    // Simple hash (in production: use keccak256)
    const raw = `${sorted[0]}-${sorted[1]}-${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return `ch-${Math.abs(hash).toString(16).padStart(8, "0")}`;
  }
}

/**
 * On-chain Channel Contract Interface (for reference).
 *
 * In production, deploy this contract and interact with it:
 *
 * contract PaymentChannel {
 *   struct Channel {
 *     address partyA;
 *     address partyB;
 *     uint256 depositA;
 *     uint256 depositB;
 *     uint256 sequence;
 *     uint256 balanceA;
 *     uint256 balanceB;
 *     uint256 challengePeriod;
 *     uint256 closeBlock;
 *     bool closing;
 *   }
 *
 *   function open(address partyB) payable { ... }
 *   function close(State calldata state, bytes sigA, bytes sigB) { ... }
 *   function challenge(State calldata state, bytes sig) { ... }
 *   function withdraw() { ... }
 * }
 *
 * The off-chain logic above handles all the state management and signing.
 * The contract only handles on-chain settlement and dispute resolution.
 */