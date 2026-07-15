/**
 * Settlement Service — batch settlement for micropayments
 *
 * Collects small USDC payments throughout a period and settles them
 * in a single transaction to save on gas fees.
 *
 * Modes:
 * - "time": settle every N seconds
 * - "amount": settle when total reaches threshold
 * - "count": settle when N payments queued
 * - "manual": settle only when .settle() is called
 */

import type { WalletHandle, PaymentRequest } from "../core/types.js";

export type SettleMode = "time" | "amount" | "count" | "manual";

export interface SettlementConfig {
  mode: SettleMode;
  /** For "time" mode: seconds between settlements */
  intervalSeconds?: number;
  /** For "amount" mode: USDC threshold to trigger settlement */
  amountThreshold?: number;
  /** For "count" mode: number of payments to trigger settlement */
  countThreshold?: number;
  /** Recipient address for batch settlement */
  recipient: string;
}

export class SettlementService {
  private wallet: WalletHandle;
  private config: SettlementConfig;
  private pendingQueue: PaymentRequest[] = [];
  private timer: NodeJS.Timeout | null = null;
  private totalSettled: number = 0;
  private txCount: number = 0;

  constructor(wallet: WalletHandle, config: SettlementConfig) {
    this.wallet = wallet;
    this.config = config;
  }

  /** Start the settlement service */
  start(): void {
    if (this.config.mode === "time" && this.config.intervalSeconds) {
      this.timer = setInterval(() => this.settle(), this.config.intervalSeconds * 1000);
      console.log(`[stack] Settlement service running (every ${this.config.intervalSeconds}s)`);
    }
  }

  /** Stop the settlement service */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Queue a payment for settlement */
  queue(amount: number, memo?: string): void {
    this.pendingQueue.push({
      amount,
      currency: "USDC",
      recipient: this.config.recipient,
      memo,
    });

    // Auto-trigger based on mode
    if (this.config.mode === "amount" && this.pendingTotal() >= (this.config.amountThreshold ?? Infinity)) {
      this.settle();
    } else if (this.config.mode === "count" && this.pendingQueue.length >= (this.config.countThreshold ?? Infinity)) {
      this.settle();
    }
  }

  /** Settle all queued payments in a single transaction */
  async settle(): Promise<string | null> {
    if (this.pendingQueue.length === 0) return null;

    const total = this.pendingTotal();
    console.log(`[stack] Settling ${this.pendingQueue.length} payments totaling ${total} USDC`);

    const txHash = await this.wallet.send(this.config.recipient, total);

    this.totalSettled += total;
    this.txCount += this.pendingQueue.length;
    this.pendingQueue = [];

    console.log(`[stack] Settled. TX: ${txHash}`);
    return txHash;
  }

  /** Get total pending USDC */
  pendingTotal(): number {
    return this.pendingQueue.reduce((sum, p) => sum + p.amount, 0);
  }

  /** Get number of pending payments */
  pendingCount(): number {
    return this.pendingQueue.length;
  }

  /** Get lifetime stats */
  stats(): { totalSettled: number; txCount: number; pendingCount: number; pendingTotal: number } {
    return {
      totalSettled: this.totalSettled,
      txCount: this.txCount,
      pendingCount: this.pendingCount(),
      pendingTotal: this.pendingTotal(),
    };
  }
}