/**
 * Payment Gateway — middleware for Express/Fastify/connect servers
 *
 * Intercepts requests, checks for USDC payment, returns 402 if unpaid.
 * After payment, verifies on-chain and serves the response.
 *
 * Usage:
 *   import { PaymentGateway } from "gheystack/payments/gateway";
 *   const gateway = new PaymentGateway({ sellerAddress: "0x...", pricePerCall: 0.01, chain: "base" });
 *   app.use("/api/premium", gateway.middleware());
 *   app.get("/api/premium/data", gateway.paid(), (req, res) => res.json({ data: "value" }));
 */

import { verifyPayment, type PaymentProof, type VerifiedPayment } from "./verify.js";

export interface GatewayConfig {
  sellerAddress: string;
  pricePerCall: number;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  /** Minimum block confirmations required */
  minConfirmations?: number;
  /** Optional: allow free tier (e.g. first 10 calls free per IP) */
  freeTier?: { callsPerIP: number; windowMinutes: number };
}

interface IPTracking {
  calls: number;
  windowStart: number;
}

export class PaymentGateway {
  private config: GatewayConfig;
  private ipTracking: Map<string, IPTracking> = new Map();
  private verifiedPayments: Map<string, VerifiedPayment> = new Map();

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /** Middleware: check payment, return 402 if needed */
  middleware() {
    return async (req: any, res: any, next: any) => {
      // Free tier check
      if (this.config.freeTier) {
        const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
        if (this.checkFreeTier(ip)) {
          next();
          return;
        }
      }

      const paymentHeader = req.headers["x-payment"];

      if (!paymentHeader) {
        res.status(402).json({
          error: "Payment Required",
          accepts: {
            amount: this.config.pricePerCall,
            currency: "USDC",
            recipient: this.config.sellerAddress,
            network: this.config.chain,
            memo: `${req.method} ${req.path}`,
          },
          instructions: "Pay USDC and retry with X-Payment header containing base64-encoded payment proof",
        });
        return;
      }

      // Decode payment proof
      try {
        const proof: PaymentProof = JSON.parse(Buffer.from(paymentHeader, "base64").toString());

        // Quick cache check
        if (this.verifiedPayments.has(proof.txHash)) {
          const cached = this.verifiedPayments.get(proof.txHash)!;
          if (cached.verified) {
            next();
            return;
          }
        }

        // Verify on-chain
        const verified = await verifyPayment({
          ...proof,
          recipient: this.config.sellerAddress,
          chain: this.config.chain,
        });

        if (!verified.verified) {
          res.status(402).json({ error: "Payment verification failed", details: verified });
          return;
        }

        // Check confirmations
        if (this.config.minConfirmations && verified.confirmations < this.config.minConfirmations) {
          res.status(402).json({
            error: "Insufficient confirmations",
            required: this.config.minConfirmations,
            current: verified.confirmations,
          });
          return;
        }

        // Cache verified payment
        this.verifiedPayments.set(proof.txHash, verified);

        // Attach payment info to request
        req.payment = verified;

        next();
      } catch (e) {
        res.status(402).json({ error: "Invalid payment proof", details: String(e) });
      }
    };
  }

  /** Helper: only proceed if payment was verified */
  paid() {
    return (req: any, res: any, next: any) => {
      if (req.payment?.verified) {
        next();
      } else {
        res.status(402).json({ error: "Payment required" });
      }
    };
  }

  /** Check if IP still has free tier calls available */
  private checkFreeTier(ip: string): boolean {
    if (!this.config.freeTier) return false;

    const tracking = this.ipTracking.get(ip);
    const now = Date.now();
    const windowMs = this.config.freeTier.windowMinutes * 60 * 1000;

    if (!tracking || now - tracking.windowStart > windowMs) {
      this.ipTracking.set(ip, { calls: 1, windowStart: now });
      return true;
    }

    if (tracking.calls < this.config.freeTier.callsPerIP) {
      tracking.calls++;
      return true;
    }

    return false;
  }

  /** Get gateway stats */
  stats() {
    return {
      pricePerCall: this.config.pricePerCall,
      chain: this.config.chain,
      verifiedPayments: this.verifiedPayments.size,
      uniqueIPs: this.ipTracking.size,
    };
  }
}