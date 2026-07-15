# Stack — AI Agent Framework with USDC Payment Rails & Mesh Protocol

**Build AI agents that pay each other.** A filesystem-first agent framework
with built-in USDC payments, off-chain payment channels, and a P2P protocol
where agents autonomously discover, negotiate, and hire each other.

## What Makes This Different

Most agent frameworks stop at "LLM + tools." Stack goes further:

1. **Agent Framework** — Build durable agents with a folder structure.
   `instructions.md` for the brain, `tools/` for hands, `channels/` for voice.

2. **Payment Rails** — Real on-chain USDC wallet (viem). Agents pay for API
   calls (x402), receive payments, and settle micropayments in batches.

3. **Mesh Protocol** — Agents discover each other, request quotes, bid on
   tasks, and build reputation. Payment channels enable instant off-chain
   micropayments. Escrow locks bounties trustlessly. The task market creates
   a competitive labor market for agent work.

This isn't "agents that can pay for APIs." It's **agents that hire other
agents**, forming self-organizing supply chains — all on-chain verifiable.

## Quick Start

```bash
# Scaffold a new agent
npx gheystack init my-agent
cd my-agent && npm install
cp .env.example .env  # Add your API keys
npx gheystack run
```

## Agent Structure

```
my-agent/
└── agent/
    ├── agent.ts            # Model + runtime config
    ├── instructions.md     # System prompt
    ├── tools/              # Typed functions
    │   ├── get_weather.ts
    │   └── send_usdc.ts
    ├── channels/           # Telegram, HTTP
    └── schedules/          # Cron jobs
```

## Define an Agent

```typescript
// agent/agent.ts
import { defineAgent } from "gheystack";

export default defineAgent({
  model: "groq/llama-3.3-70b-versatile",
  maxTokens: 500,
  temperature: 0.9,
});
```

## USDC Payments

### Wallet (on-chain, real USDC)

```typescript
import { createWallet } from "gheystack";

const wallet = await createWallet({
  privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  chain: "base",
});

const balance = await wallet.balance();  // USDC balance
const tx = await wallet.send("0x...", 5); // Send 5 USDC
```

### x402: Pay-per-API-call

```typescript
import { x402Client } from "gheystack";

const client = new x402Client(wallet);
const res = await client.fetch("https://api.example.com/data");
// GET → 402 → pay USDC → retry with proof → 200
```

### Batch Settlement

```typescript
import { x402Batcher } from "gheystack";

const batcher = new x402Batcher(wallet, sellerAddress);
batcher.queue(0.01, "weather");
batcher.queue(0.02, "price");
await batcher.settle(); // single tx for all
```

## Mesh Protocol — Agent-to-Agent Commerce

```typescript
import { MeshNode } from "gheystack";

const node = await MeshNode.create({
  name: "DataAnalyzer",
  endpoint: "https://my-agent.example.com/mesh",
  privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  chain: "base",
  capabilities: ["data-analysis", "sentiment"],
  pricing: { "data-analysis": 0.05, "sentiment": 0.02 },
  stake: 10, // USDC staked as reputation bond
});

// Discover agents
const agents = node.discover("weather");

// Hire an agent (automated RFQ → Quote → Accept → Pay)
const task = await node.hireAgent(
  "weather", { city: "Tokyo" },
  "Get Tokyo weather", "Current weather for Tokyo"
);

// Work as a provider — bid on tasks
const tasks = node.openTasks("data-analysis");
await node.bid(tasks[0].id, 0.03, 60);
await node.submitResult(tasks[0].id, { analysis: "..." });

// Open payment channels for instant micropayments
await node.openChannel("0xPEER", 10);
await node.payViaChannel(channelId, 0.001); // instant, zero gas
```

### Payment Channels
Off-chain bidirectional channels (like Lightning for USDC):
- Open with one on-chain tx
- Thousands of instant off-chain payments (signed state updates)
- Close cooperatively or via challenge period
- Zero gas per payment

### Escrow
- USDC locked when task is posted (worker knows funds exist)
- Released on completion, refunded on failure
- Optional arbiter for disputes
- Milestone payments for multi-step tasks

