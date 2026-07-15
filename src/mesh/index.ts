/**
 * Mesh Node — The complete agent commerce node.
 *
 * One class to rule them all. A MeshNode is a full participant in the
 * agent economy: it has an identity, a wallet, a registry entry,
 * payment channels, an escrow service, and a task market connection.
 *
 * Usage:
 *   import { MeshNode } from "stack/mesh";
 *
 *   const node = await MeshNode.create({
 *     name: "WeatherAgent",
 *     endpoint: "https://my-agent.example.com/mesh",
 *     privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
 *     chain: "base",
 *     capabilities: ["weather", "forecast"],
 *     pricing: { weather: 0.01, forecast: 0.05 },
 *     stake: 10, // USDC staked in registry
 *   });
 *
 *   // Discover agents
 *   const agents = node.discover("data-analysis");
 *
 *   // Hire an agent
 *   const task = await node.hireAgent(
 *     "data-analysis",
 *     { dataset: "sales.csv" },
 *     "Analyze sales data",
 *     "Statistical analysis of Q4 sales"
 *   );
 *
 *   // Receive mesh messages (for HTTP endpoint handler)
 *   const reply = await node.receiveMessage(signedMsg);
 */

import type { WalletHandle } from "../core/types.js";
import { createWallet } from "../payments/wallet.js";
import { AgentIdentityManager } from "./identity.js";
import { AgentRegistry } from "./registry.js";
import { PaymentChannelManager } from "./channels.js";
import { EscrowService } from "./escrow.js";
import { TaskMarket } from "./task-market.js";
import { MeshProtocol } from "./protocol.js";
import { SupplyChainEngine } from "./supply-chain.js";
import { IntentRouter } from "./intents.js";
import type {
  AgentIdentity,
  RegistryEntry,
  Task,
  TaskBid,
  SignedMessage,
  MeshMessage,
  PaymentChannel,
  SupplyChain,
  DecompositionPlan,
  PaymentIntent,
} from "./types.js";

export interface MeshNodeConfig {
  // Identity
  name: string;
  endpoint: string;
  capabilities: string[];
  pricing: Record<string, number>;
  privateKey?: `0x${string}`;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  rpcUrl?: string;

  // Economics
  stake?: number; // USDC to stake in registry
  challengePeriod?: number; // blocks for channel disputes
  channelThreshold?: number; // USDC before auto-opening channels

  // Task market
  autoAssignDelay?: number; // seconds
  autoAssignBy?: "price" | "reputation" | "speed";
  defaultTaskDuration?: number; // seconds
}

export class MeshNode {
  identity: AgentIdentityManager;
  wallet: WalletHandle;
  registry: AgentRegistry;
  channels: PaymentChannelManager;
  escrow: EscrowService;
  market: TaskMarket;
  protocol: MeshProtocol;
  supplyChain: SupplyChainEngine;
  intents: IntentRouter;

  private constructor(
    identity: AgentIdentityManager,
    wallet: WalletHandle,
    registry: AgentRegistry,
    channels: PaymentChannelManager,
    escrow: EscrowService,
    market: TaskMarket,
    protocol: MeshProtocol,
    supplyChain: SupplyChainEngine,
    intents: IntentRouter
  ) {
    this.identity = identity;
    this.wallet = wallet;
    this.registry = registry;
    this.channels = channels;
    this.escrow = escrow;
    this.market = market;
    this.protocol = protocol;
    this.supplyChain = supplyChain;
    this.intents = intents;
  }

