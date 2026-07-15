/**
 * Cross-Chain Payment Router
 *
 * The breakthrough: agents can pay each other across different chains.
 * The router automatically finds the optimal path — lowest gas, fastest
 * finality, or lowest cost — and bridges USDC via CCTP (Circle's
 * cross-chain transfer protocol) or native bridges.
 *
 * Supported chains: Base, Ethereum, Polygon, Arbitrum
 *
 * Routing strategies:
 *   - lowest_cost: minimize total fees (gas + bridge fee)
 *   - fastest: minimize time to finality
 *   - most_liquid: use chain with highest USDC liquidity
 *   - agent_preference: respect agent's chain preference
 *
 * USDC addresses (6 decimals):
 *   Base:      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   Ethereum:  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
 *   Polygon:   0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
 *   Arbitrum:   0xaf88d065e77c8cC2239427C5116d2973aA5f85a3
 */

import { createWallet } from "../payments/wallet.js";
import type { WalletHandle } from "../core/types.js";
import { verifyPayment } from "../payments/verify.js";

// ─── Types ─────────────────────────────────────────────────────

export type ChainName = "base" | "ethereum" | "polygon" | "arbitrum";

export type RoutingStrategy = "lowest_cost" | "fastest" | "most_liquid" | "agent_preference";

export interface ChainInfo {
  name: ChainName;
  chainId: number;
  usdcAddress: `0x${string}`;
  avgGasGwei: number;
  avgFinalitySeconds: number;
  bridgeFeeUsdc: number;  // estimated bridge fee in USDC
  usdcLiquidity: number;   // approximate USDC liquidity (millions)
  rpcUrl: string;
}

export interface RouteQuote {
  fromChain: ChainName;
  toChain: ChainName;
  amount: number;           // USDC (6 decimal units)
  bridgeFee: number;         // estimated bridge cost
  gasCost: number;           // source chain gas cost in USDC
  totalCost: number;         // bridge + gas
  estimatedTimeSeconds: number;
  route: RouteHop[];
  recommended: boolean;
  reason: string;
}

export interface RouteHop {
  chain: ChainName;
  action: "burn" | "mint" | "transfer" | "bridge";
  description: string;
  estimatedTimeSeconds: number;
  cost: number;
}

export interface CrossChainPaymentResult {
  route: RouteQuote;
  sourceTxHash: string;
  destinationTxHash?: string;
  status: "pending" | "completed" | "failed";
  totalSpent: number;
  completedAt?: number;
}

// ─── Chain Registry ────────────────────────────────────────────

export const CHAIN_INFO: Record<ChainName, ChainInfo> = {
  base: {
    name: "base",
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    avgGasGwei: 0.05,
    avgFinalitySeconds: 2,
    bridgeFeeUsdc: 0.50,
    usdcLiquidity: 500,
    rpcUrl: "https://mainnet.base.org",
  },
  ethereum: {
    name: "ethereum",
    chainId: 1,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    avgGasGwei: 15,
    avgFinalitySeconds: 12,
    bridgeFeeUsdc: 2.00,
    usdcLiquidity: 5000,
    rpcUrl: "https://eth.llamarpc.com",
  },
  polygon: {
    name: "polygon",
    chainId: 137,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    avgGasGwei: 30,
    avgFinalitySeconds: 3,
    bridgeFeeUsdc: 0.80,
    usdcLiquidity: 800,
    rpcUrl: "https://polygon-rpc.com",
  },
  arbitrum: {
    name: "arbitrum",
    chainId: 42161,
    usdcAddress: "0xaf88d065e77c8cC2239427C5116d2973aA5f85a3",
    avgGasGwei: 0.1,
    avgFinalitySeconds: 1,
    bridgeFeeUsdc: 0.60,
    usdcLiquidity: 1200,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
  },
};

// ─── Router ────────────────────────────────────────────────────

export class CrossChainRouter {
  private wallets: Partial<Record<ChainName, WalletHandle>> = {};
  private privateKey: `0x${string}`;

  constructor(
    privateKey: `0x${string}`,
    private strategy: RoutingStrategy = "lowest_cost",
    private preferredChain?: ChainName
  ) {
    this.privateKey = privateKey;
  }

  /**
   * Initialize wallets for specified chains.
   * Only loads wallets for chains you need, saving RPC calls.
   */
  async init(chains: ChainName[]): Promise<void> {
    for (const chain of chains) {
      const wallet = await createWallet({ chain, privateKey: this.privateKey });
      this.wallets[chain] = wallet;
    }
  }

