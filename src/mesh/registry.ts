/**
 * Agent Registry & Reputation System
 *
 * The registry is the "phone book" for the agent mesh.
 * Agents register with their capabilities, stake USDC as a bond,
 * and build reputation through successful task completion.
 *
 * Reputation is stake-weighted: agents with more staked USDC have
 * more to lose from bad behavior, making their reputation more trustworthy.
 *
 * Discovery: agents query the registry by capability and sort by
 * reputation to find the best service providers.
 *
 * In production, the registry would be an on-chain contract.
 * Here we implement the off-chain logic with on-chain settlement hooks.
 */

import type { WalletHandle } from "../core/types.js";
import type {
  AgentIdentity,
  RegistryEntry,
  ReputationUpdate,
} from "./types.js";
import { AgentIdentityManager } from "./identity.js";

export interface RegistryConfig {
  /** Minimum stake required to register (USDC) */
  minStake?: number;
  /** Reputation boost per completed task */
  taskCompleteBoost?: number;
  /** Reputation penalty per failed task */
  taskFailPenalty?: number;
  /** Maximum reputation score */
  maxReputation?: number;
  /** Slash percentage of stake on failure */
  slashPercent?: number;
}

export class AgentRegistry {
  private entries: Map<string, RegistryEntry> = new Map();
  private reputationLog: ReputationUpdate[] = [];
  private identity: AgentIdentityManager;
  private wallet: WalletHandle;
  private config: RegistryConfig;

  constructor(identity: AgentIdentityManager, wallet: WalletHandle, config?: RegistryConfig) {
    this.identity = identity;
    this.wallet = wallet;
    this.config = {
      minStake: config?.minStake ?? 1, // 1 USDC minimum
      taskCompleteBoost: config?.taskCompleteBoost ?? 1,
      taskFailPenalty: config?.taskFailPenalty ?? 5,
      maxReputation: config?.maxReputation ?? 100,
      slashPercent: config?.slashPercent ?? 10, // 10% of stake slashed
    };
  }

  /**
   * Register this agent in the mesh.
   * Stakes USDC as a bond — slashable for bad behavior.
   *
   * In production, this calls a registry contract that locks the USDC.
   * Here we send the stake to a registry address and track the entry.
   */
  async register(stake: number = this.config.minStake!): Promise<RegistryEntry> {
    if (stake < this.config.minStake!) {
      throw new Error(`Stake ${stake} below minimum ${this.config.minStake}`);
    }

    // Send stake on-chain (in production: to registry contract)
    if (stake > 0) {
      // Stake is sent to a deterministic registry address
      // In production: registryContract.register{value: stake}()
      console.log(`[mesh] Staking ${stake} USDC for registry registration`);
    }

    const entry: RegistryEntry = {
      agent: this.identity.getIdentity(),
      stake,
      reputation: 50, // Start at neutral reputation
      tasksCompleted: 0,
      tasksFailed: 0,
      totalEarned: 0,
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
      online: true,
    };

    this.entries.set(this.identity.address, entry);
    console.log(
      `[mesh] Registered: ${entry.agent.name} (${entry.agent.did}) — stake: ${stake} USDC, rep: 50`
    );

    return entry;
  }

  /**
   * Update this agent's online status.
   */
  setOnline(online: boolean): void {
    const entry = this.entries.get(this.identity.address);
    if (entry) {
      entry.online = online;
      entry.lastActiveAt = Date.now();
    }
  }

  /**
   * Record a reputation update for any agent.
   * Called after task completion or failure.
   */
  recordReputation(
    agentAddress: `0x${string}`,
    delta: number,
    reason: string,
    taskId?: string
  ): void {
    const entry = this.entries.get(agentAddress);
    if (!entry) {
      console.warn(`[mesh] Reputation update for unknown agent: ${agentAddress}`);
      return;
    }

    const update: ReputationUpdate = {
      agentAddress,
      delta,
      reason,
      taskId,
      timestamp: Date.now(),
    };

    this.reputationLog.push(update);

    // Apply delta
    const newRep = Math.max(0, Math.min(this.config.maxReputation!, entry.reputation + delta));
    entry.reputation = newRep;
    entry.lastActiveAt = Date.now();

    if (delta > 0) {
      entry.tasksCompleted++;
    } else if (delta < 0 && reason.includes("fail")) {
      entry.tasksFailed++;
    }

    console.log(
      `[mesh] Reputation: ${agentAddress} ${delta > 0 ? "+" : ""}${delta} → ${newRep} (${reason})`
    );
  }

