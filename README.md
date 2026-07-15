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
├──────────────────────────────────────────────────┤
│               Mesh Protocol                        │
│  Identity │ Registry │ Channels │ Escrow │ Tasks   │
│  Discovery → RFQ → Quote → Accept → Execute → Pay │
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
- [ ] On-chain channel contract (Solidity)
- [ ] On-chain registry contract (Solidity)
- [ ] On-chain escrow contract (Solidity)
- [ ] Discord channel
- [ ] Web UI dashboard
- [ ] Agent-to-agent supply chain composition

## License

MIT

## Credits

Inspired by:
- [Eve](https://eve.dev) by Vercel — filesystem-first agents
- [Circle Agent Stack](https://agents.circle.com) — USDC agent payments
- Lightning Network — payment channel concept