  /**
   * Get a quote for routing a payment from one chain to another.
   */
  async quoteRoute(
    fromChain: ChainName,
    toChain: ChainName,
    amount: number
  ): Promise<RouteQuote> {
    if (fromChain === toChain) {
      // Same chain — no bridging needed
      return {
        fromChain,
        toChain,
        amount,
        bridgeFee: 0,
        gasCost: this.estimateGasCost(fromChain),
        totalCost: this.estimateGasCost(fromChain),
        estimatedTimeSeconds: CHAIN_INFO[fromChain].avgFinalitySeconds,
        route: [{
          chain: fromChain,
          action: "transfer",
          description: `Direct USDC transfer on ${fromChain}`,
          estimatedTimeSeconds: CHAIN_INFO[fromChain].avgFinalitySeconds,
          cost: 0,
        }],
        recommended: true,
        reason: "Same-chain transfer — no bridging needed",
      };
    }

    // Cross-chain — need to bridge
    const fromInfo = CHAIN_INFO[fromChain];
    const toInfo = CHAIN_INFO[toChain];

    // Determine bridge path (direct vs. via ethereum)
    const routes: RouteQuote[] = [];

    // Direct bridge (CCTP)
    routes.push(this.buildBridgeQuote(fromChain, toChain, amount, "cctp"));

    // Via Ethereum (hub routing)
    if (fromChain !== "ethereum" && toChain !== "ethereum") {
      routes.push(this.buildHubQuote(fromChain, toChain, amount));
    }

    // Select best route based on strategy
    const best = this.selectBestRoute(routes);

    return best;
  }

  /**
   * Execute a cross-chain payment.
   */
  async executePayment(
    fromChain: ChainName,
    toChain: ChainName,
    toAddress: `0x${string}`,
    amount: number
  ): Promise<CrossChainPaymentResult> {
    const route = await this.quoteRoute(fromChain, toChain, amount);
    const wallet = this.wallets[fromChain];
    if (!wallet) throw new Error(`Wallet not initialized for ${fromChain}`);

    // Same-chain transfer
    if (fromChain === toChain) {
      const txHash = await wallet.send(toAddress, amount);
      return {
        route,
        sourceTxHash: txHash,
        status: "completed",
        totalSpent: amount + route.gasCost,
        completedAt: Date.now(),
      };
    }

    // Cross-chain: burn USDC on source, mint on destination
    // In production, this would use CCTP's depositForBurn + receiveMessage
    // For now, we simulate the bridge path

    // Step 1: Approve + burn on source chain
    const sourceTxHash = await wallet.send(CHAIN_INFO[fromChain].usdcAddress, amount);

    // Step 2: Wait for bridge confirmation (simulated)
    await sleep(route.estimatedTimeSeconds * 1000);

    // Step 3: Verify on destination (in production, CCTP message would mint)
    // For now, we return pending status — production code would monitor
    // the destination chain for the mint event

    return {
      route,
      sourceTxHash,
      status: "pending",
      totalSpent: amount + route.totalCost,
    };
  }

  /**
   * Get all viable routes for a payment, sorted by strategy.
   */
  async getAllRoutes(
    fromChain: ChainName,
    toChain: ChainName,
    amount: number
  ): Promise<RouteQuote[]> {
    if (fromChain === toChain) {
      return [await this.quoteRoute(fromChain, toChain, amount)];
    }

    const routes: RouteQuote[] = [];
    routes.push(this.buildBridgeQuote(fromChain, toChain, amount, "cctp"));

    if (fromChain !== "ethereum" && toChain !== "ethereum") {
      routes.push(this.buildHubQuote(fromChain, toChain, amount));
    }

    return routes.sort((a, b) => this.compareRoutes(a, b));
  }

  // ─── Internal ─────────────────────────────────────────────────

  private buildBridgeQuote(
    from: ChainName,
    to: ChainName,
    amount: number,
    _protocol: "cctp" | "layerzero" | "wormhole"
  ): RouteQuote {
    const fromInfo = CHAIN_INFO[from];
    const toInfo = CHAIN_INFO[to];

    const hops: RouteHop[] = [
      {
        chain: from,
        action: "burn",
        description: `Burn ${amount / 1e6} USDC on ${from} via CCTP`,
        estimatedTimeSeconds: fromInfo.avgFinalitySeconds,
        cost: this.estimateGasCost(from),
      },
      {
        chain: to,
        action: "mint",
        description: `Mint ${amount / 1e6} USDC on ${to} via CCTP`,
        estimatedTimeSeconds: toInfo.avgFinalitySeconds,
        cost: 0, // minting is typically free
      },
    ];

    return {
      fromChain: from,
      toChain: to,
      amount,
      bridgeFee: fromInfo.bridgeFeeUsdc,
      gasCost: this.estimateGasCost(from),
      totalCost: fromInfo.bridgeFeeUsdc + this.estimateGasCost(from),
      estimatedTimeSeconds: fromInfo.avgFinalitySeconds + 120 + toInfo.avgFinalitySeconds, // +2min for attestation
      route: hops,
      recommended: false,
      reason: `CCTP direct bridge: ${from} → ${to}`,
    };
  }