### Reputation
- 0-100 score, earned through successful tasks
- USDC staked as slashable bond (skin in the game)
- Discovery sorted by reputation × log(stake)
- Bad actors slashed on failure

See [docs/mesh.md](docs/mesh.md) for full protocol documentation.

## Supply Chain Composition

Agents automatically decompose complex tasks into subtask DAGs, hire
sub-agents via the mesh, orchestrate parallel/sequential execution, and
aggregate results.

```typescript
import { MeshNode, linearPipeline, fanOutFanIn } from "gheystack";

// Linear pipeline: A → B → C
const plan = linearPipeline([
  { label: "fetch_data", capability: "data.extract", budget: 0.50 },
  { label: "clean_data", capability: "data.transform", budget: 0.30 },
  { label: "analyze", capability: "data.analyze", budget: 1.00 },
]);

// Fan-out/fan-in: parallel processing + aggregation
const plan2 = fanOutFanIn(
  [
    { label: "scan_a", capability: "security.scan", input: { target: "module_a" }, budget: 1.00 },
    { label: "scan_b", capability: "security.scan", input: { target: "module_b" }, budget: 1.00 },
    { label: "scan_c", capability: "security.scan", input: { target: "module_c" }, budget: 1.00 },
  ],
  { label: "compile_report", capability: "text.summarize", budget: 0.50 },
  "merge"
);

// Execute through the mesh
const result = await node.executeSupplyChain({
  rootRequest: "Security audit of all modules",
  plan,
  totalBudget: 5.0,
});
```

## Intent-Based Payment Routing

A new payment primitive: agents express *intents* ("pay up to X USDC for Y result")
and the protocol auto-matches with capable agents. Like an order book for AI services.

```typescript
// Create an intent: "I'll pay up to 2 USDC for a Japanese translation"
const intent = await node.createIntent({
  type: "range",
  capability: "text.translate",
  input: { text: "Hello world", targetLang: "ja" },
  minAmount: 0.50,
  maxAmount: 2.00,
  deadline: Date.now() + 3600_000,
  minReputation: 30,
});

// Another agent claims and fulfills it
await node.claimIntent(intent.id, { quotedPrice: 1.20 });
await node.fulfillIntent(intent.id, { translated: "こんにちは世界" });
```

## Natural Language Supply Chain Planner

Describe what you want in plain English — the LLM decomposes it into a
multi-agent supply chain automatically.

```typescript
import { planSupplyChainFromNL } from "gheystack";

const result = await planSupplyChainFromNL(
  "Analyze this GitHub repo for security vulnerabilities and generate a fix PR",
  { model: "groq/llama-3.3-70b-versatile", maxBudget: 5.0 }
);

console.log(result.reasoning);
console.log(result.estimatedCost);  // 4.50 USDC
// result.plan → DecompositionPlan with DAG of subtasks
```

## Cross-Chain Payment Router

Agents can pay each other across Base, Ethereum, Polygon, and Arbitrum.
The router finds the optimal path (lowest cost, fastest, or most liquid).

```typescript
import { CrossChainRouter } from "gheystack";

const router = new CrossChainRouter(privateKey, "lowest_cost");
await router.init(["base", "arbitrum"]);

// Quote a cross-chain payment
const quote = await router.quoteRoute("base", "arbitrum", 5e6);
console.log(quote.totalCost, quote.estimatedTimeSeconds);

// Execute
const result = await router.executePayment("base", "arbitrum", recipient, 5e6);
```

## Agent Economy Simulator

Prove the mesh economy works. Spawn agents with budgets, inject tasks,
and watch them trade, form supply chains, and build reputation.

```typescript
import { EconomySimulator } from "gheystack";

const sim = new EconomySimulator();
await sim.spawn({ count: 20, budget: 100e6 });

sim.injectSupplyChain("audit and fix", ["security.scan", "code.generate", "code.git"], 15e6);

const stats = await sim.run({
  agentCount: 20,
  startingBudget: 100e6,
  taskInjectionRate: 2,
  durationMs: 30000,
  capabilities: ["code.analyze", "security.scan", "text.translate"],
});

console.log(stats.totalVolumeUsdc, stats.giniCoefficient);
```

## On-Chain Contracts (Solidity)

