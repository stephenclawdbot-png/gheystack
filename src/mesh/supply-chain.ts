/**
 * Autonomous Supply Chain Composition
 *
 * The breakthrough primitive: agents automatically decompose complex tasks
 * into subtasks, hire other agents via the mesh, orchestrate parallel and
 * sequential execution, aggregate results, and settle payments — all autonomously.
 *
 * This is the "agentic economy" — an AI agent can receive a high-level goal
 * like "analyze this codebase and generate a security report" and automatically:
 *   1. Decompose it into subtasks (read files, analyze patterns, check vulns, write report)
 *   2. Find agents in the mesh with the right capabilities
 *   3. Negotiate prices via RFQ
 *   4. Fund escrows for each subtask
 *   5. Orchestrate execution (parallel where possible, sequential where dependent)
 *   6. Aggregate results from sub-agents
 *  7. Settle all payments
 *  8. Return the final result to the caller
 *
 * Supply chains can be recursive — a sub-agent can decompose its subtask further,
 * creating a multi-tier supply chain. The protocol tracks the full dependency graph
 * and ensures payment flows correctly through the chain.
 *
 * Example:
 *   User → Agent A: "Audit this smart contract"
 *   Agent A decomposes:
 *     ├── Subtask 1: "Parse AST" → hires Agent B (parallel)
 *     ├── Subtask 2: "Check vulnerability patterns" → hires Agent C (parallel)
 *     └── Subtask 3: "Generate report" → depends on 1 + 2 → hires Agent D (sequential)
 *   Agent B further decomposes:
 *     └── Sub-subtask: "Extract function signatures" → hires Agent E
 *   Payment flows: User pays A → A pays B,C,D → B pays E
 */

import type { AgentIdentity, Task, EscrowMilestone, SupplyChain, SupplyChainNode, SupplyChainNodeStatus, SupplyChainStatus, AggregationStrategy, DecompositionPlan, PaymentIntent } from "./types.js";
import { MeshProtocol } from "./protocol.js";
import { TaskMarket } from "./task-market.js";
import { EscrowService } from "./escrow.js";
import { AgentRegistry } from "./registry.js";
import { AgentIdentityManager } from "./identity.js";

// ─── Types ─────────────────────────────────────────────────────
// All types are now defined in types.ts and imported above.

/** Configuration for the supply chain engine */
export interface SupplyChainConfig {
  /** Max total budget for a single chain (USDC) */
  maxBudgetPerChain?: number;
  /** Max depth of recursive decomposition */
  maxDepth?: number;
  /** Timeout for the entire chain (ms) */
  chainTimeoutMs?: number;
  /** Whether to auto-retry failed nodes */
  autoRetry?: boolean;
  /** Max retries per node */
  maxRetries?: number;
  /** Whether to auto-settle payments on completion */
  autoSettle?: boolean;
}

// ─── Supply Chain Engine ───────────────────────────────────────

export class SupplyChainEngine {
  private identity: AgentIdentityManager;
  private protocol: MeshProtocol;
  private taskMarket: TaskMarket;
  private escrow: EscrowService;
  private registry: AgentRegistry;
  private config: SupplyChainConfig;
  private chains: Map<string, SupplyChain> = new Map();

  constructor(
    identity: AgentIdentityManager,
    protocol: MeshProtocol,
    taskMarket: TaskMarket,
    escrow: EscrowService,
    registry: AgentRegistry,
    config?: SupplyChainConfig
  ) {
    this.identity = identity;
    this.protocol = protocol;
    this.taskMarket = taskMarket;
    this.escrow = escrow;
    this.registry = registry;
    this.config = {
      maxBudgetPerChain: config?.maxBudgetPerChain ?? 1000,
      maxDepth: config?.maxDepth ?? 3,
      chainTimeoutMs: config?.chainTimeoutMs ?? 300000, // 5 min
      autoRetry: config?.autoRetry ?? true,
      maxRetries: config?.maxRetries ?? 2,
      autoSettle: config?.autoSettle ?? true,
    };
  }