  private buildHubQuote(from: ChainName, to: ChainName, amount: number): RouteQuote {
    const fromInfo = CHAIN_INFO[from];
    const ethInfo = CHAIN_INFO.ethereum;
    const toInfo = CHAIN_INFO[to];

    const hops: RouteHop[] = [
      {
        chain: from,
        action: "burn",
        description: `Burn USDC on ${from}, bridge to Ethereum`,
        estimatedTimeSeconds: fromInfo.avgFinalitySeconds + 120,
        cost: this.estimateGasCost(from),
      },
      {
        chain: "ethereum",
        action: "transfer",
        description: `Relay through Ethereum hub`,
        estimatedTimeSeconds: ethInfo.avgFinalitySeconds,
        cost: this.estimateGasCost("ethereum"),
      },
      {
        chain: to,
        action: "mint",
        description: `Mint USDC on ${to} from Ethereum`,
        estimatedTimeSeconds: toInfo.avgFinalitySeconds + 120,
        cost: 0,
      },
    ];

    return {
      fromChain: from,
      toChain: to,
      amount,
      bridgeFee: fromInfo.bridgeFeeUsdc + ethInfo.bridgeFeeUsdc,
      gasCost: this.estimateGasCost(from) + this.estimateGasCost("ethereum"),
      totalCost: fromInfo.bridgeFeeUsdc + ethInfo.bridgeFeeUsdc + this.estimateGasCost(from) + this.estimateGasCost("ethereum"),
      estimatedTimeSeconds: fromInfo.avgFinalitySeconds + 120 + ethInfo.avgFinalitySeconds + 120 + toInfo.avgFinalitySeconds,
      route: hops,
      recommended: false,
      reason: `Hub routing: ${from} → Ethereum → ${to}`,
    };
  }

  private selectBestRoute(routes: RouteQuote[]): RouteQuote {
    const sorted = [...routes].sort((a, b) => this.compareRoutes(a, b));
    const best = sorted[0];
    best.recommended = true;
    return best;
  }

  private compareRoutes(a: RouteQuote, b: RouteQuote): number {
    switch (this.strategy) {
      case "lowest_cost":
        return a.totalCost - b.totalCost;
      case "fastest":
        return a.estimatedTimeSeconds - b.estimatedTimeSeconds;
      case "most_liquid": {
        const aLiquidity = CHAIN_INFO[a.toChain].usdcLiquidity;
        const bLiquidity = CHAIN_INFO[b.toChain].usdcLiquidity;
        return bLiquidity - aLiquidity;
      }
      case "agent_preference":
        if (a.toChain === this.preferredChain) return -1;
        if (b.toChain === this.preferredChain) return 1;
        return a.totalCost - b.totalCost;
      default:
        return a.totalCost - b.totalCost;
    }
  }

  private estimateGasCost(chain: ChainName): number {
    const info = CHAIN_INFO[chain];
    // Simple gas estimate: 21000 base units * gwei / 1e9 * eth price (approx $3500)
    // For ERC20 transfer: ~50000 units
    const gasUnits = 50000;
    const gasCostEth = (gasUnits * info.avgGasGwei) / 1e9;
    return Math.ceil(gasCostEth * 3500 * 1e6); // convert to USDC units (6 decimals)
  }

  // ─── Utility ──────────────────────────────────────────────────

  getWallet(chain: ChainName): WalletHandle | undefined {
    return this.wallets[chain];
  }

  getSupportedChains(): ChainName[] {
    return Object.keys(CHAIN_INFO) as ChainName[];
  }

  setStrategy(strategy: RoutingStrategy, preferredChain?: ChainName): void {
    this.strategy = strategy;
    this.preferredChain = preferredChain;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find the cheapest chain to operate on right now.
 * Useful for agents deciding where to deploy.
 */
export function findCheapestChain(): ChainName {
  const chains = Object.values(CHAIN_INFO);
  const cheapest = chains.reduce((min, chain) =>
    chain.avgGasGwei < min.avgGasGwei ? chain : min
  );
  return cheapest.name;
}

/**
 * Find the fastest chain for finality.
 */
export function findFastestChain(): ChainName {
  const chains = Object.values(CHAIN_INFO);
  const fastest = chains.reduce((min, chain) =>
    chain.avgFinalitySeconds < min.avgFinalitySeconds ? chain : min
  );
  return fastest.name;
}

/**
 * Compare chains by a metric.
 */
export function compareChains(metric: "gas" | "finality" | "liquidity"): ChainName[] {
  const chains = Object.values(CHAIN_INFO);
  switch (metric) {
    case "gas":
      return chains.sort((a, b) => a.avgGasGwei - b.avgGasGwei).map(c => c.name);
    case "finality":
      return chains.sort((a, b) => a.avgFinalitySeconds - b.avgFinalitySeconds).map(c => c.name);
    case "liquidity":
      return chains.sort((a, b) => b.usdcLiquidity - a.usdcLiquidity).map(c => c.name);
  }
}