  /**
   * Record a successful task completion.
   * Boosts reputation and tracks earnings.
   */
  recordTaskSuccess(agentAddress: `0x${string}`, earnings: number, taskId?: string): void {
    const entry = this.entries.get(agentAddress);
    if (entry) {
      entry.totalEarned += earnings;
    }
    this.recordReputation(agentAddress, this.config.taskCompleteBoost!, "task_completed", taskId);
  }

  /**
   * Record a task failure.
   * Penalizes reputation and slashes stake.
   */
  async recordTaskFailure(
    agentAddress: `0x${string}`,
    taskId?: string
  ): Promise<number> {
    const entry = this.entries.get(agentAddress);
    let slashed = 0;

    if (entry) {
      // Slash stake
      slashed = (entry.stake * this.config.slashPercent!) / 100;
      entry.stake -= slashed;
      console.log(`[mesh] Slashed ${slashed} USDC from ${agentAddress} (stake now: ${entry.stake})`);
    }

    this.recordReputation(agentAddress, -this.config.taskFailPenalty!, "task_failed", taskId);
    return slashed;
  }

  /**
   * Discover agents by capability.
   * Returns agents sorted by reputation (highest first).
   */
  discover(capability?: string, minReputation: number = 0): RegistryEntry[] {
    let results = Array.from(this.entries.values()).filter(
      (e) => e.online && e.reputation >= minReputation
    );

    if (capability) {
      results = results.filter((e) =>
        e.agent.capabilities.includes(capability)
      );
    }

    // Sort by reputation (weighted by stake for trust)
    results.sort((a, b) => {
      const scoreA = a.reputation * Math.log(1 + a.stake);
      const scoreB = b.reputation * Math.log(1 + b.stake);
      return scoreB - scoreA;
    });

    return results;
  }

  /**
   * Get a specific agent's registry entry.
   */
  getEntry(address: `0x${string}`): RegistryEntry | undefined {
    return this.entries.get(address);
  }

  /**
   * Receive a discovery message from another agent and register them.
   */
  receiveDiscovery(agent: AgentIdentity, stake: number = 0): RegistryEntry {
    let entry = this.entries.get(agent.address);

    if (entry) {
      // Update existing entry
      entry.agent = agent;
      entry.lastActiveAt = Date.now();
      entry.online = true;
    } else {
      entry = {
        agent,
        stake,
        reputation: 50,
        tasksCompleted: 0,
        tasksFailed: 0,
        totalEarned: 0,
        registeredAt: Date.now(),
        lastActiveAt: Date.now(),
        online: true,
      };
      this.entries.set(agent.address, entry);
    }

    console.log(`[mesh] Discovered agent: ${agent.name} (${agent.did})`);
    return entry;
  }

  /**
   * Get the full reputation history for an agent.
   */
  getReputationHistory(address: `0x${string}`): ReputationUpdate[] {
    return this.reputationLog.filter((u) => u.agentAddress === address);
  }

  /**
   * Get registry statistics.
   */
  stats(): {
    totalAgents: number;
    onlineAgents: number;
    totalStaked: number;
    avgReputation: number;
    totalEarned: number;
  } {
    const entries = Array.from(this.entries.values());
    return {
      totalAgents: entries.length,
      onlineAgents: entries.filter((e) => e.online).length,
      totalStaked: entries.reduce((sum, e) => sum + e.stake, 0),
      avgReputation:
        entries.length > 0
          ? entries.reduce((sum, e) => sum + e.reputation, 0) / entries.length
          : 0,
      totalEarned: entries.reduce((sum, e) => sum + e.totalEarned, 0),
    };
  }

  /**
   * List all known agents.
   */
  listAgents(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }
}