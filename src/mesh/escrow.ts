/**
 * USDC Escrow Service
 *
 * Trustless escrow for task bounties in the mesh task market.
 * The poster locks USDC when creating a task; the worker receives
 * it on completion. If the task fails or expires, funds return to the poster.
 *
 * Features:
 * - Time-locked: auto-refund after deadline
 * - Arbiter support: optional third-party dispute resolution
 * - Milestone payments: multi-step tasks with partial releases
 * - On-chain settlement: real USDC transfers via wallet
 *
 * Flow:
 * 1. POSTER creates escrow → USDC transferred from poster to escrow (locked)
 * 2. WORKER completes task → escrow released → USDC to worker
 * 3. If dispute → arbiter decides → release or refund
 * 4. If expired → poster can reclaim funds
 */

import type { WalletHandle } from "../core/types.js";
import type { Escrow, EscrowMilestone, EscrowStatus } from "./types.js";
import { AgentIdentityManager } from "./identity.js";

export interface EscrowConfig {
  /** Default escrow duration in seconds */
  defaultDuration?: number;
  /** Auto-expire check interval (ms) */
  expiryCheckInterval?: number;
}

export class EscrowService {
  private escrows: Map<string, Escrow> = new Map();
  private identity: AgentIdentityManager;
  private wallet: WalletHandle;
  private config: EscrowConfig;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(identity: AgentIdentityManager, wallet: WalletHandle, config?: EscrowConfig) {
    this.identity = identity;
    this.wallet = wallet;
    this.config = {
      defaultDuration: config?.defaultDuration ?? 3600, // 1 hour default
      expiryCheckInterval: config?.expiryCheckInterval ?? 60000, // check every minute
    };
  }

  /**
   * Create a new escrow — locks USDC for a task bounty.
   *
   * This transfers USDC from the caller (poster) to hold in escrow.
   * In production, this would call an escrow contract that locks funds.
   * Here we simulate by tracking the state and using the wallet for transfers.
   */
  async create(params: {
    beneficiary: `0x${string}`;
    amount: number;
    durationSeconds?: number;
    arbiter?: `0x${string}`;
    milestones?: EscrowMilestone[];
  }): Promise<Escrow> {
    const id = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const duration = params.durationSeconds ?? this.config.defaultDuration!;

    // Transfer USDC to lock in escrow (in production: to escrow contract)
    // For now, we hold the amount in our tracking and transfer on release
    console.log(`[mesh] Escrow created: ${id} — ${params.amount} USDC for ${params.beneficiary}`);

    const escrow: Escrow = {
      id,
      depositor: this.identity.address,
      beneficiary: params.beneficiary,
      arbiter: params.arbiter,
      amount: params.amount,
      chain: this.wallet.chain,
      status: "locked",
      lockedAt: now,
      expiresAt: now + duration * 1000,
      milestones: params.milestones,
    };

    this.escrows.set(id, escrow);

    // Start expiry checker if not running
    if (!this.expiryTimer) {
      this.startExpiryChecker();
    }

    return escrow;
  }

  /**
   * Release escrow funds to the beneficiary (worker).
   * Called when the task is verified as complete.
   *
   * If milestones are defined, releases the next unreleased milestone.
   * Otherwise, releases the full amount.
   */
  async release(escrowId: string, milestoneIndex?: number): Promise<string> {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status !== "locked") throw new Error(`Escrow is ${escrow.status}`);

    // Check authorization
    const isDepositor = escrow.depositor === this.identity.address;
    const isArbiter = escrow.arbiter === this.identity.address;
    if (!isDepositor && !isArbiter) {
      throw new Error("Only depositor or arbiter can release escrow");
    }

    // Milestone release
    if (escrow.milestones && escrow.milestones.length > 0) {
      if (milestoneIndex === undefined) {
        // Release next unreleased milestone
        const idx = escrow.milestones.findIndex((m) => !m.released);
        if (idx === -1) throw new Error("All milestones already released");
        return this.releaseMilestone(escrowId, idx);
      }
      return this.releaseMilestone(escrowId, milestoneIndex);
    }

    // Full release
    const txHash = await this.wallet.send(escrow.beneficiary, escrow.amount);
    escrow.status = "released";
    console.log(`[mesh] Escrow released: ${escrowId} — ${escrow.amount} USDC → ${escrow.beneficiary}`);

