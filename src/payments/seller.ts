/**
 * Seller SDK — turn any API endpoint into USDC revenue
 * Agents pay per call using x402 protocol; sellers receive USDC in batch
 */

import type { WalletHandle } from "../core/types.js";
import { x402Batcher } from "./x402.js";

export interface SellerConfig {
  sellerAddress: string;
  pricePerCall: number;
  wallet: WalletHandle;
}

export class Seller {
  private config: SellerConfig;
  private batcher: x402Batcher;

  constructor(config: SellerConfig) {
    this.config = config;
    this.batcher = new x402Batcher(config.wallet, config.sellerAddress);
  }

  /** Middleware for Express/connect-style servers */
  middleware() {
    return async (req: any, res: any, next: any) => {
      const payment = req.headers["x-payment"];

      if (!payment) {
        // No payment — return 402
        res.status(402).json({
          accepts: {
            amount: this.config.pricePerCall,
            currency: "USDC",
            recipient: this.config.sellerAddress,
            network: this.config.wallet.chain,
            memo: `API call: ${req.method} ${req.path}`,
          },
        });
        return;
      }

      // Verify payment (in production: verify on-chain tx)
      try {
        const proof = JSON.parse(atob(payment));
        console.log(`[gheystack] Payment received: ${proof.amount} USDC (tx: ${proof.txHash})`);

        // Queue for batch settlement
        this.batcher.queue(this.config.pricePerCall, `${req.method} ${req.path}`);

        next();
      } catch {
        res.status(402).json({ error: "Invalid payment proof" });
      }
    };
  }

  /** Settle batched payments */
  async settle(): Promise<string> {
    return this.batcher.settle();
  }

  /** Get pending revenue */
  pendingRevenue(): number {
    return this.batcher.pendingTotal();
  }

  pendingCount(): number {
    return this.batcher.pendingCount();
  }
}

/** Quick setup helper */
export function createSeller(opts: {
  sellerAddress: string;
  pricePerCall: number;
  wallet: WalletHandle;
}): Seller {
  return new Seller(opts);
}