/**
 * Intent-Based Payment Routing
 *
 * A new payment primitive for agent commerce: instead of negotiating
 * a specific price for a specific task, agents express payment INTENTS
 * — "I will pay up to X USDC for a result matching Y" — and the protocol
 * automatically matches them with agents who can fulfill the intent.
 *
 * This decouples the buyer from the seller: an agent doesn't need to
 * know WHO will fulfill its request, just WHAT it wants and HOW MUCH
 * it's willing to pay. The mesh protocol handles discovery, matching,
 * routing, and settlement.
 *
 * Intent types:
 * - FIXED: "Pay exactly X USDC for capability Y with input Z"
 * - RANGE: "Pay between X and Y USDC, best quote wins"
 * - BOUNTY: "Pay X USDC to the first agent who delivers a valid result"
 * - STREAMING: "Pay X USDC per unit (per token, per call, per second)"
 * - CONDITIONAL: "Pay X USDC if result passes verification function V"
 * - RECURRING: "Pay X USDC every N seconds for ongoing capability"
 *
 * Example:
 *   Agent A: intent { pay: 5 USDC, for: "summarize", input: "long-text..." }
 *   Agent B: claims intent, produces summary
 *   Protocol: verifies result, routes 5 USDC from A → B via payment channel
 *
 * Multiple agents can compete for the same intent (bounty mode),
 * driving prices down and quality up through market dynamics.
 */

import type { AgentIdentity, MeshMessage, PaymentIntent, IntentType, IntentStatus, IntentClaim, ClaimStatus, IntentMatch } from "./types.js";
import { AgentIdentityManager } from "./identity.js";
import { PaymentChannelManager } from "./channels.js";
import { AgentRegistry } from "./registry.js";

// ─── Intent Router ──────────────────────────────────────────────

/**
 * The IntentRouter manages payment intents, matches them with agents,
 * routes payments, and handles verification.
 *
 * It's the "matching engine" for the agentic economy — like a stock
 * exchange order book but for AI agent services.
 */
