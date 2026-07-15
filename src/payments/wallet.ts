/**
 * USDC Wallet — manage agent wallets across chains
 * Supports Base, Ethereum, Polygon, Arbitrum
 */

import type { WalletHandle } from "../core/types.js";

export interface WalletConfig {
  privateKey: string;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  rpcUrl?: string;
}

const CHAIN_CONFIGS: Record<string, { chainId: number; rpcUrl: string; usdcAddress: string }> = {
  base: {
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  ethereum: {
    chainId: 1,
    rpcUrl: "https://eth.llamarpc.com",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  polygon: {
    chainId: 137,
    rpcUrl: "https://polygon-rpc.com",
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  arbitrum: {
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    usdcAddress: "0xaf88d065e77c8cC2239427C5116d2973aA5f85a3",
  },
};

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    type: "function" as const,
  },
  {
    constant: false,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function" as const,
  },
];

export async function createWallet(config: WalletConfig): Promise<WalletHandle> {
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${config.chain}`);
  }

  // In production, use viem or ethers
  // For now, return a handle that the CLI manages
  const address = "0x" + "0".repeat(40); // Placeholder — real impl uses viem

  return {
    address,
    chain: config.chain,
    async balance(): Promise<number> {
      // Query USDC balance via RPC
      // Real implementation uses viem/ethers to call balanceOf
      return 0;
    },
    async send(to: string, amount: number): Promise<string> {
      // Send USDC transfer
      // Real implementation uses viem/ethers to send transaction
      console.log(`[gheystack] Sending ${amount} USDC to ${to} on ${config.chain}`);
      return "0x" + "txhash";
    },
    async receive(amount: number, memo?: string): Promise<string> {
      // Generate a request/invoice
      return JSON.stringify({ amount, currency: "USDC", memo, address });
    },
  };
}

export function getChainConfig(chain: string) {
  return CHAIN_CONFIGS[chain];
}

export { CHAIN_CONFIGS };