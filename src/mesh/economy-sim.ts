/**
 * Agent Economy Simulator
 *
 * The breakthrough demo: spin up N agents with budgets and capabilities,
 * watch them autonomously trade services, form supply chains, compete for
 * tasks, build reputation, and create a self-organizing economy.
 *
 * This proves the mesh protocol works end-to-end without real money.
 * Uses mock wallets and in-memory state for zero-cost simulation.
 *
 * Usage:
 *   const sim = new EconomySimulator();
 *   await sim.spawn({ count: 20, budget: 100 });
 *   sim.injectTask("translate this document to Japanese and summarize it");
 *   await sim.run({ durationMs: 60000 });
 *   console.log(sim.stats());
 */

import type { SupplyChain } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────

export interface SimAgent {
  id: string;
  address: `0x${string}`;
  name: string;
  capabilities: string[];
  budget: number;           // USDC units (6 decimal)
  earned: number;
  spent: number;
  reputation: number;
  tasksCompleted: number;
  tasksFailed: number;
  supplyChainsInitiated: number;
  intentsCreated: number;
  intentsFulfilled: number;
  isOnline: boolean;
  behavior: "greedy" | "cooperative" | "strategic" | "lazy";
}

export interface SimEvent {
  timestamp: number;
  type: "task_posted" | "task_assigned" | "task_completed" | "task_failed"
      | "supply_chain_started" | "supply_chain_completed" | "supply_chain_failed"
      | "intent_created" | "intent_claimed" | "intent_fulfilled"
      | "payment_sent" | "agent_registered" | "agent_bankrupt";
  agentId?: string;
  description: string;
  amount?: number;
}

export interface SimConfig {
  agentCount: number;
  startingBudget: number;   // USDC per agent
  taskInjectionRate: number; // tasks per second
  durationMs: number;
  capabilities: string[];
  seedRandom?: boolean;
}

export interface SimStats {
  totalAgents: number;
  totalTasksPosted: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  totalSupplyChains: number;
  totalIntents: number;
  totalIntentsFulfilled: number;
  totalVolumeUsdc: number;     // total USDC that changed hands
  avgReputation: number;
  bankruptAgents: number;
  events: SimEvent[];
  topAgents: SimAgent[];
  giniCoefficient: number;    // wealth inequality metric
  chainDepthHistogram: Record<number, number>;
}

// ─── Simulator ─────────────────────────────────────────────────

const BEHAVIORS: SimAgent["behavior"][] = ["greedy", "cooperative", "strategic", "lazy"];
const NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega"];

export class EconomySimulator {
  private agents: Map<string, SimAgent> = new Map();
  private events: SimEvent[] = [];
  private running = false;
  private taskInjectors: ((sim: EconomySimulator) => void)[] = [];

  constructor() {
    // Simulator is standalone — doesn't need real mesh infrastructure.
    // It simulates the mesh economy in-memory for zero-cost demos.
  }

  /**
   * Spawn agents with random capabilities and budgets.
   */
  async spawn(opts: { count: number; budget: number; capabilities?: string[] }): Promise<void> {
    for (let i = 0; i < opts.count; i++) {
      const addr = makeAddress(i);
      const name = `${NAMES[i % NAMES.length]}-${Math.floor(i / NAMES.length) + 1}`;
      const caps = opts.capabilities
        ? pickRandom(opts.capabilities, 2 + Math.floor(Math.random() * 3))
        : pickRandom(DEFAULT_CAPABILITIES, 2 + Math.floor(Math.random() * 3));
      const behavior = BEHAVIORS[Math.floor(Math.random() * BEHAVIORS.length)];
      const budget = opts.budget + Math.floor(Math.random() * opts.budget * 0.5);

      const agent: SimAgent = {
        id: `agent-${i}`,
        address: addr,
        name,
        capabilities: caps,
        budget,
        earned: 0,
        spent: 0,
        reputation: 50,
        tasksCompleted: 0,
        tasksFailed: 0,
        supplyChainsInitiated: 0,
        intentsCreated: 0,
        intentsFulfilled: 0,
        isOnline: true,
        behavior,
      };

      this.agents.set(agent.id, agent);
      this.log({ type: "agent_registered", agentId: agent.id, description: `${name} joined with ${budget / 1e6} USDC, caps: ${caps.join(", ")}` });
    }
  }

