# 🔥 GheyStack — The Ghey Agent Stack

**Filesystem-first AI agent framework with built-in USDC payment rails.**

Like [Eve](https://eve.dev) (Vercel's agent framework) + [Circle's Agent Stack](https://agents.circle.com) had a fabulous baby. 💅🌈

## What is GheyStack?

GheyStack combines two powerful concepts:

1. **Agent Framework** — Build durable AI agents using a simple folder structure. No boilerplate, no config files, just conventions. Define your agent's brain in `instructions.md`, its hands in `tools/`, its voice in `channels/`, and its routine in `schedules/`.

2. **Payment Rails** — Give your agent a USDC wallet. Agents pay for API calls, receive payments for their services, and browse a marketplace of agent-to-agent services. Built on the x402 protocol for HTTP 402 Payment Required negotiation.

## Quick Start

```bash
# Scaffold a new agent
npx gheystack init my-agent

# Navigate and install
cd my-agent
npm install
cp .env.example .env  # Add your API keys

# Run the agent
npx gheystack run
```

## Agent Structure

```
my-agent/
└── agent/
    ├── agent.ts            # Model + runtime config
    ├── instructions.md     # System prompt (always-on)
    ├── tools/              # Typed functions the agent can call
    │   ├── get_weather.ts
    │   ├── get_token_price.ts
    │   └── send_usdc.ts
    ├── skills/             # Procedures loaded on demand (markdown)
    │   └── plan_a_trip.md
    ├── channels/           # Message channels
    │   ├── telegram.ts
    │   └── http.ts
    └── schedules/          # Recurring cron jobs
        └── daily_recap.ts
```

## Define an Agent

```typescript
// agent/agent.ts
import { defineAgent } from "gheystack";

export default defineAgent({
  model: "groq/llama-3.3-70b-versatile",  // or openai/gpt-4o, anthropic/claude-sonnet-5
  maxTokens: 500,
  temperature: 0.9,
});
```

## Define Tools

```typescript
// agent/tools/get_weather.ts
import { defineTool } from "gheystack/tools";

export default defineTool({
  name: "get_weather",
  description: "Get weather data for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  async execute({ city }) {
    return { city, condition: "Sunny ☀️", temperatureF: 72 };
  },
});
```

## USDC Payments

### Fund Your Agent

```bash
gheystack fund ./agent --amount 10 --chain base
```

### Sell API Access (get paid in USDC)

```bash
gheystack sell --port 3000 --price 0.01 --address 0xYOUR_WALLET
```

Agents that call your endpoint get a `402 Payment Required` → pay USDC → get data.

### Agent Pays for Services

```typescript
import { x402Client } from "gheystack";

const client = new x402Client(wallet);
const res = await client.fetch("https://api.example.com/data");
// Automatically handles 402 → pays USDC → retries with proof
```

### Batch Micropayments

```typescript
import { x402Batcher } from "gheystack";

const batcher = new x402Batcher(wallet, sellerAddress);
batcher.queue(0.01, "weather call");
batcher.queue(0.02, "price call");
// Settle all at once
await batcher.settle();
```

### Marketplace

```bash
gheystack marketplace list
```

Browse services agents can discover and purchase:
- `weather-api` — 0.01 USDC/call
- `token-price` — 0.02 USDC/call
- `contract-scanner` — 0.05 USDC/call

## Channels

### Telegram
```bash
gheystack run ./agent --channel telegram
```
Set `TELEGRAM_BOT_TOKEN` in `.env`. The bot polls for messages and responds.

### HTTP
```bash
gheystack run ./agent --channel http
```
Exposes a REST endpoint: `POST /` with `{ "message": "hello" }` → `{ "reply": "..." }`

## Providers

| Provider | Model Format | Env Var |
|----------|-------------|--------|
| Groq (free) | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| OpenAI | `openai/gpt-4o` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-5` | `ANTHROPIC_API_KEY` |

## Example: OvenGI Bot

See `examples/ovengi-bot/` for a full example — the OvenGI Ghey Intelligence Telegram bot built on GheyStack with $GHEY token info tool.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   GheyStack CLI                    │
│  gheystack init | run | fund | sell | marketplace  │
├──────────────────────────────────────────────────┤
│                    Agent Runner                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  Loader   │  │  Runner   │  │   Scheduler      │ │
│  │ (filesystem)│ │ (LLM+tools)│ │  (cron jobs)     │ │
│  └──────────┘  └──────────┘  └──────────────────┘ │
├──────────────────────────────────────────────────┤
│                    Channels                         │
│     Telegram  │  Discord  │  HTTP  │  Slack         │
├──────────────────────────────────────────────────┤
│                  Payment Rails                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  Wallet   │  │  x402    │  │  Marketplace     │ │
│  │ (USDC)    │  │ (pay/call)│ │  (discover svc)  │ │
│  └──────────┘  └──────────┘  └──────────────────┘ │
├──────────────────────────────────────────────────┤
│                    Providers                         │
│       Groq  │  OpenAI  │  Anthropic                 │
└──────────────────────────────────────────────────┘
```

## Roadmap

- [x] Filesystem-based agent loader
- [x] Multi-provider LLM support (Groq, OpenAI)
- [x] Tool calling with typed schemas
- [x] Telegram + HTTP channels
- [x] USDC wallet abstraction (Base, Ethereum, Polygon, Arbitrum)
- [x] x402 payment protocol (client + seller middleware)
- [x] x402 batch settlement
- [x] Agent service marketplace
- [ ] Discord channel
- [ ] Slack channel
- [ ] Anthropic provider
- [ ] On-chain wallet (viem integration)
- [ ] Agent-to-agent negotiation
- [ ] Skill loading on demand
- [ ] Web UI dashboard

## License

MIT — do whatever you want, just be FABULOUS about it 💅

## Credits

Built by [OvenGI](https://github.com/stephenclawdbot-png) — Ghey Intelligence™

Inspired by:
- [Eve](https://eve.dev) by Vercel — filesystem-first agents
- [Circle Agent Stack](https://agents.circle.com) — USDC agent payments