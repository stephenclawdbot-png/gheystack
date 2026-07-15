/**
 * GheyStack — The Ghey Agent Stack
 * Core types and interfaces
 */

export interface AgentConfig {
  /** LLM model identifier, e.g. "groq/llama-3.3-70b-versatile" */
  model: string;
  /** Max tokens per response */
  maxTokens?: number;
  /** Temperature (0-2) */
  temperature?: number;
  /** Top-p sampling */
  topP?: number;
  /** System prompt override (otherwise reads instructions.md) */
  systemPrompt?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
}

export interface ChannelDef {
  name: string;
  type: "telegram" | "discord" | "http" | "slack";
  handler: (msg: ChannelMessage, ctx: AgentContext) => Promise<void>;
}

export interface ChannelMessage {
  text: string;
  userId: string;
  userName: string;
  chatId: string;
  channel: string;
  raw?: unknown;
}

export interface ScheduleDef {
  name: string;
  cron: string;
  execute: (ctx: AgentContext) => Promise<void>;
}

export interface AgentContext {
  agentDir: string;
  config: AgentConfig;
  tools: Map<string, ToolDef>;
  channels: Map<string, ChannelDef>;
  schedules: ScheduleDef[];
  wallet?: WalletHandle;
  memory: Map<string, unknown[]>;
}

export interface WalletHandle {
  address: string;
  chain: "base" | "ethereum" | "polygon" | "arbitrum";
  balance: () => Promise<number>;
  send: (to: string, amount: number) => Promise<string>;
  receive: (amount: number, memo?: string) => Promise<string>;
}

export interface PaymentRequest {
  amount: number;
  currency: "USDC";
  recipient: string;
  memo?: string;
  endpoint?: string;
}

export interface ServiceProvider {
  name: string;
  description: string;
  endpoint: string;
  pricePerCall: number;
  currency: "USDC";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}