    return txHash;
  }

  /**
   * Release a specific milestone payment.
   */
  private async releaseMilestone(escrowId: string, index: number): Promise<string> {
    const escrow = this.escrows.get(escrowId)!;
    const milestone = escrow.milestones![index];

    if (milestone.released) throw new Error(`Milestone ${index} already released`);

    const txHash = await this.wallet.send(escrow.beneficiary, milestone.amount);
    milestone.released = true;
    milestone.releasedAt = Date.now();

    // Check if all milestones released
    const allReleased = escrow.milestones!.every((m) => m.released);
    if (allReleased) {
      escrow.status = "released";
    }

    console.log(
      `[mesh] Milestone ${index} released: ${milestone.amount} USDC from ${escrowId}`
    );

    return txHash;
  }

  /**
   * Refund escrow to the depositor (poster).
   * Called when a task fails or the worker doesn't deliver.
   */
  async refund(escrowId: string): Promise<string> {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status !== "locked" && escrow.status !== "disputed") {
      throw new Error(`Escrow is ${escrow.status}`);
    }

    // Check authorization
    const isDepositor = escrow.depositor === this.identity.address;
    const isArbiter = escrow.arbiter === this.identity.address;
    if (!isDepositor && !isArbiter) {
      throw new Error("Only depositor or arbiter can refund escrow");
    }

    // Calculate refundable amount (minus released milestones)
    let refundAmount = escrow.amount;
    if (escrow.milestones) {
      const released = escrow.milestones
        .filter((m) => m.released)
        .reduce((sum, m) => sum + m.amount, 0);
      refundAmount = escrow.amount - released;
    }

    if (refundAmount > 0) {
      const txHash = await this.wallet.send(escrow.depositor, refundAmount);
      escrow.status = "refunded";
      console.log(`[mesh] Escrow refunded: ${escrowId} — ${refundAmount} USDC → ${escrow.depositor}`);
      return txHash;
    }

    escrow.status = "refunded";
    return "nothing to refund";
  }

  /**
   * Raise a dispute — moves escrow to disputed state for arbiter resolution.
   * Either party can raise a dispute.
   */
  async dispute(escrowId: string): Promise<void> {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status !== "locked") throw new Error(`Escrow is ${escrow.status}`);
    if (!escrow.arbiter) throw new Error("No arbiter set for this escrow");

    escrow.status = "disputed";
    console.log(`[mesh] Escrow disputed: ${escrowId} — arbiter: ${escrow.arbiter}`);
  }

  /**
   * Arbiter resolves a dispute — either release or refund.
   */
  async resolveDispute(escrowId: string, releaseToBeneficiary: boolean): Promise<string> {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);
    if (escrow.status !== "disputed") throw new Error(`Escrow is ${escrow.status}`);
    if (escrow.arbiter !== this.identity.address) {
      throw new Error("Only the arbiter can resolve disputes");
    }

    if (releaseToBeneficiary) {
      return this.release(escrowId);
    } else {
      return this.refund(escrowId);
    }
  }

  /**
   * Claim expired escrow — auto-refund to depositor after deadline.
   */
  async claimExpired(escrowId: string): Promise<string | null> {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) return null;
    if (escrow.status !== "locked") return null;
    if (Date.now() < escrow.expiresAt) return null;

    escrow.status = "expired";
    const refundAmount = escrow.milestones
      ? escrow.amount - escrow.milestones.filter((m) => m.released).reduce((s, m) => s + m.amount, 0)
      : escrow.amount;

    if (refundAmount > 0) {
      const txHash = await this.wallet.send(escrow.depositor, refundAmount);
      console.log(`[mesh] Escrow expired & refunded: ${escrowId} — ${refundAmount} USDC`);
      return txHash;
    }
    return null;
  }

  /**
   * Get escrow by ID.
   */
  get(escrowId: string): Escrow | undefined {
    return this.escrows.get(escrowId);
  }

  /**
   * List all escrows (optionally filtered by status).
   */
  list(status?: EscrowStatus): Escrow[] {
    const all = Array.from(this.escrows.values());
    return status ? all.filter((e) => e.status === status) : all;
  }

  /**
   * Get total locked USDC across all active escrows.
   */
  totalLocked(): number {
    return Array.from(this.escrows.values())
      .filter((e) => e.status === "locked" || e.status === "disputed")
      .reduce((sum, e) => {
        const released = e.milestones
          ? e.milestones.filter((m) => m.released).reduce((s, m) => s + m.amount, 0)
          : 0;
        return sum + (e.amount - released);
      }, 0);
  }

  /**
   * Start the automatic expiry checker.
   * Periodically checks for expired escrows and auto-refunds them.
   */
  private startExpiryChecker(): void {
    this.expiryTimer = setInterval(async () => {
      for (const [id, escrow] of this.escrows) {
        if (escrow.status === "locked" && Date.now() >= escrow.expiresAt) {
          try {
            await this.claimExpired(id);
          } catch (e) {
            console.warn(`[mesh] Failed to expire escrow ${id}: ${e}`);
          }
        }
      }
    }, this.config.expiryCheckInterval);
  }

  /**
   * Stop the expiry checker.
   */
  stopExpiryChecker(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}