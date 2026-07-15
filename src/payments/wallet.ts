/**
 * USDC Wallet — powered by viem
 * Supports Base, Ethereum, Polygon, Arbitrum
 *
 * Usage:
 *   import { createWallet } from "stack/payments/wallet";
 *   const wallet = await createWallet({ privateKey, chain: "base" });
 *   const bal = await wallet.balance();  // USDC balance
 *   const tx = await wallet.send("0x...", 5);  // Send 5 USDC
 */

import { createWalletClient, http, parseUnits, formatUnits, type WalletClient, type PublicClient } from "viem";
import { base, mainnet, polygon, arbitrum } from "viem/chains";
import type { WalletHandle } from "../core/types.js";

export interface WalletConfig {
  privateKey: `0x${string}`;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  rpcUrl?: string;
}

interface ChainConfig {
  chain: typeof base | typeof mainnet | typeof polygon | typeof arbitrum;
  usdcAddress: `0x${string}`;
  usdcDecimals: number;
}

const CHAIN_MAP: Record<string, ChainConfig> = {
  base: {
    chain: base,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
  },
  ethereum: {
    chain: mainnet,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
  },
  polygon: {
    chain: polygon,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdcDecimals: 6,
  },
  arbitrum: {
    chain: arbitrum,
    usdcAddress: "0xaf88d065e77c8cC2239427C5116d2973aA5f85a3",
    usdcDecimals: 6,
  },
};

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export async function createWallet(config: WalletConfig): Promise<WalletHandle> {
  const chainConf = CHAIN_MAP[config.chain];
  if (!chainConf) {
    throw new Error(`Unsupported chain: ${config.chain}. Supported: base, ethereum, polygon, arbitrum`);
  }

  const transport = config.rpcUrl ? http(config.rpcUrl) : http();

  const walletClient = createWalletClient({
    chain: chainConf.chain,
    transport,
    key: config.privateKey,
    account: config.privateKey,
  });

  const publicClient: PublicClient = {
    chain: chainConf.chain,
    transport,
  } as any;

  const account = walletClient.account!;
  const usdcAddress = chainConf.usdcAddress;
  const decimals = chainConf.usdcDecimals;

  return {
    address: account.address,
    chain: config.chain,

    async balance(): Promise<number> {
      try {
        const result = await (publicClient as any).readContract({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });
        return Number(formatUnits(result as bigint, decimals));
      } catch (e) {
        console.warn(`[stack] Failed to read balance: ${e}`);
        return 0;
      }
    },

    async send(to: string, amount: number): Promise<string> {
      const amountWei = parseUnits(amount.toString(), decimals);

      const txHash = await (walletClient as any).writeContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to as `0x${string}`, amountWei],
        account,
        chain: chainConf.chain,
      });

      // Wait for receipt
      await (publicClient as any).waitForTransactionReceipt({ hash: txHash });

      return txHash;
    },

    async receive(amount: number, memo?: string): Promise<string> {
      return JSON.stringify({
        amount,
        currency: "USDC",
        chain: config.chain,
        recipient: account.address,
        memo: memo ?? "",
        timestamp: Date.now(),
      });
    },
  };
}

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAIN_MAP[chain];
}

export { CHAIN_MAP };