/**
 * Mesh Protocol — P2P Agent Communication & Negotiation
 *
 * The protocol layer ties everything together:
 * - Discovery: agents find each other via the registry
 * - Negotiation: RFQ → Quote → Accept → Execute → Settle
 * - Payment routing: choose the best payment method
 * - Message transport: HTTP-based with signed messages
 *
 * An agent running the mesh protocol can:
 * 1. Discover other agents with needed capabilities
 * 2. Request quotes for tasks
 * 3. Accept/reject quotes
 * 4. Execute tasks and deliver results
 * 5. Get paid via the optimal payment method
 *
 * Transport: HTTP POST to agent endpoints with signed JSON payloads.
 * Each message is signed by the sender and verified by the receiver.
 *
 * This is the "TCP/IP of agent commerce" — a standard protocol that
 * any agent framework can implement to participate in the economy.
 */

import type { WalletHandle } from "../core/types.js";
import type {
  AgentIdentity,
  SignedMessage,
  MeshMessage,
  RFQMessage,
  QuoteMessage,
  Task,
  TaskBid,
  RegistryEntry,
  PaymentChannel,
} from "./types.js";
import { AgentIdentityManager } from "./identity.js";
import { AgentRegistry } from "./registry.js";
import { PaymentChannelManager } from "./channels.js";
import { EscrowService } from "./escrow.js";
import { TaskMarket } from "./task-market.js";

export interface MeshProtocolConfig {
  /** Default timeout for negotiation rounds (ms) */
  negotiationTimeout?: number;
  /** Max retries for failed messages */
  maxRetries?: number;
  /** Whether to auto-open channels for frequent peers */
  autoChannel?: boolean;
  /** Channel deposit threshold (open channel if total spend exceeds this) */
  channelThreshold?: number;
}

export class MeshProtocol {
  private identity: AgentIdentityManager;
  private wallet: WalletHandle;
  private registry: AgentRegistry;
  private channels: PaymentChannelManager;
  private escrow: EscrowService;
  private market: TaskMarket;
  private config: MeshProtocolConfig;
  private pendingQuotes: Map<string, QuoteMessage> = new Map();
  private pendingTasks: Map<string, Task> = new Map();
  private spendingTracker: Map<string, number> = new Map(); // peer → total spent

  constructor(
    identity: AgentIdentityManager,
    wallet: WalletHandle,
    registry: AgentRegistry,
    channels: PaymentChannelManager,
    escrow: EscrowService,
    market: TaskMarket,
    config?: MeshProtocolConfig
  ) {
    this.identity = identity;
    this.wallet = wallet;
    this.registry = registry;
    this.channels = channels;
    this.escrow = escrow;
    this.market = market;
    this.config = {
      negotiationTimeout: config?.negotiationTimeout ?? 30000,
      maxRetries: config?.maxRetries ?? 3,
      autoChannel: config?.autoChannel ?? true,
      channelThreshold: config?.channelThreshold ?? 5, // 5 USDC
    };
  }

  // ─── Discovery ───────────────────────────────────────────────

  /**
   * Discover agents that provide a specific capability.
   * Returns sorted by reputation (best first).
   */
  discoverAgents(capability: string, minReputation: number = 0): RegistryEntry[] {
    return this.registry.discover(capability, minReputation);
  }

  /**
   * Announce this agent to the mesh.
   * In production, this broadcasts a discovery message to known peers.
   */
  async announce(): Promise<void> {
    const entry = this.registry.listAgents().find(
      (e) => e.agent.address === this.identity.address
    );
    if (!entry) {
      // Register first
      await this.registry.register();
    }
    console.log(`[mesh] Announcing ${this.identity.getIdentity().name} to the mesh`);
  }

  // ─── Negotiation: RFQ Flow ───────────────────────────────────