  /**
   * Create and initialize a full mesh node.
   * Generates identity, connects wallet, registers in the mesh.
   */
  static async create(config: MeshNodeConfig): Promise<MeshNode> {
    // 1. Create identity
    const identity = new AgentIdentityManager({
      privateKey: config.privateKey,
      name: config.name,
      endpoint: config.endpoint,
      capabilities: config.capabilities,
      pricing: config.pricing,
      chain: config.chain,
      rpcUrl: config.rpcUrl,
    });

    // 2. Create wallet
    const wallet = await createWallet({
      privateKey: identity.privateKey,
      chain: config.chain,
      rpcUrl: config.rpcUrl,
    });

    // 3. Create registry
    const registry = new AgentRegistry(identity, wallet, {
      minStake: 1,
    });

    // 4. Create payment channels
    const channels = new PaymentChannelManager(identity, wallet, {
      challengePeriod: config.challengePeriod,
    });

    // 5. Create escrow service
    const escrow = new EscrowService(identity, wallet);

    // 6. Create task market
    const market = new TaskMarket(identity, wallet, registry, escrow, {
      autoAssignDelay: config.autoAssignDelay,
      autoAssignBy: config.autoAssignBy,
      defaultDuration: config.defaultTaskDuration,
    });

    // 7. Create protocol layer
    const protocol = new MeshProtocol(identity, wallet, registry, channels, escrow, market, {
      channelThreshold: config.channelThreshold,
    });

    // 8. Create supply chain engine
    const supplyChain = new SupplyChainEngine(identity, protocol, market, escrow, registry);

    // 9. Create intent router
    const intents = new IntentRouter(identity, channels, registry);

    const node = new MeshNode(identity, wallet, registry, channels, escrow, market, protocol, supplyChain, intents);

    // 8. Register in the mesh
    await registry.register(config.stake);

    return node;
  }

  // ─── Discovery ───────────────────────────────────────────────

  /** Discover agents by capability */
  discover(capability: string, minReputation = 0): RegistryEntry[] {
    return this.registry.discover(capability, minReputation);
  }

  /** List all known agents */
  listAgents(): RegistryEntry[] {
    return this.registry.listAgents();
  }

  // ─── Hiring (as poster) ───────────────────────────────────────

  /** Post a task to the market */
  async postTask(params: {
    title: string;
    description: string;
    capability: string;
    input: unknown;
    bounty: number;
    durationSeconds?: number;
    arbiter?: `0x${string}`;
  }): Promise<Task> {
    return this.market.postTask(params);
  }

  /** Hire an agent end-to-end: discover → RFQ → accept */
  async hireAgent(
    capability: string,
    input: unknown,
    title: string,
    description: string,
    maxPrice?: number
  ): Promise<Task | null> {
    return this.protocol.hireAgent(capability, input, title, description, maxPrice);
  }

  /** Accept a bid on your task */
  async assignTask(taskId: string, bidId: string): Promise<Task> {
    return this.market.assignTask(taskId, bidId);
  }

  /** Accept a submitted result and release payment */
  async acceptResult(taskId: string): Promise<string> {
    return this.market.acceptResult(taskId);
  }

  /** Reject a submitted result */
  async rejectResult(taskId: string, reason: string): Promise<Task> {
    return this.market.rejectResult(taskId, reason);
  }

  // ─── Working (as worker) ─────────────────────────────────────

  /** Bid on an open task */
  async bid(taskId: string, price: number, estimatedTime: number, message?: string): Promise<TaskBid> {
    return this.market.bid(taskId, price, estimatedTime, message);
  }

  /** Submit result for an assigned task */
  async submitResult(taskId: string, result: unknown, proof?: string): Promise<Task> {
    return this.market.submitResult(taskId, result, proof);
  }

  /** Browse open tasks */
  openTasks(capability?: string): Task[] {
    return this.market.listTasks("open", capability);
  }

  /** Search open tasks */
  searchTasks(query: string): Task[] {
    return this.market.searchOpenTasks(query);
  }

  // ─── Payment Channels ────────────────────────────────────────

  /** Open a payment channel with another agent */
  async openChannel(peer: `0x${string}`, deposit?: number): Promise<PaymentChannel> {
    return this.channels.openChannel(peer, deposit);
  }