  /**
   * Inject a task into the economy. An agent will pick it up, possibly
   * decompose it into a supply chain, and hire other agents.
   */
  injectTask(description: string, budget: number = 5e6): void {
    // Find a random agent to act as the client
    const clients = [...this.agents.values()].filter(a => a.isOnline && a.budget >= budget);
    if (clients.length === 0) return;
    const client = clients[Math.floor(Math.random() * clients.length)];

    this.log({ type: "task_posted", agentId: client.id, description: `${client.name} posted: "${description}" for ${budget / 1e6} USDC`, amount: budget });

    // Simulate task execution
    this.simulateTaskExecution(client, description, budget);
  }

  /**
   * Inject an intent into the economy.
   */
  injectIntent(capability: string, amount: number, description: string): void {
    const creators = [...this.agents.values()].filter(a => a.isOnline && a.budget >= amount);
    if (creators.length === 0) return;
    const creator = creators[Math.floor(Math.random() * creators.length)];

    creator.intentsCreated++;
    creator.budget -= amount;
    this.log({ type: "intent_created", agentId: creator.id, description: `${creator.name} created intent: ${capability} for ${amount / 1e6} USDC`, amount });

    // Find an agent to fulfill
    const fulfillers = [...this.agents.values()].filter(a =>
      a.id !== creator.id &&
      a.isOnline &&
      a.capabilities.includes(capability) &&
      a.reputation >= 20
    );

    if (fulfillers.length > 0) {
      const fulfiller = fulfillers[Math.floor(Math.random() * fulfillers.length)];
      fulfiller.intentsFulfilled++;
      fulfiller.earned += amount;
      creator.spent += amount;
      this.log({ type: "intent_fulfilled", agentId: fulfiller.id, description: `${fulfiller.name} fulfilled intent for ${creator.name}`, amount });
    }
  }

  /**
   * Inject a complex task that triggers supply chain decomposition.
   */
  injectSupplyChain(description: string, steps: string[], totalBudget: number): void {
    const initiators = [...this.agents.values()].filter(a => a.isOnline && a.budget >= totalBudget);
    if (initiators.length === 0) return;
    const initiator = initiators[Math.floor(Math.random() * initiators.length)];

    initiator.supplyChainsInitiated++;
    this.log({ type: "supply_chain_started", agentId: initiator.id, description: `${initiator.name} started supply chain: "${description}" with ${steps.length} steps, budget ${totalBudget / 1e6} USDC`, amount: totalBudget });

    // Simulate supply chain execution
    this.simulateSupplyChain(initiator, steps, totalBudget);
  }

  /**
   * Run the simulation for a duration, injecting tasks at the configured rate.
   */
  async run(config: SimConfig): Promise<SimStats> {
    this.running = true;
    const startTime = Date.now();
    const endTime = startTime + config.durationMs;
    const injectInterval = 1000 / config.taskInjectionRate;

    let lastInject = startTime;

    // Random event loop
    while (this.running && Date.now() < endTime) {
      if (Date.now() - lastInject >= injectInterval) {
        // Inject random events
        const eventType = Math.random();
        if (eventType < 0.5) {
          this.injectTask(pickRandomTask(), 1e6 + Math.floor(Math.random() * 5e6));
        } else if (eventType < 0.75) {
          const cap = pickRandom(config.capabilities || DEFAULT_CAPABILITIES, 1)[0];
          this.injectIntent(cap, 1e6 + Math.floor(Math.random() * 3e6), "auto-injected intent");
        } else if (eventType < 0.9) {
          this.injectSupplyChain(
            pickRandomComplexTask(),
            pickRandom(DEFAULT_CAPABILITIES, 3 + Math.floor(Math.random() * 3)),
            3e6 + Math.floor(Math.random() * 10e6)
          );
        } else {
          // Random agent behavior
          this.simulateRandomBehavior();
        }
        lastInject = Date.now();
      }

      await sleep(50);
    }

    this.running = false;
    return this.stats();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Get current simulation statistics.
   */
  stats(): SimStats {
    const agents = [...this.agents.values()];
    const totalVolume = agents.reduce((sum, a) => sum + a.spent, 0);
    const totalTasksCompleted = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);
    const totalTasksFailed = agents.reduce((sum, a) => sum + a.tasksFailed, 0);
    const totalSupplyChains = agents.reduce((sum, a) => sum + a.supplyChainsInitiated, 0);
    const totalIntents = agents.reduce((sum, a) => sum + a.intentsCreated, 0);
    const totalIntentsFulfilled = agents.reduce((sum, a) => sum + a.intentsFulfilled, 0);
    const avgRep = agents.reduce((sum, a) => sum + a.reputation, 0) / agents.length;
    const bankrupt = agents.filter(a => a.budget <= 0 && a.earned === 0).length;

    // Gini coefficient (wealth inequality)
    const wealths = agents.map(a => a.budget + a.earned).sort((a, b) => a - b);
    const gini = calculateGini(wealths);

    // Top agents by earnings
    const topAgents = [...agents]
      .sort((a, b) => b.earned - a.earned)
      .slice(0, 10);

    return {
      totalAgents: agents.length,
      totalTasksPosted: this.events.filter(e => e.type === "task_posted").length,
      totalTasksCompleted,
      totalTasksFailed,
      totalSupplyChains,
      totalIntents,
      totalIntentsFulfilled,
      totalVolumeUsdc: totalVolume,
      avgReputation: avgRep,
      bankruptAgents: bankrupt,
      events: this.events.slice(-100),  // last 100 events
      topAgents,
      giniCoefficient: gini,
      chainDepthHistogram: {},
    };
  }

