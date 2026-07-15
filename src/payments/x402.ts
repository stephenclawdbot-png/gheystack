/**
 * x402 Payment Protocol — HTTP 402 Payment Required for agent API monetization
 *
 * Inspired by Circle's x402 batching. Agents pay USDC per API call.
 * Sellers return 402 with payment requirements; agents pay and retry.
 *
 * Flow:
 * 1. Agent requests API endpoint
 * 2. Server responds 402 with { amount, currency, recipient, memo }
 * 3. Agent pays USDC via wallet
 * 4. Agent retries with payment proof header
 * 5. Server responds 200 with data
 */

import type { PaymentRequest, WalletHandle } from "../core/types.js";

export interface x402Response {
  status: 402;
  accepts: {
    amount: number;
    currency: "USDC";
    recipient: string;
    network: string;
    memo?: string;
  };
}

export interface x402PaymentHeader {
  "X-Payment": string; // base64 encoded payment proof
  "X-Payment-Chain": string;
}

export class x402Client {
  private wallet: WalletHandle;

  constructor(wallet: WalletHandle) {
    this.wallet = wallet;
  }

  /** Fetch a paid endpoint — handles 402 negotiation automatically */
  async fetch(url: string, opts?: RequestInit): Promise<Response> {
    // First attempt
    const res = await fetch(url, opts);

    if (res.status === 402) {
      // Parse payment requirements
      const payment: x402Response["accepts"] = await res.json().then(
        (d) => d.accepts,
        () => null
      );

      if (!payment) {
        throw new Error("402 response missing payment requirements");
      }

      // Pay USDC
      const txHash = await this.wallet.send(payment.recipient, payment.amount);

      // Retry with payment proof
      const headers = new Headers(opts?.headers);
      headers.set("X-Payment", btoa(JSON.stringify({ txHash, amount: payment.amount, currency: "USDC" })));
      headers.set("X-Payment-Chain", this.wallet.chain);

      return fetch(url, { ...opts, headers });
    }

    return res;
  }
}

/** x402 batching — batch multiple micropayments for settlement */
export class x402Batcher {
  private payments: PaymentRequest[] = [];
  private wallet: WalletHandle;
  private sellerAddress: string;

  constructor(wallet: WalletHandle, sellerAddress: string) {
    this.wallet = wallet;
    this.sellerAddress = sellerAddress;
  }

  /** Queue a payment for batch settlement */
  queue(amount: number, memo?: string): void {
    this.payments.push({
      amount,
      currency: "USDC",
      recipient: this.sellerAddress,
      memo,
    });
  }

  /** Settle all queued payments in a single transaction */
  async settle(): Promise<string> {
    if (this.payments.length === 0) return "nothing to settle";

    const total = this.payments.reduce((sum, p) => sum + p.amount, 0);
    console.log(`[gheystack] Settling ${this.payments.length} payments totaling ${total} USDC`);

    const txHash = await this.wallet.send(this.sellerAddress, total);
    this.payments = []; // Clear queue

    return txHash;
  }

  /** Get pending total */
  pendingTotal(): number {
    return this.payments.reduce((sum, p) => sum + p.amount, 0);
  }

  /** Get pending count */
  pendingCount(): number {
    return this.payments.length;
  }
}