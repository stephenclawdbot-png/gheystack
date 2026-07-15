/**
 * Mesh Protocol Core Types
 *
 * The mesh layer enables autonomous agent-to-agent commerce:
 * agents discover each other, negotiate prices, pay for services,
 * and build reputation — all on-chain verifiable.
 */

// ─── Agent Identity ──────────────────────────────────────────

export interface AgentIdentity {
  /** Decentralized identifier: did:stack:0xADDRESS */
  did: string;
  /** Ethereum address (derived from public key) */
  address: `0x${string}`;
  /** Human-readable name */
  name: string;
  /** Agent endpoint URL (where the agent receives mesh messages) */
  endpoint: string;
  /** Capabilities this agent provides */
  capabilities: string[];
  /** Base pricing per capability (USDC) */
  pricing: Record<string, number>;
  /** Public key for signature verification */
  publicKey: string;
  /** Chain this agent operates on */
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
}

export interface SignedMessage {
  /** EIP-712 typed data signature */
  signature: `0x${string}`;
  /** The message payload */
  payload: MeshMessage;
  /** Address that signed */
  signer: `0x${string}`;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

// ─── Mesh Messages ────────────────────────────────────────────

export type MeshMessage =
  | RFQMessage
  | QuoteMessage
  | AcceptMessage
  | RejectMessage
  | TaskResultMessage
  | ChannelUpdateMessage
  | DiscoveryMessage;

/** Request For Quote — agent asks another agent for a price */
export interface RFQMessage {
  type: "rfq";
  taskId: string;
  capability: string;
  input: unknown;
  maxPrice?: number;
  deadline?: number;
}

/** Quote — agent responds with a price offer */
export interface QuoteMessage {
  type: "quote";
  taskId: string;
  price: number;
  currency: "USDC";
  estimatedTime?: number;
  terms?: string;
}

/** Accept — agent accepts a quote */
export interface AcceptMessage {
  type: "accept";
  taskId: string;
  quoteId: string;
  paymentMethod: "direct" | "channel" | "escrow";
}

/** Reject — agent rejects a quote */
export interface RejectMessage {
  type: "reject";
  taskId: string;
  reason: string;
}

/** Task result — agent delivers the work */
export interface TaskResultMessage {
  type: "task-result";
  taskId: string;
  result: unknown;
  proof?: string;
}

/** Payment channel state update (off-chain) */
export interface ChannelUpdateMessage {
  type: "channel-update";
  channelId: string;
  sequence: number;
  senderBalance: number;
  recipientBalance: number;
  signature: `0x${string}`;
}

/** Discovery — agent announces itself */
export interface DiscoveryMessage {
  type: "discovery";
  agent: AgentIdentity;
  registryAddress?: `0x${string}`;
}

// ─── Payment Channels ─────────────────────────────────────────

export interface PaymentChannel {
  /** Unique channel ID (hash of parties + nonce) */
  channelId: string;
  /** Agent A address (channel opener) */
  partyA: `0x${string}`;
  /** Agent B address (counterparty) */
  partyB: `0x${string}`;
  /** Total USDC deposited by A */
  depositA: number;
  /** Total USDC deposited by B */
  depositB: number;
  /** Current balance of A (off-chain tracked) */
  balanceA: number;
  /** Current balance of B (off-chain tracked) */
  balanceB: number;
  /** Monotonic sequence number for state updates */
  sequence: number;
  /** Channel status */
  status: "open" | "closing" | "closed" | "disputed";
  /** Block number when channel was opened */
  openedBlock: number;
  /** Challenge period in blocks for dispute resolution */
  challengePeriod: number;
  /** Latest signed state from each party */
  latestSignatureA?: `0x${string}`;
  latestSignatureB?: `0x${string}`;
}

export interface ChannelState {
  channelId: string;
  sequence: number;
  balanceA: number;
  balanceB: number;
}

// ─── Agent Registry ────────────────────────────────────────────

export interface RegistryEntry {
  /** Agent identity */
  agent: AgentIdentity;
  /** USDC staked as bond (slashable for bad behavior) */
  stake: number;
  /** Reputation score (0-100, calculated from history) */
  reputation: number;
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total tasks failed/slashed */
  tasksFailed: number;
  /** Total USDC earned through mesh */
  totalEarned: number;
  /** Registration timestamp */
  registeredAt: number;
  /** Last active timestamp */
  lastActiveAt: number;
  /** Whether agent is currently online/available */
  online: boolean;
}

export interface ReputationUpdate {
  agentAddress: `0x${string}`;
  delta: number;
  reason: string;
  taskId?: string;
  timestamp: number;
}

// ─── Task Market ──────────────────────────────────────────────

export type TaskStatus =
  | "open"
  | "assigned"
  | "review"
  | "completed"
  | "failed"
  | "disputed"
  | "expired";

export interface Task {
  id: string;
  poster: `0x${string}`;
  title: string;
  description: string;
  capability: string;
  input: unknown;
  bounty: number;
  paymentMethod: "direct" | "channel" | "escrow";
  status: TaskStatus;
  bids: TaskBid[];
  assignedBid?: TaskBid;
  result?: unknown;
  deadline: number;
  escrowId?: string;
  arbiter?: `0x${string}`;
  createdAt: number;
  completedAt?: number;
}

export interface TaskBid {
  id: string;
  bidder: `0x${string}`;
  price: number;
  estimatedTime: number;
  reputation: number;
  message?: string;
  timestamp: number;
}

// ─── Escrow ───────────────────────────────────────────────────

export type EscrowStatus =
  | "locked"
  | "released"
  | "refunded"
  | "disputed"
  | "expired";

export interface Escrow {
  id: string;
  depositor: `0x${string}`;
  beneficiary: `0x${string}`;
  arbiter?: `0x${string}`;
  amount: number;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  status: EscrowStatus;
  lockedAt: number;
  expiresAt: number;
  milestones?: EscrowMilestone[];
}

export interface EscrowMilestone {
  description: string;
  amount: number;
  released: boolean;
  releasedAt?: number;
}

// ─── Mesh Network ─────────────────────────────────────────────

export interface MeshNode {
  identity: AgentIdentity;
  peers: Map<string, AgentIdentity>;
  channels: Map<string, PaymentChannel>;
  postedTasks: Map<string, Task>;
  assignedTasks: Map<string, Task>;
  knownAgents: Map<string, RegistryEntry>;
  reputationLog: ReputationUpdate[];
}

// ─── Supply Chain ─────────────────────────────────────────────

export type SupplyChainNodeStatus =
  | "pending"
  | "ready"
  | "hiring"
  | "executing"
  | "reviewing"
  | "completed"
  | "failed"
  | "skipped";

export interface SupplyChainNode {
  nodeId: string;
  label: string;
  capability: string;
  input: unknown;
  budget: number;
  dependsOn: string[];
  mergeInputs: boolean;
  allowSubDecomposition: boolean;
  maxDepth: number;
  taskId?: string;
  hiredAgent?: `0x${string}`;
  result?: unknown;
  status: SupplyChainNodeStatus;
  error?: string;
  actualPrice?: number;
}

export type SupplyChainStatus =
  | "planning"
  | "executing"
  | "aggregating"
  | "completed"
  | "failed"
  | "aborted";

export type AggregationStrategy =
  | "last"
  | "merge"
  | "concat"
  | "custom"
  | "first";

export interface SupplyChain {
  id: string;
  rootRequest: string;
  totalBudget: number;
  nodes: Map<string, SupplyChainNode>;
  terminalNodes: string[];
  aggregationStrategy: AggregationStrategy;
  status: SupplyChainStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  totalSpent: number;
  depth: number;
  parentNodeId?: string;
  result?: unknown;
}

export interface DecompositionPlan {
  nodes: Array<{
    label: string;
    capability: string;
    input: unknown;
    budget: number;
    dependsOn: string[];
    mergeInputs: boolean;
    allowSubDecomposition: boolean;
    maxDepth: number;
  }>;
  terminalNodes: string[];
  aggregationStrategy: AggregationStrategy;
}

// ─── Payment Intents ──────────────────────────────────────────

export type IntentType = "fixed" | "range" | "bounty" | "streaming" | "conditional" | "recurring";

export type IntentStatus =
  | "open"
  | "claimed"
  | "fulfilled"
  | "expired"
  | "cancelled"
  | "disputed";

export interface PaymentIntent {
  id: string;
  type: IntentType;
  creator: `0x${string}`;
  capability: string;
  input: unknown;
  amount?: number;
  minAmount?: number;
  maxAmount?: number;
  rate?: number;
  unit?: string;
  intervalSeconds?: number;
  verifier?: string;
  deadline: number;
  minReputation?: number;
  allowPartial?: boolean;
  maxClaims?: number;
  claimsCount: number;
  status: IntentStatus;
  createdAt: number;
  channelRoute?: string;
  escrowId?: string;
  metadata?: Record<string, unknown>;
}

export type ClaimStatus =
  | "pending"
  | "accepted"
  | "submitted"
  | "verified"
  | "paid"
  | "rejected"
  | "expired";

export interface IntentClaim {
  id: string;
  intentId: string;
  claimant: `0x${string}`;
  quotedPrice?: number;
  estimatedTime?: number;
  status: ClaimStatus;
  result?: unknown;
  verified?: boolean;
  claimedAt: number;
  fulfilledAt?: number;
  paymentTxHash?: string;
  paidAmount?: number;
}

export interface IntentMatch {
  intent: PaymentIntent;
  claim: IntentClaim;
  score: number;
  reason: string;
}