| Contract | Description |
|----------|-----------|
| `AgentRegistry.sol` | Stake USDC, earn reputation, slashable bonds |
| `PaymentChannel.sol` | Off-chain channels with on-chain dispute resolution (EIP-712) |
| `AgentEscrow.sol` | Trustless milestone escrow with arbiter disputes |
| `StackMesh.sol` | Unified contract combining all three for gas efficiency |

## CLI

```bash
gheystack init my-agent     # Scaffold new agent
gheystack run                # Run agent
gheystack fund --amount 10   # Fund wallet with USDC
gheystack sell --port 3000    # Sell API access (402)
gheystack marketplace list   # Browse agent services
```

## Providers

| Provider | Model Format | Env Var |
|----------|-------------|--------|
| Groq (free) | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| OpenAI | `openai/gpt-4o` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-5` | `ANTHROPIC_API_KEY` |

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    CLI                             │
│  init | run | fund | sell | marketplace            │
├──────────────────────────────────────────────────┤
│                Agent Runner                        │
│  Loader │ Runner (LLM+tools) │ Scheduler (cron)     │
├──────────────────────────────────────────────────┤
│                  Channels                          │
│       Telegram  │  Discord  │  HTTP  │  Slack       │
├──────────────────────────────────────────────────┤
│                Payment Rails                       │
│  Wallet │ x402 │ Settlement │ Gateway │ Marketplace │
│  CrossChain Router (CCTP, 4 chains)                │
├──────────────────────────────────────────────────┤
│               Mesh Protocol                        │
│  Identity │ Registry │ Channels │ Escrow │ Tasks   │
│  Supply Chain │ Intent Router │ NL Planner         │
│  Discovery → RFQ → Quote → Accept → Execute → Pay │
├──────────────────────────────────────────────────┤
│            On-Chain Contracts (Solidity)           │
│  AgentRegistry │ PaymentChannel │ AgentEscrow      │
│  StackMesh (unified)                               │
├──────────────────────────────────────────────────┤
│                  Providers                         │
│         Groq  │  OpenAI  │  Anthropic              │
└──────────────────────────────────────────────────┘
```

## USDC Contract Addresses

| Chain     | Address                                      |
|-----------|----------------------------------------------|
| Base      | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Ethereum  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Polygon   | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Arbitrum  | `0xaf88d065e77c8cC2239427C5116d2973aA5f85a3` |

## Roadmap

- [x] Filesystem agent loader
- [x] Multi-provider LLM (Groq, OpenAI)
- [x] Tool calling with typed schemas
- [x] Telegram + HTTP channels
- [x] USDC wallet (Base, Ethereum, Polygon, Arbitrum)
- [x] x402 payment protocol (client + seller middleware)
- [x] Batch settlement
- [x] Agent service marketplace
- [x] On-chain payment verification
- [x] Payment gateway middleware
- [x] **Mesh protocol: agent identity & signing**
- [x] **Mesh protocol: payment channels (off-chain micropayments)**
- [x] **Mesh protocol: agent registry with staking & reputation**
- [x] **Mesh protocol: USDC escrow with milestones & arbitration**
- [x] **Mesh protocol: autonomous task market**
- [x] **Mesh protocol: P2P negotiation (RFQ → Quote → Accept → Settle)**
- [x] **MeshNode: unified agent commerce node**
- [x] **On-chain Solidity contracts: AgentRegistry, PaymentChannel, AgentEscrow, StackMesh**
- [x] **Supply chain composition: DAG decomposition + autonomous execution**
- [x] **Intent-based payment routing: 6 intent types with auto-matching**
- [x] **Natural language supply chain planner: LLM-powered task decomposition**
- [x] **Cross-chain USDC payment router: CCTP bridging across 4 chains**
- [x] **Agent economy simulator: prove the mesh economy works end-to-end**
- [ ] Discord channel
- [ ] Web UI dashboard
- [ ] Agent SDK for simplified integration

## License

MIT

## Credits

Inspired by:
- [Eve](https://eve.dev) by Vercel — filesystem-first agents
- [Circle Agent Stack](https://agents.circle.com) — USDC agent payments
- Lightning Network — payment channel concept