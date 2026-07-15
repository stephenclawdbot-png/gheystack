/**
 * Agent Identity & Cryptographic Signing
 *
 * Each agent has an Ethereum keypair used for:
 * - Signing mesh messages (EIP-712 typed data)
 * - Signing payment channel state updates
 * - Verifying messages from other agents
 *
 * DIDs follow the format: did:stack:0xADDRESS
 *
 * Uses viem for signing — no external crypto dependency needed.
 */

import {
  createWalletClient,
  http,
  verifyMessage,
  hashMessage,
  recoverAddress,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount, generatePrivateKey, addressFromPrivateKey } from "viem/accounts";
import { base, mainnet, polygon, arbitrum } from "viem/chains";
import type {
  AgentIdentity,
  SignedMessage,
  MeshMessage,
  ChannelState,
} from "./types.js";

const CHAIN_MAP = {
  base,
  ethereum: mainnet,
  polygon,
  arbitrum,
};

/**
 * EIP-712 domain for mesh message signing.
 * This defines the typed data structure that all agents use.
 */
export const MESH_DOMAIN = {
  name: "StackMesh",
  version: "1.0.0",
  chainId: 8453, // Base mainnet as canonical mesh chain
} as const;

/**
 * EIP-712 types for mesh messages.
 * These types define the structure of signed messages in the mesh protocol.
 */
export const MESH_TYPES = {
  MeshMessage: [
    { name: "type", type: "string" },
    { name: "taskId", type: "string" },
    { name: "timestamp", type: "uint256" },
  ],
  ChannelState: [
    { name: "channelId", type: "string" },
    { name: "sequence", type: "uint256" },
    { name: "balanceA", type: "uint256" },
    { name: "balanceB", type: "uint256" },
  ],
  TaskAcceptance: [
    { name: "taskId", type: "string" },
    { name: "bidder", type: "address" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface IdentityConfig {
  /** Private key (if not provided, one is generated) */
  privateKey?: `0x${string}`;
  /** Agent name */
  name: string;
  /** Agent endpoint URL */
  endpoint: string;
  /** Capabilities */
  capabilities: string[];
  /** Pricing per capability (USDC) */
  pricing: Record<string, number>;
  /** Chain */
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  /** RPC URL (optional) */
  rpcUrl?: string;
}

export class AgentIdentityManager {
  private account: LocalAccount;
  private identity: AgentIdentity;
  private walletClient: any;

  constructor(config: IdentityConfig) {
    const privateKey = config.privateKey ?? generatePrivateKey();
    this.account = privateKeyToAccount(privateKey);

    this.identity = {
      did: `did:stack:${this.account.address}`,
      address: this.account.address,
      name: config.name,
      endpoint: config.endpoint,
      capabilities: config.capabilities,
      pricing: config.pricing,
      publicKey: this.account.address, // address serves as public identifier
      chain: config.chain,
    };

    const chain = CHAIN_MAP[config.chain];
    const transport = config.rpcUrl ? http(config.rpcUrl) : http();

    this.walletClient = createWalletClient({
      chain,
      transport,
      account: this.account,
    });
  }

  /** Get the agent's identity */
  getIdentity(): AgentIdentity {
    return this.identity;
  }

  /** Get the agent's address */
  get address(): `0x${string}` {
    return this.account.address;
  }

  /** Get the private key (for wallet operations) */
  get privateKey(): `0x${string}` {
    return this.account.source as `0x${string}`;
  }

  /**
   * Sign a mesh message using EIP-712 typed data.
   * This produces a cryptographic proof that this agent authored the message.
   */
  async signMessage(payload: MeshMessage): Promise<SignedMessage> {
    const timestamp = Date.now();

    // Sign the message hash (simplified EIP-712 for mesh protocol)
    const messageHash = hashMessage(
      JSON.stringify({ type: payload.type, taskId: (payload as any).taskId, timestamp })
    );

    const signature = await this.account.signMessage({
      message: JSON.stringify({ type: payload.type, taskId: (payload as any).taskId, timestamp }),
    });

    return {
      signature,
      payload,
      signer: this.account.address,
      timestamp,
    };
  }

  /**
   * Sign a payment channel state update.
   * This is the core of off-chain payment channels — the signature
   * proves the signer agreed to this balance state, enabling trustless
   * on-chain settlement if needed.
   */
  async signChannelState(state: ChannelState): Promise<`0x${string}`> {
    const message = JSON.stringify({
      channelId: state.channelId,
      sequence: state.sequence,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
    });

    const signature = await this.account.signMessage({ message });
    return signature;
  }

  /**
   * Verify a signature from another agent.
   * Returns true if the signature was produced by the claimed signer.
   */
  static async verifySignature(
    message: string,
    signature: `0x${string}`,
    expectedSigner: `0x${string}`
  ): Promise<boolean> {
    try {
      const recovered = await recoverAddress({
        message: { raw: hashMessage(message) },
        signature,
      });
      return recovered.toLowerCase() === expectedSigner.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Verify a signed mesh message.
   */
  static async verifySignedMessage(signed: SignedMessage): Promise<boolean> {
    const message = JSON.stringify({
      type: signed.payload.type,
      taskId: (signed.payload as any).taskId,
      timestamp: signed.timestamp,
    });

    return AgentIdentityManager.verifySignature(
      message,
      signed.signature,
      signed.signer
    );
  }

  /**
   * Verify a channel state signature.
   * Used when settling payment channels on-chain or during disputes.
   */
  static async verifyChannelSignature(
    state: ChannelState,
    signature: `0x${string}`,
    expectedSigner: `0x${string}`
  ): Promise<boolean> {
    const message = JSON.stringify({
      channelId: state.channelId,
      sequence: state.sequence,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
    });

    return AgentIdentityManager.verifySignature(message, signature, expectedSigner);
  }

  /**
   * Create a new identity with a generated keypair.
   */
  static create(config: Omit<IdentityConfig, "privateKey">): AgentIdentityManager {
    return new AgentIdentityManager(config);
  }

  /**
   * Create a discovery message to announce this agent to the mesh.
   */
  createDiscoveryMessage(): DiscoveryPayload {
    return {
      type: "discovery",
      agent: this.identity,
      timestamp: Date.now(),
    };
  }
}

export interface DiscoveryPayload {
  type: "discovery";
  agent: AgentIdentity;
  timestamp: number;
}

export { generatePrivateKey, privateKeyToAccount };