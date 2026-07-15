/**
 * Payment Verification — verify on-chain USDC transactions
 * Used by sellers to verify that agents actually paid before serving data
 */

import { createPublicClient, http, formatUnits, type Hash } from "viem";
import { base, mainnet, polygon, arbitrum } from "viem/chains";

const CHAIN_RPC: Record<string, typeof base> = {
  base,
  ethereum: mainnet,
  polygon,
  arbitrum,
};

const USDC_ADDRESSES: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  arbitrum: "0xaf88d065e77c8cC2239427C5116d2973aA5f85a3",
};

export interface PaymentProof {
  txHash: string;
  amount: number;
  currency: string;
  recipient: string;
  chain: string;
  sender?: string;
}

export interface VerifiedPayment {
  verified: boolean;
  txHash: string;
  amount: number;
  sender: string;
  recipient: string;
  blockNumber: number;
  confirmations: number;
}

/**
 * Verify a USDC payment on-chain
 * Checks that the transaction exists, is a USDC transfer, and matches expected amount/recipient
 */
export async function verifyPayment(proof: PaymentProof): Promise<VerifiedPayment> {
  const chain = CHAIN_RPC[proof.chain];
  if (!chain) {
    throw new Error(`Unsupported chain: ${proof.chain}`);
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  // Get transaction receipt
  const receipt = await publicClient.getTransactionReceipt({
    hash: proof.txHash as Hash,
  });

  if (receipt.status !== "success") {
    return {
      verified: false,
      txHash: proof.txHash,
      amount: 0,
      sender: "",
      recipient: "",
      blockNumber: Number(receipt.blockNumber),
      confirmations: 0,
    };
  }

  // Get current block for confirmation count
  const currentBlock = await publicClient.getBlockNumber();
  const confirmations = Number(currentBlock - receipt.blockNumber);

  // Parse Transfer event from logs
  // ERC20 Transfer event: topic0 = 0xddf252ad...
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const usdcAddress = USDC_ADDRESSES[proof.chain];

  let sender = "";
  let recipient = "";
  let amount = 0;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === usdcAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === transferTopic) {
      // topics[1] = from (padded to 32 bytes), topics[2] = to
      sender = "0x" + (log.topics[1] ?? "").slice(26);
      recipient = "0x" + (log.topics[2] ?? "").slice(26);
      // data = amount (uint256)
      amount = Number(formatUnits(BigInt(log.data), 6));
      break;
    }
  }

  const verified =
    amount >= proof.amount &&
    recipient.toLowerCase() === proof.recipient.toLowerCase();

  return {
    verified,
    txHash: proof.txHash,
    amount,
    sender,
    recipient,
    blockNumber: Number(receipt.blockNumber),
    confirmations,
  };
}

/**
 * Quick verify — just check if a tx hash is confirmed on-chain
 */
export async function isConfirmed(txHash: string, chain: string, minConfirmations = 3): Promise<boolean> {
  const chainConf = CHAIN_RPC[chain];
  if (!chainConf) return false;

  const publicClient = createPublicClient({ chain: chainConf, transport: http() });

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hash });
  if (receipt.status !== "success") return false;

  const currentBlock = await publicClient.getBlockNumber();
  return Number(currentBlock - receipt.blockNumber) >= minConfirmations;
}