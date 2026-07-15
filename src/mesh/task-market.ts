/**
 * Autonomous Task Market
 *
 * The task market is where agents hire other agents.
 * An agent posts a task with a USDC bounty; other agents bid;
 * the best bid wins; the worker completes the task and gets paid.
 *
 * This is the economic engine of the mesh — it creates a market
 * for agent labor where prices are discovered through bidding.
 *
 * Flow:
 * 1. POST: Agent A posts a task with bounty → escrow created
 * 2. BID: Agents B, C, D submit bids (price + estimated time)
 * 3. ASSIGN: Agent A selects winning bid (auto or manual)
 * 4. EXECUTE: Winner performs the task
 * 5. SUBMIT: Winner submits result
 * 6. REVIEW: Poster verifies result
 * 7. SETTLE: Escrow released to worker, reputation updated
 *
 * Auto-assignment: If the poster doesn't manually select within
 * a deadline, the lowest bid from the highest-reputation agent wins.
 */

import type { WalletHandle } from "../core/types.js";
import type {
  Task,
  TaskBid,
  TaskStatus,
  RegistryEntry,
} from "./types.js";
import { AgentIdentityManager } from "./identity.js";
import { AgentRegistry } from "./registry.js";
import { EscrowService } from "./escrow.js";

export interface TaskMarketConfig {
  /** Auto-assign after N seconds if poster doesn't select */
  autoAssignDelay?: number;
  /** Auto-select criterion */
  autoAssignBy?: "price" | "reputation" | "speed";
  /** Default task duration (seconds) */
  defaultDuration?: number;
}

export class TaskMarket {
  private tasks: Map<string, Task> = new Map();
  private identity: AgentIdentityManager;
  private wallet: WalletHandle;
  private registry: AgentRegistry;
  private escrow: EscrowService;
  private config: TaskMarketConfig;

  constructor(
    identity: AgentIdentityManager,
    wallet: WalletHandle,
    registry: AgentRegistry,
    escrow: EscrowService,
    config?: TaskMarketConfig
  ) {
    this.identity = identity;
    this.wallet = wallet;
    this.registry = registry;
    this.escrow = escrow;
    this.config = {
      autoAssignDelay: config?.autoAssignDelay ?? 60, // 1 min
      autoAssignBy: config?.autoAssignBy ?? "reputation",
      defaultDuration: config?.defaultDuration ?? 3600,
    };
  }

  /**
   * Post a new task to the market.
   * Creates an escrow locking the bounty USDC.
   */
  async postTask(params: {
    title: string;
    description: string;
    capability: string;
    input: unknown;
    bounty: number;
    durationSeconds?: number;
    paymentMethod?: "direct" | "channel" | "escrow";
    arbiter?: `0x${string}`;
    milestones?: Array<{ description: string; amount: number }>;
  }): Promise<Task> {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const duration = params.durationSeconds ?? this.config.defaultDuration!;

    // Create escrow for the bounty
    const escrowRecord = await this.escrow.create({
      beneficiary: "0x0000000000000000000000000000000000000000", // updated on assignment
      amount: params.bounty,
      durationSeconds: duration,
      arbiter: params.arbiter,
      milestones: params.milestones?.map(m => ({ description: m.description, amount: m.amount, released: false })),
    });

    const task: Task = {
      id,
      poster: this.identity.address,
      title: params.title,
      description: params.description,
      capability: params.capability,
      input: params.input,
      bounty: params.bounty,
      paymentMethod: params.paymentMethod ?? "escrow",
      status: "open",
      bids: [],
      deadline: now + duration * 1000,
      escrowId: escrowRecord.id,
      arbiter: params.arbiter,
      createdAt: now,
    };

    this.tasks.set(id, task);
    console.log(
      `[mesh] Task posted: "${params.title}" — bounty: ${params.bounty} USDC, capability: ${params.capability}`
    );

    return task;
  }