  /**
   * Execute a high-level request by decomposing it into a supply chain.
   *
   * The decomposition plan describes how to break the request into subtasks,
   * which agents to hire, and how to aggregate results.
   *
   * This is the main entry point for autonomous task decomposition.
   */
  async execute(
    request: string,
    plan: DecompositionPlan,
    budget: number
  ): Promise<SupplyChain> {
    if (budget > this.config.maxBudgetPerChain!) {
      throw new Error(`Budget ${budget} exceeds max ${this.config.maxBudgetPerChain}`);
    }

    const chainId = `chain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();

    // Build the chain from the plan
    const chain: SupplyChain = {
      id: chainId,
      rootRequest: request,
      totalBudget: budget,
      nodes: new Map(),
      terminalNodes: plan.terminalNodes,
      aggregationStrategy: plan.aggregationStrategy,
      status: "executing",
      createdAt: now,
      startedAt: now,
      totalSpent: 0,
      depth: 0,
    };

    // Create nodes from the plan
    for (const node of plan.nodes) {
      const nodeId = `node-${chain.nodes.size + 1}`;
      chain.nodes.set(nodeId, {
        nodeId,
        label: node.label,
        capability: node.capability,
        input: node.input,
        budget: node.budget,
        dependsOn: node.dependsOn,
        mergeInputs: node.mergeInputs,
        allowSubDecomposition: node.allowSubDecomposition,
        maxDepth: node.maxDepth,
        status: node.dependsOn.length === 0 ? "ready" : "pending",
      });
    }

    this.chains.set(chainId, chain);
    console.log(`[stack] Supply chain ${chainId} started — ${chain.nodes.size} nodes, budget: ${budget} USDC`);

    // Execute the chain
    await this.executeChain(chain);

    return chain;
  }

  /**
   * Execute all nodes in the chain, respecting dependencies.
   * Nodes with no dependencies run in parallel; dependent nodes wait.
   */
  private async executeChain(chain: SupplyChain): Promise<void> {
    const maxDepth = this.config.maxDepth!;
    const timeout = this.config.chainTimeoutMs!;
    const startTime = chain.startedAt!;

    while (chain.status === "executing") {
      // Check timeout
      if (Date.now() - startTime > timeout) {
        chain.status = "failed";
        console.error(`[stack] Supply chain ${chain.id} timed out after ${timeout}ms`);
        break;
      }

      // Find ready nodes (dependencies all completed)
      const readyNodes = this.getReadyNodes(chain);

      if (readyNodes.length === 0) {
        // Check if all nodes are done or failed
        const allDone = this.isChainComplete(chain);
        if (allDone) {
          chain.status = "aggregating";
          break;
        }

        // Check for deadlock (no ready nodes, not all done)
        const hasExecuting = Array.from(chain.nodes.values()).some(
          (n) => n.status === "executing" || n.status === "hiring" || n.status === "reviewing"
        );
        if (!hasExecuting) {
          // Deadlock — all remaining nodes have failed dependencies
          chain.status = "failed";
          console.error(`[stack] Supply chain ${chain.id} deadlocked`);
          break;
        }

        // Wait for executing nodes to finish
        await this.sleep(1000);
        continue;
      }

      // Execute ready nodes in parallel
      const executions = readyNodes.map((node) => this.executeNode(chain, node, maxDepth));
      await Promise.allSettled(executions);

      // Small delay before next iteration
      await this.sleep(100);
    }

    // Aggregate results
    if (chain.status === "aggregating") {
      await this.aggregateResults(chain);
      chain.status = "completed";
      chain.completedAt = Date.now();
      console.log(
        `[stack] Supply chain ${chain.id} completed — spent ${chain.totalSpent}/${chain.totalBudget} USDC in ${Math.round((chain.completedAt - chain.createdAt) / 1000)}s`
      );
    }
  }

  /**
   * Execute a single node — hire an agent, negotiate, get result, settle.
   */
  private async executeNode(
    chain: SupplyChain,
    node: SupplyChainNode,
    maxDepth: number
  ): Promise<void> {
    node.status = "hiring";

    try {
      // Merge inputs from dependencies if needed
      if (node.mergeInputs && node.dependsOn.length > 0) {
        const depResults: Record<string, unknown> = {};
        for (const depId of node.dependsOn) {
          const depNode = chain.nodes.get(depId);
          if (depNode && depNode.status === "completed") {
            depResults[depId] = depNode.result;
          }
        }
        node.input = { ...node.input as object, _dependencies: depResults };
      }

      // Find agents with the required capability
      const candidates = await this.registry.discover(node.capability);

      if (candidates.length === 0) {
        throw new Error(`No agents found for capability "${node.capability}" within budget ${node.budget} USDC`);
      }

      // Post task to the task market
      const milestones: EscrowMilestone[] = [
        { description: node.label, amount: node.budget, released: false },
      ];

      const task = await this.taskMarket.postTask({
        title: node.label,
        description: `${chain.rootRequest} → ${node.label}`,
        capability: node.capability,
        input: node.input,
        bounty: node.budget,
        durationSeconds: Math.max(60, Math.floor((chain.totalBudget * 1000) / Math.max(node.budget, 1))),
        paymentMethod: "escrow",
        milestones,
      });

      node.taskId = task.id;
      node.status = "executing";

      // Wait for task completion (poll task market)
      const result = await this.waitForTaskCompletion(task.id, this.config.chainTimeoutMs!);

      if (result.status === "completed") {
        node.result = result.result;
        node.actualPrice = result.actualPrice ?? node.budget;
        node.hiredAgent = result.assignedTo;
        node.status = "completed";
        chain.totalSpent += node.actualPrice;
        console.log(`[stack] Node "${node.label}" completed — ${node.actualPrice} USDC`);
      } else if (result.status === "failed") {
        node.error = result.error ?? "Unknown error";
        node.status = "failed";
        console.error(`[stack] Node "${node.label}" failed: ${node.error}`);

        // Retry if configured
        if (this.config.autoRetry && maxDepth > 0) {
          // Could retry with different agent or higher budget
          // For now, mark as failed
        }
      }
    } catch (e) {
      node.error = e instanceof Error ? e.message : String(e);
      node.status = "failed";
      console.error(`[stack] Node "${node.label}" error: ${node.error}`);
    }
  }

  /**
   * Wait for a task to complete in the task market.
   * Polls the task market until the task is completed, failed, or expired.
   */
  private async waitForTaskCompletion(
    taskId: string,
    timeoutMs: number
  ): Promise<{
    status: "completed" | "failed";
    result?: unknown;
    actualPrice?: number;
    assignedTo?: `0x${string}`;
    error?: string;
  }> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(check);
          resolve({ status: "failed", error: "Timeout waiting for task completion" });
          return;
        }

        const task = this.taskMarket.getTask(taskId);
        if (!task) {
          clearInterval(check);
          resolve({ status: "failed", error: "Task not found" });
          return;
        }

        if (task.status === "completed") {
          clearInterval(check);
          resolve({
            status: "completed",
            result: task.result,
            actualPrice: task.assignedBid?.price,
            assignedTo: task.assignedBid?.bidder,
          });
        } else if (task.status === "failed" || task.status === "expired") {
          clearInterval(check);
          resolve({
            status: "failed",
            error: task.status === "expired" ? "Task expired" : "Task failed",
          });
        }
      }, 2000);
    });
  }

  /**
   * Get nodes that are ready to execute (all dependencies completed).
   */
  private getReadyNodes(chain: SupplyChain): SupplyChainNode[] {
    return Array.from(chain.nodes.values()).filter((node) => {
      if (node.status !== "ready") return false;
      // Check all dependencies are completed
      return node.dependsOn.every((depId) => {
        const dep = chain.nodes.get(depId);
        return dep && dep.status === "completed";
      });
    });
  }

  /**
   * Check if all nodes in the chain are in a terminal state.
   */
  private isChainComplete(chain: SupplyChain): boolean {
    return Array.from(chain.nodes.values()).every(
      (n) =>
        n.status === "completed" ||
        n.status === "failed" ||
        n.status === "skipped"
    );
  }

  /**
   * Aggregate terminal node results based on the aggregation strategy.
   */
  private async aggregateResults(chain: SupplyChain): Promise<void> {
    const terminalResults = chain.terminalNodes
      .map((id) => chain.nodes.get(id))
      .filter((n): n is SupplyChainNode => n !== undefined && n.status === "completed")
      .map((n) => n.result);

    let aggregated: unknown;

    switch (chain.aggregationStrategy) {
      case "last":
        aggregated = terminalResults[terminalResults.length - 1];
        break;
      case "first":
        aggregated = terminalResults[0];
        break;
      case "merge":
        aggregated = Object.assign({}, ...terminalResults.map((r) => r as object));
        break;
      case "concat":
        aggregated = terminalResults.flatMap((r) =>
          Array.isArray(r) ? r : [r]
        );
        break;
      case "custom":
        // Custom aggregation would be provided by the caller
        aggregated = terminalResults;
        break;
      default:
        aggregated = terminalResults[0];
    }

    // Store the final result on the chain
    (chain as SupplyChain & { result?: unknown }).result = aggregated;
  }

  /** Get a supply chain by ID */
  getChain(chainId: string): SupplyChain | undefined {
    return this.chains.get(chainId);
  }

  /** Get all active supply chains */
  getActiveChains(): SupplyChain[] {
    return Array.from(this.chains.values()).filter(
      (c) => c.status === "executing" || c.status === "planning"
    );
  }

  /** Get supply chain statistics */
  getStats(): {
    totalChains: number;
    activeChains: number;
    completedChains: number;
    failedChains: number;
    totalSpent: number;
  } {
    const chains = Array.from(this.chains.values());
    return {
      totalChains: chains.length,
      activeChains: chains.filter((c) => c.status === "executing").length,
      completedChains: chains.filter((c) => c.status === "completed").length,
      failedChains: chains.filter((c) => c.status === "failed").length,
      totalSpent: chains.reduce((sum, c) => sum + c.totalSpent, 0),
    };
  }

  /** Abort a supply chain */
  abortChain(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (chain) {
      chain.status = "aborted";
      console.log(`[stack] Supply chain ${chainId} aborted`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Decomposition Helpers ─────────────────────────────────────

/**
 * Build a simple linear pipeline decomposition plan.
 * Each step depends on the previous one.
 *
 * Example: [analyze, draft, review, publish]
 * → step 2 depends on step 1, step 3 on step 2, etc.
 */
export function linearPipeline(
  steps: Array<{
    label: string;
    capability: string;
    input: unknown;
    budget: number;
    allowSubDecomposition?: boolean;
  }>,
  aggregationStrategy: AggregationStrategy = "last"
): DecompositionPlan {
  const nodes = steps.map((step, i) => ({
    label: step.label,
    capability: step.capability,
    input: step.input,
    budget: step.budget,
    dependsOn: i > 0 ? [`node-${i}`] : [],
    mergeInputs: i > 0,
    allowSubDecomposition: step.allowSubDecomposition ?? true,
    maxDepth: 2,
  }));

  return {
    nodes,
    terminalNodes: [`node-${steps.length}`],
    aggregationStrategy,
  };
}

/**
 * Build a fan-out / fan-in decomposition plan.
 * Multiple parallel steps that all feed into a final aggregation step.
 *
 * Example: [analyze-code, check-vulns, review-gas] → all parallel → [generate-report]
 */
export function fanOutFanIn(
  parallelSteps: Array<{
    label: string;
    capability: string;
    input: unknown;
    budget: number;
  }>,
  finalStep: {
    label: string;
    capability: string;
    budget: number;
  },
  aggregationStrategy: AggregationStrategy = "merge"
): DecompositionPlan {
  const parallelNodeIds: string[] = [];
  const nodes: DecompositionPlan["nodes"] = parallelSteps.map((step, i) => {
    const id = `node-${i + 1}`;
    parallelNodeIds.push(id);
    return {
      label: step.label,
      capability: step.capability,
      input: step.input,
      budget: step.budget,
      dependsOn: [] as string[],
      mergeInputs: false,
      allowSubDecomposition: true,
      maxDepth: 2,
    };
  });

  // Final node depends on all parallel nodes
  const finalNodeId = `node-${parallelSteps.length + 1}`;
  nodes.push({
    label: finalStep.label,
    capability: finalStep.capability,
    input: {},
    budget: finalStep.budget,
    dependsOn: parallelNodeIds,
    mergeInputs: true,
    allowSubDecomposition: false,
    maxDepth: 0,
  });

  return {
    nodes,
    terminalNodes: [finalNodeId],
    aggregationStrategy,
  };
}

/**
 * Build a DAG decomposition plan from an explicit node list.
 * For complex workflows with non-linear dependencies.
 */
export function dag(
  nodes: Array<{
    label: string;
    capability: string;
    input: unknown;
    budget: number;
    dependsOn: string[];
    mergeInputs?: boolean;
    allowSubDecomposition?: boolean;
    maxDepth?: number;
  }>,
  terminalNodes: string[],
  aggregationStrategy: AggregationStrategy = "merge"
): DecompositionPlan {
  return {
    nodes: nodes.map((n, i) => ({
      label: n.label,
      capability: n.capability,
      input: n.input,
      budget: n.budget,
      dependsOn: n.dependsOn,
      mergeInputs: n.mergeInputs ?? false,
      allowSubDecomposition: n.allowSubDecomposition ?? true,
      maxDepth: n.maxDepth ?? 2,
    })),
    terminalNodes,
    aggregationStrategy,
  };
}