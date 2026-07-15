/**
 * Agent Payment Manager — high-level API for agents to manage their USDC
 *
 * Combines wallet, x402 client, batch settlement, and marketplace
 * into a single cohesive interface that agents can use.
 *
 * Usage:
 *   import { AgentPayments } from "stack/payments/manager";
 *
 *   const payments = new AgentPayments({
 *     privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
 *     chain: "base",
 *   });
 *
 *   // Check balance
 *   const bal = await payments.getBalance();
 *
 *   // Pay for an API call (handles 402 automatically)
 *   const data = await payments.callAPI("https://api.example.com/data");
 *
 *   // Send USDC to someone
 *   await payments.pay("0xRECIPIENT", 5, "thanks for the data");
 *
 *   // Browse marketplace
 *   const services = payments.listServices();
 */

import { createWallet, type WalletConfig } from "./wallet.js";
import { x402Client, x402Batcher } from "./x402.js";
import { SettlementService, type SettleMode } from "./settlement.js";
import { marketplace, Marketplace } from "./marketplace.js";
import type { WalletHandle, ServiceProvider } from "../core/types.js";

export interface AgentPaymentsConfig extends WalletConfig {
  /** Batch settlement mode for outgoing micropayments */
  settlementMode?: SettleMode;
  /** Settlement interval in seconds (for "time" mode) */
  settlementInterval?: number;
  /** Amount threshold (for "amount" mode) */
  settlementThreshold?: number;
}

export class AgentPayments {
  private wallet: WalletHandle | null = null;
  private config: AgentPaymentsConfig;
  private x402: x402Client | null = null;
  private batcher: x402Batcher | null = null;
  private settlement: SettlementService | null = null;
  private market: Marketplace;

  constructor(config: AgentPaymentsConfig) {
    this.config = config;
    this.market = marketplace;
  }

  /** Initialize wallet and payment infrastructure */
  async init(): Promise<void> {
    this.wallet = await createWallet(this.config);
    this.x402 = new x402Client(this.wallet);

    // For batch settlement, we need a recipient — use self for now
    // In production, the seller sets the recipient
    console.log(`[stack] Payment wallet initialized: ${this.wallet.address} (${this.config.chain})`);
  }

  /** Get USDC balance */
  async getBalance(): Promise<number> {
    if (!this.wallet) throw new Error("Call init() first");
    return this.wallet.balance();
  }

  /** Get wallet address */
  getAddress(): string {
    if (!this.wallet) throw new Error("Call init() first");
    return this.wallet.address;
  }

  /** Send USDC to an address */
  async pay(to: string, amount: number, memo?: string): Promise<string> {
    if (!this.wallet) throw new Error("Call init() first");
    return this.wallet.send(to, amount);
  }

  /** Call a paid API endpoint — handles 402 payment automatically */
  async callAPI(url: string, opts?: RequestInit): Promise<Response> {
    if (!this.x402) throw new Error("Call init() first");
    return this.x402.fetch(url, opts);
  }

  /** Set up batch settlement for micropayments */
  enableBatchSettlement(recipient: string, mode: SettleMode = "manual", intervalSeconds = 60): void {
    if (!this.wallet) throw new Error("Call init() first");
    this.settlement = new SettlementService(this.wallet, {
      mode,
      intervalSeconds,
      recipient,
    });
    this.settlement.start();
    console.log(`[stack] Batch settlement enabled (${mode} mode → ${recipient})`);
  }

  /** Queue a micropayment for batch settlement */
  queuePayment(amount: number, memo?: string): void {
    if (!this.settlement) throw new Error("Call enableBatchSettlement() first");
    this.settlement.queue(amount, memo);
  }

  /** Settle pending batch payments */
  async settle(): Promise<string | null> {
    if (!this.settlement) throw new Error("Call enableBatchSettlement() first");
    return this.settlement.settle();
  }

  /** Get settlement stats */
  settlementStats() {
    if (!this.settlement) return null;
    return this.settlement.stats();
  }

  /** List available services in the marketplace */
  listServices(): ServiceProvider[] {
    return this.market.list();
  }

  /** Search marketplace for services */
  searchServices(query: string): ServiceProvider[] {
    return this.market.search(query);
  }

  /** Call a marketplace service by name (handles payment automatically) */
  async callService(name: string, opts?: RequestInit): Promise<Response> {
    const service = this.market.get(name);
    if (!service) throw new Error(`Service "${name}" not found in marketplace`);
    return this.callAPI(service.endpoint, opts);
  }

  /** Register your own service in the marketplace */
  registerService(service: ServiceProvider): void {
    this.market.register(service);
  }

  /** Generate a payment request/invoice for someone to pay you */
  async requestPayment(amount: number, memo?: string): Promise<string> {
    if (!this.wallet) throw new Error("Call init() first");
    return this.wallet.receive(amount, memo);
  }

  /** Full payment status summary */
  async status(): Promise<{
    address: string;
    chain: string;
    balance: number;
    settlement: ReturnType<SettlementService["stats"]> | null;
    marketplace: number;
  }> {
    if (!this.wallet) throw new Error("Call init() first");
    return {
      address: this.wallet.address,
      chain: this.wallet.chain,
      balance: await this.wallet.balance(),
      settlement: this.settlement?.stats() ?? null,
      marketplace: this.market.list().length,
    };
  }
}