  /**
   * Submit a bid on a task.
   * Called by an agent that wants to perform the task.
   */
  async bid(
    taskId: string,
    price: number,
    estimatedTime: number,
    message?: string
  ): Promise<TaskBid> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "open") throw new Error(`Task is ${task.status}`);

    // Get bidder's reputation
    const entry = this.registry.getEntry(this.identity.address);
    const reputation = entry?.reputation ?? 0;

    const bid: TaskBid = {
      id: `bid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bidder: this.identity.address,
      price,
      estimatedTime,
      reputation,
      message,
      timestamp: Date.now(),
    };

    task.bids.push(bid);
    console.log(
      `[mesh] Bid on "${task.title}": ${price} USDC, ${estimatedTime}s, rep: ${reputation}`
    );

    // Auto-assign if delay has passed
    if (Date.now() - task.createdAt > this.config.autoAssignDelay! * 1000) {
      await this.autoAssign(taskId);
    }

    return bid;
  }

  /**
   * Manually assign a task to a specific bid.
   */
  async assignTask(taskId: string, bidId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "open") throw new Error(`Task is ${task.status}`);
    if (task.poster !== this.identity.address) {
      throw new Error("Only the poster can assign tasks");
    }

    const bid = task.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error(`Bid ${bidId} not found`);

    task.assignedBid = bid;
    task.status = "assigned";

    // Update escrow beneficiary
    if (task.escrowId) {
      const escrow = this.escrow.get(task.escrowId);
      if (escrow) {
        escrow.beneficiary = bid.bidder;
      }
    }

    console.log(
      `[mesh] Task assigned: "${task.title}" → ${bid.bidder} (${bid.price} USDC)`
    );

    return task;
  }

  /**
   * Auto-assign based on configured criterion.
   * Selects the best bid by reputation, price, or speed.
   */
  private async autoAssign(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "open") return;

    if (task.bids.length === 0) return;

    let bestBid: TaskBid | undefined;

    switch (this.config.autoAssignBy) {
      case "price":
        bestBid = task.bids.reduce((best, b) => (b.price < best.price ? b : best));
        break;
      case "speed":
        bestBid = task.bids.reduce((best, b) =>
          b.estimatedTime < best.estimatedTime ? b : best
        );
        break;
      case "reputation":
      default:
        // Weighted: reputation * 0.6 + price_factor * 0.4
        bestBid = task.bids.reduce((best, b) => {
          const bestScore = best.reputation * 0.6 + (1 / best.price) * 0.4 * 100;
          const bScore = b.reputation * 0.6 + (1 / b.price) * 0.4 * 100;
          return bScore > bestScore ? b : best;
        });
        break;
    }

    if (bestBid) {
      await this.assignTask(taskId, bestBid.id);
    }
  }

  /**
   * Submit task result (called by the assigned worker).
   */
  async submitResult(taskId: string, result: unknown, proof?: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "assigned") throw new Error(`Task is ${task.status}`);
    if (!task.assignedBid) throw new Error("No bid assigned");
    if (task.assignedBid.bidder !== this.identity.address) {
      throw new Error("Only the assigned worker can submit results");
    }

    task.result = result;
    task.status = "review";

    console.log(`[mesh] Task result submitted: "${task.title}"`);
    return task;
  }

  /**
   * Accept the result and release payment (called by poster).
   */
  async acceptResult(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`Task is ${task.status}`);
    if (task.poster !== this.identity.address) {
      throw new Error("Only the poster can accept results");
    }

    // Release escrow to worker
    let txHash = "no-escrow";
    if (task.escrowId) {
      txHash = await this.escrow.release(task.escrowId);
    } else if (task.assignedBid) {
      // Direct payment fallback
      txHash = await this.wallet.send(task.assignedBid.bidder, task.assignedBid.price);
    }

    task.status = "completed";
    task.completedAt = Date.now();

    // Update reputation
    if (task.assignedBid) {
      this.registry.recordTaskSuccess(
        task.assignedBid.bidder,
        task.assignedBid.price,
        taskId
      );
    }

    console.log(`[mesh] Task completed: "${task.title}" — ${task.assignedBid?.price} USDC paid`);
    return txHash;
  }

  /**
   * Reject the result (called by poster).
   * Moves task to disputed or failed state.
   */
  async rejectResult(taskId: string, reason: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "review") throw new Error(`Task is ${task.status}`);
    if (task.poster !== this.identity.address) {
      throw new Error("Only the poster can reject results");
    }

    if (task.arbiter) {
      // Escalate to dispute
      task.status = "disputed";
      if (task.escrowId) {
        await this.escrow.dispute(task.escrowId);
      }
      console.log(`[mesh] Task disputed: "${task.title}" — ${reason}`);
    } else {
      // No arbiter — fail the task and refund
      task.status = "failed";
      if (task.escrowId) {
        await this.escrow.refund(task.escrowId);
      }
      if (task.assignedBid) {
        await this.registry.recordTaskFailure(task.assignedBid.bidder, taskId);
      }
      console.log(`[mesh] Task failed: "${task.title}" — ${reason}`);
    }

    return task;
  }

  /**
   * Cancel an open task (before assignment).
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "open") throw new Error(`Can only cancel open tasks`);
    if (task.poster !== this.identity.address) {
      throw new Error("Only the poster can cancel");
    }

    task.status = "failed";
    if (task.escrowId) {
      await this.escrow.refund(task.escrowId);
    }

    console.log(`[mesh] Task cancelled: "${task.title}"`);
  }

  /**
   * Expire tasks past their deadline.
   */
  expireStaleTasks(): number {
    let count = 0;
    const now = Date.now();

    for (const [id, task] of this.tasks) {
      if ((task.status === "open" || task.status === "assigned") && now > task.deadline) {
        task.status = "expired";
        if (task.escrowId) {
          this.escrow.claimExpired(task.escrowId);
        }
        if (task.assignedBid) {
          this.registry.recordTaskFailure(task.assignedBid.bidder, id);
        }
        count++;
      }
    }

    if (count > 0) {
      console.log(`[mesh] Expired ${count} stale task(s)`);
    }

    return count;
  }

  /**
   * List tasks (optionally filtered by status).
   */
  listTasks(status?: TaskStatus, capability?: string): Task[] {
    let results = Array.from(this.tasks.values());
    if (status) results = results.filter((t) => t.status === status);
    if (capability) results = results.filter((t) => t.capability === capability);
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get a specific task.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get tasks posted by this agent.
   */
  myPostedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.poster === this.identity.address
    );
  }

  /**
   * Get tasks assigned to this agent.
   */
  myAssignedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.assignedBid?.bidder === this.identity.address
    );
  }

  /**
   * Search for open tasks by keyword.
   */
  searchOpenTasks(query: string): Task[] {
    const q = query.toLowerCase();
    return Array.from(this.tasks.values())
      .filter((t) => t.status === "open")
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.capability.toLowerCase().includes(q)
      );
  }

  /**
   * Market statistics.
   */
  stats(): {
    totalTasks: number;
    openTasks: number;
    assignedTasks: number;
    completedTasks: number;
    totalBounties: number;
    avgBounty: number;
  } {
    const all = Array.from(this.tasks.values());
    const completed = all.filter((t) => t.status === "completed");
    return {
      totalTasks: all.length,
      openTasks: all.filter((t) => t.status === "open").length,
      assignedTasks: all.filter((t) => t.status === "assigned").length,
      completedTasks: completed.length,
      totalBounties: completed.reduce((s, t) => s + t.bounty, 0),
      avgBounty: completed.length > 0
        ? completed.reduce((s, t) => s + t.bounty, 0) / completed.length
        : 0,
    };
  }
}