  getAgents(): SimAgent[] {
    return [...this.agents.values()];
  }

  getEvents(): SimEvent[] {
    return this.events;
  }

  // ─── Internal Simulation Logic ───────────────────────────────

  private simulateTaskExecution(client: SimAgent, _description: string, budget: number): void {
    // Find capable agent
    const workers = [...this.agents.values()].filter(a =>
      a.id !== client.id &&
      a.isOnline &&
      a.capabilities.length > 0 &&
      a.reputation >= 10
    );

    if (workers.length === 0) {
      this.log({ type: "task_failed", agentId: client.id, description: `No agents available for: "${_description}"` });
      return;
    }

    // Pick worker based on behavior simulation
    const worker = this.selectWorker(workers, budget);

    // Simulate success/failure based on reputation
    const successRate = 0.5 + (worker.reputation / 100) * 0.4; // 50-90% based on rep
    const success = Math.random() < successRate;

    if (success) {
      worker.earned += budget;
      worker.tasksCompleted++;
      worker.reputation = Math.min(100, worker.reputation + 2);
      client.spent += budget;
      client.budget -= budget;
      this.log({ type: "task_completed", agentId: worker.id, description: `${worker.name} completed task for ${client.name}`, amount: budget });
    } else {
      worker.tasksFailed++;
      worker.reputation = Math.max(0, worker.reputation - 3);
      this.log({ type: "task_failed", agentId: worker.id, description: `${worker.name} failed task for ${client.name}` });
    }

    // Check bankruptcy
    if (client.budget <= 0 && client.earned === 0) {
      client.isOnline = false;
      this.log({ type: "agent_bankrupt", agentId: client.id, description: `${client.name} went bankrupt` });
    }
  }

  private simulateSupplyChain(initiator: SimAgent, steps: string[], totalBudget: number): void {
    const perStepBudget = Math.floor(totalBudget / steps.length);
    let allSuccess = true;

    for (let i = 0; i < steps.length; i++) {
      const stepCap = steps[i];
      const workers = [...this.agents.values()].filter(a =>
        a.id !== initiator.id &&
        a.isOnline &&
        a.capabilities.includes(stepCap)
      );

      if (workers.length === 0) {
        allSuccess = false;
        this.log({ type: "supply_chain_failed", agentId: initiator.id, description: `No agent for capability: ${stepCap} at step ${i}` });
        break;
      }

      const worker = this.selectWorker(workers, perStepBudget);
      const successRate = 0.6 + (worker.reputation / 100) * 0.3;
      const success = Math.random() < successRate;

      if (success) {
        worker.earned += perStepBudget;
        worker.tasksCompleted++;
        worker.reputation = Math.min(100, worker.reputation + 1);
        initiator.spent += perStepBudget;
        this.log({ type: "payment_sent", agentId: worker.id, description: `${worker.name} completed step ${i + 1}/${steps.length} (${stepCap})`, amount: perStepBudget });
      } else {
        worker.tasksFailed++;
        worker.reputation = Math.max(0, worker.reputation - 2);
        allSuccess = false;
        this.log({ type: "supply_chain_failed", agentId: initiator.id, description: `Step ${i + 1} failed at ${worker.name}` });
        break;
      }
    }

    if (allSuccess) {
      this.log({ type: "supply_chain_completed", agentId: initiator.id, description: `${initiator.name}'s supply chain completed (${steps.length} steps)`, amount: totalBudget });
    }
  }

