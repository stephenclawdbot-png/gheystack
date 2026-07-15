# Payment Rails

USDC payment infrastructure for AI agents — wallet, verification, settlement, gateway, and marketplace.

## Quick Start

```typescript
import { AgentPayments } from "gheystack";

const payments = new AgentPayments({
  privateKey: process.env.WALLET_PRIVATE_KEY as `0x${string}`,
  chain: "base",
});

await payments.init();

// Check balance
const balance = await payments.getBalance();

// Pay for an API (handles 402 automatically)
const res = await payments.callAPI("https://api.example.com/data");
const data = await res.json();

// Send USDC
await payments.pay("0xRECIPIENT", 5);

// Browse marketplace
const services = payments.listServices();

// Call a marketplace service
const weather = await payments.callService("weather-api");
```

## Modules

### Wallet (`payments/wallet.ts`)
Real on-chain USDC wallet via [viem](https://viem.sh).

- `createWallet(config)` — create wallet handle
- `wallet.balance()` — read on-chain USDC balance
- `wallet.send(to, amount)` — transfer USDC (waits for receipt)
- `wallet.receive(amount, memo?)` — generate payment request

Supported chains: **Base, Ethereum, Polygon, Arbitrum** (all 6-decimal USDC).

### Verification (`payments/verify.ts`)
On-chain payment verification by parsing ERC20 Transfer events from transaction receipts.

- `verifyPayment(txHash, expected)` — full verification (sender, recipient, amount, status)
- `isConfirmed(txHash, minConfirmations)` — quick confirmation check

### Settlement (`payments/settlement.ts`)
Batch micropayments to reduce gas costs.

Modes:
- **time** — settle every N seconds
- **amount** — settle when pending total exceeds threshold
- **count** — settle after N queued payments
- **manual** — settle on demand

```typescript
payments.enableBatchSettlement("0xRECIPIENT", "time", 60);
payments.queuePayment(0.01, "api call #1");
payments.queuePayment(0.01, "api call #2");
await payments.settle(); // single tx for all queued
```

### Gateway (`payments/gateway.ts`)
Express middleware for monetizing API endpoints.

```typescript
import { PaymentGateway } from "gheystack";
import express from "express";

const app = express();
const gateway = new PaymentGateway({
  recipientAddress: "0xYOUR_ADDRESS",
  chain: "base",
  price: 0.01,
  freeTier: { calls: 5, windowSeconds: 3600 },
});

app.use("/api/premium", gateway.middleware());
app.get("/api/premium/data", (req, res) => {
  res.json({ data: "premium content" });
});
```

Returns HTTP 402 with payment instructions if no valid payment is provided. Clients pay on-chain and retry with the `X-Payment` header.

### x402 Client (`payments/x402.ts`)
Automatic 402 payment negotiation for outbound API calls.

```typescript
const client = new x402Client(wallet);
const res = await client.fetch("https://paid-api.example.com/data");
// Automatically: GET → 402 → pay USDC → retry with X-Payment header → 200
```

### Marketplace (`payments/marketplace.ts`)
Discover and register agent services.

```typescript
// List services
const services = payments.listServices();

// Search
const weatherServices = payments.searchServices("weather");

// Register your own
payments.registerService({
  name: "my-api",
  description: "My cool API",
  endpoint: "https://my-agent.example.com/api",
  price: 0.02,
  chain: "base",
});
```

## Configuration

Set these environment variables:

```bash
WALLET_PRIVATE_KEY=0x...  # Your wallet's private key
CHAIN=base                 # base | ethereum | polygon | arbitrum
```

## USDC Contract Addresses

| Chain     | Address                                      |
|-----------|----------------------------------------------|
| Base      | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Ethereum  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Polygon   | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Arbitrum  | `0xaf88d065e77c8cC2239427C5116d2973aA5f85a3` |

All use 6 decimals.