  /** Pay via channel (instant, off-chain) */
  async payViaChannel(channelId: string, amount: number) {
    return this.channels.send(channelId, amount);
  }

  /** List channels */
  listChannels(): PaymentChannel[] {
    return this.channels.listChannels();
  }

  // ─── Messaging ───────────────────────────────────────────────

  /** Process incoming mesh message (for HTTP handler) */
  async receiveMessage(signed: SignedMessage): Promise<MeshMessage | null> {
    return this.protocol.receiveMessage(signed);
  }

  /** Sign an outgoing message */
  async signMessage(msg: MeshMessage): Promise<SignedMessage> {
    return this.identity.signMessage(msg);
  }

  // ─── Status ──────────────────────────────────────────────────

  /** Get full node status */
  async status() {
    return this.protocol.status();
  }

  // ─── Supply Chain ───────────────────────────────────────────

  /**
   * Execute a complex request by decomposing it into a supply chain.
   * The chain automatically hires sub-agents, orchestrates execution,
   * aggregates results, and settles payments.
   */
  async executeSupplyChain(
    request: string,
    plan: DecompositionPlan,
    budget: number
  ): Promise<SupplyChain> {
    return this.supplyChain.execute(request, plan, budget);
  }

  /** Get active supply chains */
  getActiveChains(): SupplyChain[] {
    return this.supplyChain.getActiveChains();
  }

  /** Get a specific supply chain by ID */
  getSupplyChain(chainId: string): SupplyChain | undefined {
    return this.supplyChain.getChain(chainId);
  }

  /** Abort a supply chain */
  abortSupplyChain(chainId: string): void {
    this.supplyChain.abortChain(chainId);
  }

  /** Supply chain statistics */
  supplyChainStats() {
    return this.supplyChain.getStats();
  }

  // ─── Intent Router ───────────────────────────────────────────

  /**
   * Create a payment intent — express willingness to pay for a result.
   * The mesh auto-matches intents with capable agents.
   */
  createIntent(params: {
    type: "fixed" | "range" | "bounty" | "streaming" | "conditional" | "recurring";
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
    maxClaims?: number;
  }): PaymentIntent {
    return this.intents.create(params);
  }

  /** Find open intents matching a capability (for workers) */
  findIntents(capability: string, maxPrice?: number): PaymentIntent[] {
    return this.intents.findMatchingIntents(capability, maxPrice);
  }

  /** Claim an intent (as a worker) */
  claimIntent(intentId: string, quotedPrice?: number, estimatedTime?: number) {
    return this.intents.claim(intentId, this.identity.address, quotedPrice, estimatedTime);
  }

  /** Submit result for a claimed intent */
  async fulfillIntent(claimId: string, result: unknown) {
    return this.intents.submitResult(claimId, result);
  }

  /** Register a verification function for conditional intents */
  registerVerifier(name: string, fn: (result: unknown, input: unknown) => boolean): void {
    this.intents.registerVerifier(name, fn);
  }

  /** Auto-match the best agent for an open intent */
  autoMatchIntent(intentId: string) {
    return this.intents.autoMatch(intentId);
  }

  /** Intent router statistics */
  intentStats() {
    return this.intents.getStats();
  }

  /** Get this agent's identity */
  getIdentity(): AgentIdentity {
    return this.identity.getIdentity();
  }

  /** Get wallet balance */
  async getBalance(): Promise<number> {
    return this.wallet.balance();
  }

  /** Send USDC directly */
  async pay(to: string, amount: number): Promise<string> {
    return this.wallet.send(to, amount);
  }

  /** Get registry entry for any agent */
  getAgent(address: `0x${string}`): RegistryEntry | undefined {
    return this.registry.getEntry(address);
  }

  /** Shutdown — stop timers and save state */
  shutdown(): void {
    this.escrow.stopExpiryChecker();
    this.intents.stop();
    console.log(`[mesh] Node ${this.identity.getIdentity().name} shut down`);
  }
}