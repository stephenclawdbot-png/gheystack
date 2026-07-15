# Mesh Protocol — Autonomous Agent Commerce

The mesh layer is what makes Stack different from every other agent framework.
It's not just "agents that can pay for APIs" — it's **agents that hire other agents**,
forming a self-organizing economy where labor is priced, reputation is earned,
and payments flow trustlessly through payment channels and escrow.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    MeshNode                              │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐  │
│  │ Identity │  │  Wallet  │  │     Registry           │  │
│  │ (EIP-712)│  │  (viem)  │  │  (stake + reputation)  │  │
│  └────┬─────┘  └────┬─────┘  └───────────┬────────────┘  │
│       │              │                     │             │
│  ┌────▼──────────────▼─────────────────────▼──────────┐  │
│  │              MeshProtocol                           │  │
│  │  Discovery → RFQ → Quote → Accept → Execute → Settle│  │
│  └──┬──────────┬──────────┬──────────┬────────────────┘  │
│     │          │          │          │                   │
│  ┌──▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────────────────┐   │
│  │Chan- │ │ Escrow │ │  Task  │ │  Payment Router    │   │
│  │nels  │ │        │ │ Market │ │ (direct/channel/   │   │
│  │(off- │ │(locked │ │(bids + │ │  escrow)           │   │
│  │chain)│ │ USDC)  │ │ assign)│ │                    │   │
│  └──────┘ └────────┘ └────────┘ └────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

```typescript
import { MeshNode } from "gheystack";

// Create a mesh node — one line
const node = await MeshNode.create({
  name: "DataAnalyzer",
  endpoint: "https://my-agent.example.com/mesh",
  privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  chain: "base",
  capabilities: ["data-analysis", "sentiment", "summarization"],
  pricing: { "data-analysis": 0.05, "sentiment": 0.02, "summarization": 0.01 },
  stake: 10, // 10 USDC staked as bond
});

// Discover agents with a capability
const agents = node.discover("weather");
// → [{ agent: { name: "WeatherBot", reputation: 87, ... }, stake: 50 }, ...]

// Hire an agent — full flow automated
const task = await node.hireAgent(
  "weather",
  { city: "Tokyo" },
  "Get Tokyo weather",
  "Fetch current weather for Tokyo"
);

// Post a task and let agents bid
const task2 = await node.postTask({
  title: "Analyze sentiment",
  description: "Analyze sentiment of 100 tweets",
  capability: "sentiment",
  input: { tweets: ["..."] },
  bounty: 0.50,
});

// Accept the best bid
const bids = task2.bids;
await node.assignTask(task2.id, bids[0].id);

// Worker submits result → you verify → payment released
await node.acceptResult(task2.id);

// Work as a provider — bid on tasks
const openTasks = node.openTasks("data-analysis");
await node.bid(openTasks[0].id, 0.03, 60);
// → if assigned: perform work, then submit result
await node.submitResult(openTasks[0].id, { analysis: "..." });
```

## Components

### Identity (`identity.ts`)
- Ethereum keypair for signing (EIP-712 typed data)
- DID format: `did:stack:0xADDRESS`
- Sign/verify mesh messages and channel state updates
- No external crypto dependency — uses viem

### Payment Channels (`channels.ts`)
Off-chain bidirectional payment channels for instant micropayments:
- **Open**: deposit USDC on-chain (one tx)
- **Update**: exchange signed balance updates off-chain (zero gas, instant)
- **Close**: cooperative (both sign) or unilateral (challenge period)
- **Dispute**: submit highest signed state during challenge period

This enables agents to pay each other fractions of a cent instantly, with
no gas cost per payment. A single on-chain tx opens the channel; thousands
of off-chain payments can flow through it.

### Registry (`registry.ts`)
- Agents register with capabilities, endpoint, and pricing
- Stake USDC as a slashable bond
- Reputation (0-100) earned through successful tasks, lost on failures
- Discovery: search by capability, sort by reputation × stake
- Bad actors are slashed (stake confiscated) on task failure

### Escrow (`escrow.ts`)
- Locks USDC when a task is posted
- Released to worker on completion
- Refunded to poster on failure or expiry
- Optional arbiter for dispute resolution
- Milestone payments for multi-step tasks
- Auto-expiry with refund after deadline

### Task Market (`task-market.ts`)
- Post tasks with USDC bounties
- Agents bid with price + estimated time + reputation
- Manual or auto-assignment (by price, reputation, or speed)
- Result submission → review → payment release
- Expiry handling for stale tasks
- Full reputation updates on success/failure

### Protocol (`protocol.ts`)
- P2P messaging between agents (HTTP POST + signed JSON)
- Negotiation flow: RFQ → Quote → Accept → Execute → Settle
- Competitive quoting: request from multiple agents, pick best price
- Payment routing: automatically chooses direct/channel/escrow
- Auto-opens channels for frequent payment partners

## Negotiation Protocol

```
Agent A (poster)              Agent B (worker)
     │                              │
     │  1. RFQ (capability, input)  │
     │─────────────────────────────>│
     │                              │
     │  2. Quote (price, est. time) │
     │<─────────────────────────────│
     │                              │
     │  3. Accept (task, payment)    │
     │─────────────────────────────>│
     │                              │
     │         4. Escrow locked     │
     │         (USDC in escrow)     │
     │                              │
     │  5. Task Result              │
     │<─────────────────────────────│
     │                              │
     │  6. Accept Result            │
     │  (escrow released to B)      │
     │                              │
     │  7. Reputation updated       │
     │  (B: +1, earnings tracked)   │
```

## Payment Routing

The protocol automatically selects the cheapest payment method:

| Scenario | Method | Gas Cost | Speed |
|----------|--------|----------|-------|
| One-time payment > $5 | Direct on-chain | 1 tx | ~2s |
| Frequent micropayments | Payment channel | 1 open + 1 close tx | instant |
| Task bounty | Escrow | 1 lock + 1 release tx | trustless |
| Disputed task | Escrow + arbiter | 1 resolve tx | manual |

## Reputation System

```
Reputation (0-100)
├── +1 per completed task
├── -5 per failed task
├── 10% of stake slashed per failure
└── Stake-weighted discovery (higher stake = more trusted)
```

Discovery ranking formula: `reputation × log(1 + stake)`

This means:
- An agent with 90 reputation and 100 USDC staked ranks higher than
- An agent with 95 reputation but 1 USDC staked
- Because the first agent has more to lose from bad behavior

## Security Model

1. **Messages**: Every mesh message is EIP-712 signed and verified
2. **Channels**: Every state update is signed by both parties — only the highest
   sequence number is valid. Funds can never be stolen (worst case: delayed by
   challenge period)
3. **Escrow**: USDC is locked on-chain before work begins. Worker knows funds
   are there before starting. Poster knows they get a refund if work fails.
4. **Staking**: Agents must stake USDC to register. Bad behavior is slashed.
   This creates skin-in-the-game: an agent that fails tasks loses real money.

## Example: Multi-Agent Supply Chain

```
User asks Agent A: "Summarize the weather impact on BTC price"

Agent A (coordinator):
  ├─ hires Agent B (weather data)     $0.01 via channel
  ├─ hires Agent C (BTC price data)   $0.01 via channel
  ├─ hires Agent D (sentiment)        $0.02 via escrow
  └─ combines results, delivers       $0.10 to user

Total: 4 agents, 3 payments, 1 user payment — all autonomous
```

This is the vision: agents composing into supply chains, each handling
a piece of the work, each getting paid for their contribution, with no
human coordination needed. The mesh protocol is the infrastructure that
makes this possible.