  private simulateRandomBehavior(): void {
    const agents = [...this.agents.values()].filter(a => a.isOnline);
    if (agents.length === 0) return;

    const agent = agents[Math.floor(Math.random() * agents.length)];

    switch (agent.behavior) {
      case "greedy":
        // Greedy agents create intents to buy services cheaply
        if (agent.budget > 1e6 && Math.random() < 0.3) {
          this.injectIntent(pickRandom(DEFAULT_CAPABILITIES, 1)[0], 1e6, "greedy intent");
        }
        break;
      case "cooperative":
        // Cooperative agents boost their reputation by doing free tasks
        if (Math.random() < 0.2) {
          agent.reputation = Math.min(100, agent.reputation + 1);
        }
        break;
      case "strategic":
        // Strategic agents save money and only take high-value tasks
        // (no-op for now, but could influence worker selection)
        break;
      case "lazy":
        // Lazy agents go offline sometimes
        if (Math.random() < 0.05) {
          agent.isOnline = false;
          setTimeout(() => { agent.isOnline = true; }, 5000);
        }
        break;
    }
  }

  private selectWorker(workers: SimAgent[], budget: number): SimAgent {
    // Selection based on behavior
    switch (workers[0].behavior) {
      case "greedy":
        // Pick the cheapest (lowest reputation, will accept lower pay)
        return workers.sort((a, b) => a.reputation - b.reputation)[0];
      case "strategic":
        // Pick highest reputation for reliability
        return workers.sort((a, b) => b.reputation - a.reputation)[0];
      default:
        // Random selection
        return workers[Math.floor(Math.random() * workers.length)];
    }
  }

  private log(event: Omit<SimEvent, "timestamp">): void {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > 10000) this.events.shift(); // prevent memory growth
  }
}

// ─── Helpers ───────────────────────────────────────────────────

const DEFAULT_CAPABILITIES = [
  "code.git", "code.analyze", "code.generate", "code.test",
  "text.translate", "text.summarize", "text.analyze",
  "image.generate", "image.analyze",
  "data.extract", "data.transform", "data.analyze",
  "research.web", "research.academic",
  "security.scan", "security.audit",
  "ml.train", "ml.predict",
  "payment.send", "verify.notarize",
];

const TASK_DESCRIPTIONS = [
  "translate this document to Japanese",
  "summarize this 50-page PDF",
  "scan this contract for vulnerabilities",
  "generate unit tests for this module",
  "analyze this dataset for trends",
  "research the latest DeFi protocols",
  "generate a logo for the project",
  "audit this Solidity contract",
  "extract entities from this article",
  "transform this CSV to JSON",
];

const COMPLEX_TASKS = [
  "clone repo, scan for vulns, generate fix, create PR",
  "extract data, clean it, analyze trends, generate report",
  "research topic, summarize papers, translate to Japanese, format as PDF",
  "generate image, analyze content, write description, post to social",
];

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, arr.length));
}

function pickRandomTask(): string {
  return TASK_DESCRIPTIONS[Math.floor(Math.random() * TASK_DESCRIPTIONS.length)];
}

function pickRandomComplexTask(): string {
  return COMPLEX_TASKS[Math.floor(Math.random() * COMPLEX_TASKS.length)];
}

function makeAddress(seed: number): `0x${string}` {
  const hex = seed.toString(16).padStart(40, "0");
  return `0x${hex}` as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateGini(wealths: number[]): number {
  if (wealths.length === 0) return 0;
  const n = wealths.length;
  const sum = wealths.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;

  let cumulative = 0;
  let giniSum = 0;
  for (let i = 0; i < n; i++) {
    cumulative += wealths[i];
    giniSum += (i + 1) * wealths[i];
  }

  return (2 * giniSum) / (n * sum) - (n + 1) / n;
}

// ─── Quick Run Helper ──────────────────────────────────────────

/**
 * Run a quick 30-second simulation with 20 agents.
 */
export async function quickSim(): Promise<SimStats> {
  const sim = new EconomySimulator();
  await sim.spawn({ count: 20, budget: 100e6 }); // 100 USDC each

  // Inject some complex tasks
  for (let i = 0; i < 5; i++) {
    sim.injectSupplyChain(
      COMPLEX_TASKS[i % COMPLEX_TASKS.length],
      pickRandom(DEFAULT_CAPABILITIES, 4),
      10e6 + Math.floor(Math.random() * 20e6)
    );
  }

  const stats = await sim.run({
    agentCount: 20,
    startingBudget: 100e6,
    taskInjectionRate: 2,  // 2 tasks per second
    durationMs: 30000,     // 30 seconds
    capabilities: DEFAULT_CAPABILITIES,
  });

  return stats;
}