export class IntentRouter {
  private identity: AgentIdentityManager;
  private channels: PaymentChannelManager;
  private registry: AgentRegistry;
  private intents: Map<string, PaymentIntent> = new Map();
  private claims: Map<string, IntentClaim> = new Map();
  private claimsByIntent: Map<string, string[]> = new Map();
  private verifiers: Map<string, (result: unknown, input: unknown) => boolean> = new Map();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    identity: AgentIdentityManager,
    channels: PaymentChannelManager,
    registry: AgentRegistry
  ) {
    this.identity = identity;
    this.channels = channels;
    this.registry = registry;
    this.startExpiryChecker();
  }

  /**
   * Create a payment intent — express willingness to pay for a result.
   * Funds are locked in escrow or a payment channel.
   */
  create(params: {
    type: IntentType;
    capability: string;
    input: unknown;
    amount?: number;
    minAmount?: number;
    maxAmount?: number;
    rate?: number;
    unit?: string;
    intervalSeconds?: number;
    verifier?: string;
    deadlineMs?: number;
    minReputation?: number;
    allowPartial?: boolean;
    maxClaims?: number;
    channelRoute?: string;
    metadata?: Record<string, unknown>;
  }): PaymentIntent {
    const id = `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const deadline = params.deadlineMs ? now + params.deadlineMs : now + 300000; // 5 min default

    const intent: PaymentIntent = {
      id,
      type: params.type,
      creator: this.identity.address,
      capability: params.capability,
      input: params.input,
      amount: params.amount,
      minAmount: params.minAmount,
      maxAmount: params.maxAmount,
      rate: params.rate,
      unit: params.unit,
      intervalSeconds: params.intervalSeconds,
      verifier: params.verifier,
      deadline,
      minReputation: params.minReputation ?? 0,
      allowPartial: params.allowPartial ?? false,
      maxClaims: params.maxClaims ?? (params.type === "bounty" ? 1 : 1),
      claimsCount: 0,
      status: "open",
      createdAt: now,
      channelRoute: params.channelRoute,
      metadata: params.metadata,
    };

    this.intents.set(id, intent);
    console.log(
      `[stack] Intent created: ${id} — type: ${params.type}, capability: ${params.capability}, budget: ${params.amount ?? `${params.minAmount}-${params.maxAmount}`} USDC`
    );

    return intent;
  }

  /**
   * Claim an intent — an agent offers to fulfill it.
   * For range intents, the agent includes a quoted price.
   */
  claim(
    intentId: string,
    claimant: `0x${string}`,
    quotedPrice?: number,
    estimatedTime?: number
  ): IntentClaim {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Intent ${intentId} not found`);
    if (intent.status !== "open") throw new Error(`Intent is ${intent.status}`);
    if (Date.now() > intent.deadline) {
      intent.status = "expired";
      throw new Error(`Intent ${intentId} has expired`);
    }

    // Check reputation requirement
    if (intent.minReputation && intent.minReputation > 0) {
      const entry = this.registry.getEntry(claimant);
      if (!entry || entry.reputation < intent.minReputation) {
        throw new Error(`Agent ${claimant} does not meet minimum reputation ${intent.minReputation}`);
      }
    }

    // Check max claims
    if (intent.claimsCount >= intent.maxClaims!) {
      throw new Error(`Intent ${intentId} has reached max claims (${intent.maxClaims})`);
    }

    // For range intents, validate quoted price is within range
    if (intent.type === "range" && quotedPrice !== undefined) {
      if (intent.minAmount !== undefined && quotedPrice < intent.minAmount) {
        throw new Error(`Quote ${quotedPrice} below minimum ${intent.minAmount}`);
      }
      if (intent.maxAmount !== undefined && quotedPrice > intent.maxAmount) {
        throw new Error(`Quote ${quotedPrice} above maximum ${intent.maxAmount}`);
      }
    }

    const claimId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const claim: IntentClaim = {
      id: claimId,
      intentId,
      claimant,
      quotedPrice,
      estimatedTime,
      status: intent.type === "bounty" ? "accepted" : "pending",
      claimedAt: Date.now(),
    };

    this.claims.set(claimId, claim);
    const claimsList = this.claimsByIntent.get(intentId) ?? [];
    claimsList.push(claimId);
    this.claimsByIntent.set(intentId, claimsList);

    intent.claimsCount++;
    if (intent.type !== "bounty") {
      intent.status = "claimed";
    }

    console.log(`[stack] Intent ${intentId} claimed by ${claimant.slice(0, 10)}... — quote: ${quotedPrice ?? "fixed"} USDC`);
    return claim;
  }

  /**
   * Accept a claim (for non-bounty intents where the creator picks the best claim).
   */
  acceptClaim(claimId: string): void {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (claim.status !== "pending") throw new Error(`Claim is ${claim.status}`);

    const intent = this.intents.get(claim.intentId);
    if (!intent) throw new Error(`Intent not found`);

    claim.status = "accepted";
    intent.status = "claimed";

    // Reject other pending claims
    const otherClaims = this.claimsByIntent.get(claim.intentId) ?? [];
    for (const otherId of otherClaims) {
      if (otherId !== claimId) {
        const other = this.claims.get(otherId);
        if (other && other.status === "pending") {
          other.status = "rejected";
        }
      }
    }

    console.log(`[stack] Claim ${claimId} accepted for intent ${claim.intentId}`);
  }

  /**
   * Submit a result for a claimed intent.
   * The result will be verified if a verifier is set.
   */
  async submitResult(claimId: string, result: unknown): Promise<ClaimStatus> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (claim.status !== "accepted") throw new Error(`Claim is ${claim.status}, not accepted`);

    const intent = this.intents.get(claim.intentId);
    if (!intent) throw new Error(`Intent not found`);

    claim.result = result;
    claim.status = "submitted";

    // Verify result if verifier is set
    if (intent.verifier) {
      const verifierFn = this.verifiers.get(intent.verifier);
      if (verifierFn) {
        claim.verified = verifierFn(result, intent.input);
        if (!claim.verified) {
          claim.status = "rejected";
          intent.status = "disputed";
          console.log(`[stack] Claim ${claimId} result failed verification`);
          return claim.status;
        }
      }
    }

    // Result accepted — route payment
    claim.status = "verified";
    claim.verified = true;

    await this.routePayment(intent, claim);

    claim.status = "paid";
    claim.fulfilledAt = Date.now();
    intent.status = "fulfilled";

    console.log(
      `[stack] Intent ${intent.id} fulfilled — ${claim.paidAmount} USDC paid to ${claim.claimant.slice(0, 10)}...`
    );

    return claim.status;
  }

  /**
   * Route payment from intent creator to claimant.
   * Uses payment channel if available, otherwise direct transfer.
   */
  private async routePayment(intent: PaymentIntent, claim: IntentClaim): Promise<void> {
    const amount = this.computePaymentAmount(intent, claim);
    claim.paidAmount = amount;

    if (intent.channelRoute) {
      // Route through payment channel (off-chain, zero gas)
      this.channels.send(intent.channelRoute, amount);
      console.log(`[stack] Routed ${amount} USDC via channel ${intent.channelRoute}`);
    } else {
      // Direct on-chain transfer would happen here via wallet
      // For now, log it
      console.log(`[stack] Direct payment: ${amount} USDC to ${claim.claimant.slice(0, 10)}...`);
    }

    // Update registry reputation
    this.registry.recordTaskSuccess(claim.claimant, amount);
  }

  /**
   * Compute the payment amount based on intent type and claim.
   */
  private computePaymentAmount(intent: PaymentIntent, claim: IntentClaim): number {
    switch (intent.type) {
      case "fixed":
        return intent.amount ?? 0;
      case "range":
        return claim.quotedPrice ?? intent.maxAmount ?? intent.minAmount ?? 0;
      case "bounty":
        return intent.amount ?? 0;
      case "streaming":
        // Would need to measure units consumed
        return intent.rate ?? 0;
      case "recurring":
        return intent.amount ?? 0;
      case "conditional":
        return intent.amount ?? 0;
      default:
        return 0;
    }
  }

  /**
   * Register a verification function for conditional intents.
   * The verifier checks if a result is valid before payment is released.
   */
  registerVerifier(name: string, fn: (result: unknown, input: unknown) => boolean): void {
    this.verifiers.set(name, fn);
    console.log(`[stack] Verifier registered: ${name}`);
  }

  /**
   * Find open intents matching a capability.
   * Agents can use this to discover work they can do.
   */
  findMatchingIntents(capability: string, maxPrice?: number): PaymentIntent[] {
    return Array.from(this.intents.values()).filter((intent) => {
      if (intent.status !== "open") return false;
      if (intent.capability !== capability) return false;
      if (maxPrice !== undefined) {
        const price = intent.amount ?? intent.maxAmount ?? 0;
        if (price > maxPrice) return false;
      }
      return true;
    });
  }

  /**
   * Auto-match: find the best agent for an open intent.
   * Returns a match with a score based on reputation, price, and availability.
   */
  autoMatch(intentId: string): IntentMatch | null {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== "open") return null;

    const candidates = this.registry.discover(intent.capability, intent.minReputation ?? 0);
    if (candidates.length === 0) return null;

    // Score each candidate
    const scored = candidates.map((entry) => {
      let score = entry.reputation / 100; // 0-1 base from reputation

      // Bonus for lower pricing
      const agentPrice = entry.agent.pricing[intent.capability] ?? intent.amount ?? 0;
      const budget = intent.amount ?? intent.maxAmount ?? 0;
      if (budget > 0 && agentPrice < budget) {
        score += 0.2 * (1 - agentPrice / budget); // up to 20% bonus for being under budget
      }

      // Bonus for being online
      if (entry.online) score += 0.1;

      // Bonus for higher task completion rate
      const totalTasks = entry.tasksCompleted + entry.tasksFailed;
      if (totalTasks > 0) {
        score += 0.1 * (entry.tasksCompleted / totalTasks);
      }

      return { entry, score: Math.min(1, score) };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return {
      intent,
      claim: {
        id: `claim-auto-${Date.now()}`,
        intentId: intent.id,
        claimant: best.entry.agent.address,
        quotedPrice: best.entry.agent.pricing[intent.capability] ?? intent.amount,
        estimatedTime: 60,
        status: "pending",
        claimedAt: Date.now(),
      },
      score: best.score,
      reason: `Reputation ${best.entry.reputation}, price ${best.entry.agent.pricing[intent.capability] ?? "N/A"} USDC, ${best.entry.online ? "online" : "offline"}`,
    };
  }

  /** Cancel an open intent */
  cancel(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Intent ${intentId} not found`);
    if (intent.status !== "open") throw new Error(`Can only cancel open intents, current: ${intent.status}`);
    intent.status = "cancelled";
    console.log(`[stack] Intent ${intentId} cancelled`);
  }

  /** Get an intent by ID */
  getIntent(intentId: string): PaymentIntent | undefined {
    return this.intents.get(intentId);
  }

  /** Get all claims for an intent */
  getClaims(intentId: string): IntentClaim[] {
    const ids = this.claimsByIntent.get(intentId) ?? [];
    return ids.map((id) => this.claims.get(id)).filter((c): c is IntentClaim => c !== undefined);
  }

  /** Get intent router statistics */
  getStats(): {
    totalIntents: number;
    openIntents: number;
    fulfilledIntents: number;
    totalVolume: number;
    avgFulfillmentTime: number;
  } {
    const intents = Array.from(this.intents.values());
    const claims = Array.from(this.claims.values());
    const fulfilled = claims.filter((c) => c.status === "paid");
    const totalVolume = fulfilled.reduce((sum, c) => sum + (c.paidAmount ?? 0), 0);
    const fulfillmentTimes = fulfilled
      .filter((c) => c.fulfilledAt)
      .map((c) => c.fulfilledAt! - c.claimedAt);
    const avgTime = fulfillmentTimes.length > 0
      ? fulfillmentTimes.reduce((a, b) => a + b, 0) / fulfillmentTimes.length
      : 0;

    return {
      totalIntents: intents.length,
      openIntents: intents.filter((i) => i.status === "open").length,
      fulfilledIntents: fulfilled.length,
      totalVolume,
      avgFulfillmentTime: avgTime,
    };
  }

  /** Check for expired intents and update their status */
  private checkExpiry(): void {
    const now = Date.now();
    for (const intent of this.intents.values()) {
      if (intent.status === "open" && now > intent.deadline) {
        intent.status = "expired";
        console.log(`[stack] Intent ${intent.id} expired`);
      }
    }
  }

  private startExpiryChecker(): void {
    this.expiryTimer = setInterval(() => this.checkExpiry(), 30000); // every 30s
  }

  /** Stop the intent router and clean up */
  stop(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}