  /**
   * Request a quote from a specific agent.
   * Sends an RFQ (Request For Quote) message to the agent's endpoint.
   *
   * This is the first step in the negotiation protocol.
   */
  async requestQuote(
    agent: AgentIdentity,
    capability: string,
    input: unknown,
    maxPrice?: number
  ): Promise<QuoteMessage | null> {
    const taskId = `rfq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const rfq: RFQMessage = {
      type: "rfq",
      taskId,
      capability,
      input,
      maxPrice,
      deadline: Date.now() + this.config.negotiationTimeout!,
    };

    // Sign the message
    const signed = await this.identity.signMessage(rfq);

    // Send to agent's endpoint
    try {
      const response = await this.sendMessage(agent.endpoint, signed);

      if (response && response.type === "quote") {
        const quote = response as QuoteMessage;
        this.pendingQuotes.set(taskId, quote);
        console.log(
          `[mesh] Quote received: ${quote.price} USDC for "${capability}" (task: ${taskId})`
        );
        return quote;
      }
    } catch (e) {
      console.warn(`[mesh] Failed to get quote from ${agent.name}: ${e}`);
    }

    return null;
  }

  /**
   * Request quotes from multiple agents and return the best one.
   * This enables competitive bidding — agents compete on price.
   */
  async requestBestQuote(
    capability: string,
    input: unknown,
    maxPrice?: number,
    minReputation: number = 20
  ): Promise<{ agent: AgentIdentity; quote: QuoteMessage } | null> {
    const agents = this.discoverAgents(capability, minReputation);

    if (agents.length === 0) {
      console.log(`[mesh] No agents found for capability: ${capability}`);
      return null;
    }

    // Request quotes from top 5 agents in parallel
    const topAgents = agents.slice(0, 5);
    const quotes = await Promise.allSettled(
      topAgents.map(async (entry) => {
        const quote = await this.requestQuote(
          entry.agent,
          capability,
          input,
          maxPrice
        );
        return quote ? { agent: entry.agent, quote } : null;
      })
    );

    // Find the best (lowest price that meets constraints)
    let best: { agent: AgentIdentity; quote: QuoteMessage } | null = null;
    for (const result of quotes) {
      if (result.status === "fulfilled" && result.value) {
        if (!best || result.value.quote.price < best.quote.price) {
          if (!maxPrice || result.value.quote.price <= maxPrice) {
            best = result.value;
          }
        }
      }
    }

    if (best) {
      console.log(
        `[mesh] Best quote: ${best.quote.price} USDC from ${best.agent.name}`
      );
    }

    return best;
  }

  /**
   * Accept a quote — initiates the task.
   * Creates a task in the market and locks the escrow.
   */
  async acceptQuote(
    agent: AgentIdentity,
    quote: QuoteMessage,
    capability: string,
    input: unknown,
    title: string,
    description: string
  ): Promise<Task> {
    const task = await this.market.postTask({
      title,
      description,
      capability,
      input,
      bounty: quote.price,
      paymentMethod: "escrow",
    });

    // Send acceptance to the agent
    const acceptMsg: MeshMessage = {
      type: "accept",
      taskId: task.id,
      quoteId: quote.taskId,
      paymentMethod: "escrow",
    };

    const signed = await this.identity.signMessage(acceptMsg);
    await this.sendMessage(agent.endpoint, signed);

    console.log(`[mesh] Accepted quote from ${agent.name} — task: ${task.id}`);
    return task;
  }

  /**
   * Full negotiation flow: discover → RFQ → accept → wait for result.
   * This is the one-shot "hire an agent" method.
   */
  async hireAgent(
    capability: string,
    input: unknown,
    title: string,
    description: string,
    maxPrice?: number
  ): Promise<Task | null> {
    // 1. Find the best agent
    const best = await this.requestBestQuote(capability, input, maxPrice);
    if (!best) return null;

    // 2. Accept their quote
    const task = await this.acceptQuote(
      best.agent,
      best.quote,
      capability,
      input,
      title,
      description
    );

    return task;
  }

  // ─── Message Transport ────────────────────────────────────────

  /**
   * Send a signed message to an agent endpoint.
   * Uses HTTP POST with the signed message as the body.
   *
   * In production, this would use a proper transport (HTTP, WebSocket, libp2p).
   * Here we use fetch() to POST to the agent's endpoint.
   */
  private async sendMessage(
    endpoint: string,
    signed: SignedMessage
  ): Promise<MeshMessage | null> {
    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        });

        if (res.ok) {
          return (await res.json()) as MeshMessage;
        }

        if (res.status === 404) {
          console.warn(`[mesh] Agent endpoint not found: ${endpoint}`);
          return null;
        }

        // Retry on 5xx
        if (res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }

        return null;
      } catch (e) {
        if (attempt === this.config.maxRetries! - 1) {
          console.warn(`[mesh] Failed to send message to ${endpoint}: ${e}`);
          return null;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    return null;
  }

  /**
   * Receive and process an incoming mesh message.
   * This is the handler for messages received at this agent's endpoint.
   *
   * Verifies the signature and routes to the appropriate handler.
   */
  async receiveMessage(signed: SignedMessage): Promise<MeshMessage | null> {
    // Verify signature
    const valid = await AgentIdentityManager.verifySignedMessage(signed);
    if (!valid) {
      console.warn(`[mesh] Invalid signature from ${signed.signer}`);
      return null;
    }

    const msg = signed.payload;

    switch (msg.type) {
      case "rfq":
        return this.handleRFQ(msg as RFQMessage, signed.signer);

      case "accept":
        return this.handleAccept(msg as any, signed.signer);

      case "task-result":
        return this.handleTaskResult(msg as any, signed.signer);

      case "discovery":
        return this.handleDiscovery(msg as any, signed.signer);

      case "channel-update":
        return this.handleChannelUpdate(msg as any, signed.signer);

      default:
        console.log(`[mesh] Received ${msg.type} from ${signed.signer}`);
        return null;
    }
  }

  // ─── Message Handlers ────────────────────────────────────────

  /**
   * Handle an RFQ — someone wants us to quote a price.
   * We check if we have the capability and respond with a price.
   */
  private async handleRFQ(rfq: RFQMessage, signer: `0x${string}`): Promise<MeshMessage | null> {
    const myIdentity = this.identity.getIdentity();

    if (!myIdentity.capabilities.includes(rfq.capability)) {
      return {
        type: "reject",
        taskId: rfq.taskId,
        reason: "capability_not_supported",
      };
    }

    // Get our price for this capability
    const price = myIdentity.pricing[rfq.capability] ?? 0.01;

    if (rfq.maxPrice && price > rfq.maxPrice) {
      return {
        type: "reject",
        taskId: rfq.taskId,
        reason: "price_too_low",
      };
    }

    return {
      type: "quote",
      taskId: rfq.taskId,
      price,
      currency: "USDC",
      estimatedTime: 30, // 30 seconds default
    };
  }

  /**
   * Handle an acceptance — someone accepted our quote.
   * We need to bid on the task in the task market.
   */
  private async handleAccept(
    msg: { taskId: string; quoteId: string; paymentMethod: string },
    signer: `0x${string}`
  ): Promise<MeshMessage | null> {
    // In a full implementation, we'd bid on the task
    // For now, acknowledge
    console.log(`[mesh] Task ${msg.taskId} accepted by ${signer}`);
    return null;
  }

  /**
   * Handle a task result — the worker delivered the result.
   */
  private async handleTaskResult(
    msg: { taskId: string; result: unknown; proof?: string },
    signer: `0x${string}`
  ): Promise<MeshMessage | null> {
    console.log(`[mesh] Task result received for ${msg.taskId} from ${signer}`);
    return null;
  }

  /**
   * Handle a discovery message — register the agent.
   */
  private async handleDiscovery(
    msg: { agent: AgentIdentity },
    signer: `0x${string}`
  ): Promise<MeshMessage | null> {
    // Verify the signer matches the agent
    if (signer.toLowerCase() !== msg.agent.address.toLowerCase()) {
      console.warn(`[mesh] Discovery signer mismatch`);
      return null;
    }

    this.registry.receiveDiscovery(msg.agent);
    return null;
  }

  /**
   * Handle a payment channel update.
   */
  private async handleChannelUpdate(
    msg: { channelId: string; sequence: number; senderBalance: number; recipientBalance: number; signature: `0x${string}` },
    signer: `0x${string}`
  ): Promise<MeshMessage | null> {
    // Verify and store the channel update
    const channel = this.channels.getChannel(msg.channelId);
    if (!channel) return null;

    await this.channels.receiveUpdate(
      msg.channelId,
      {
        channelId: msg.channelId,
        sequence: msg.sequence,
        balanceA: msg.senderBalance,
        balanceB: msg.recipientBalance,
      },
      msg.signature,
      signer
    );

    return null;
  }

  // ─── Payment Routing ─────────────────────────────────────────

  /**
   * Choose the optimal payment method for a transaction.
   *
   * - Direct: for one-time payments > threshold
   * - Channel: for frequent micropayments (instant, no gas)
   * - Escrow: for task bounties (trustless, time-locked)
   */
  choosePaymentMethod(
    recipient: `0x${string}`,
    amount: number,
    isTaskBounty: boolean = false
  ): "direct" | "channel" | "escrow" {
    if (isTaskBounty) return "escrow";

    // Check if we have an open channel with this peer
    const channel = this.channels
      .listChannels()
      .find(
        (c) =>
          c.status === "open" &&
          (c.partyA === recipient || c.partyB === recipient)
      );

    if (channel && amount < channel.balanceA) {
      return "channel";
    }

    // Track spending — if we've paid this peer a lot, open a channel
    const totalSpent = this.spendingTracker.get(recipient) ?? 0;
    if (this.config.autoChannel && totalSpent + amount > this.config.channelThreshold!) {
      console.log(`[mesh] Suggesting channel for ${recipient} (total spend: ${totalSpent + amount})`);
      return "channel";
    }

    return "direct";
  }

  /**
   * Pay an agent using the optimal method.
   * Automatically routes to direct transfer, payment channel, or escrow.
   */
  async payAgent(
    recipient: `0x${string}`,
    amount: number,
    isTaskBounty: boolean = false,
    memo?: string
  ): Promise<string> {
    const method = this.choosePaymentMethod(recipient, amount, isTaskBounty);

    // Track spending
    this.spendingTracker.set(recipient, (this.spendingTracker.get(recipient) ?? 0) + amount);

    switch (method) {
      case "direct":
        return this.wallet.send(recipient, amount);

      case "channel": {
        // Find the channel
        const channel = this.channels
          .listChannels()
          .find(
            (c) =>
              c.status === "open" &&
              (c.partyA === recipient || c.partyB === recipient)
          );

        if (channel) {
          const state = await this.channels.send(channel.channelId, amount);
          return `channel:${state.sequence}`;
        }

        // No channel — open one and pay
        await this.channels.openChannel(recipient, this.config.channelThreshold!);
        const newChannel = this.channels
          .listChannels()
          .find(
            (c) =>
              c.status === "open" &&
              (c.partyA === recipient || c.partyB === recipient)
          );
        if (newChannel) {
          const state = await this.channels.send(newChannel.channelId, amount);
          return `channel:${state.sequence}`;
        }
        return this.wallet.send(recipient, amount);
      }

      case "escrow":
        // Escrow is handled by the task market
        return `escrow:${Date.now()}`;
    }
  }

  // ─── Convenience: Full Agent Lifecycle ───────────────────────

  /**
   * Initialize a complete mesh node.
   * Registers the agent, starts discovery, and prepares for operation.
   */
  async init(): Promise<void> {
    await this.registry.register();
    console.log(`[mesh] Node initialized: ${this.identity.getIdentity().name}`);
    console.log(`[mesh] DID: ${this.identity.getIdentity().did}`);
    console.log(`[mesh] Capabilities: ${this.identity.getIdentity().capabilities.join(", ")}`);
  }

  /**
   * Get full mesh status.
   */
  async status(): Promise<{
    identity: AgentIdentity;
    registry: ReturnType<AgentRegistry["stats"]>;
    channels: {
      open: number;
      totalCapacity: number;
    };
    market: ReturnType<TaskMarket["stats"]>;
    escrow: {
      locked: number;
      active: number;
    };
  }> {
    return {
      identity: this.identity.getIdentity(),
      registry: this.registry.stats(),
      channels: {
        open: this.channels.listChannels().filter((c) => c.status === "open").length,
        totalCapacity: this.channels.totalCapacity(),
      },
      market: this.market.stats(),
      escrow: {
        locked: this.escrow.totalLocked(),
        active: this.escrow.list("locked").length,
      },
    };
  }
}