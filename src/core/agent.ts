/**
 * Agent runner — orchestrates LLM calls, tool execution, and conversation memory
 */

import type { AgentConfig, ChatMessage, ToolDef, AgentContext } from "./types.js";
import { callProvider } from "../providers/index.js";

export class AgentRunner {
  private ctx: AgentContext;
  private systemPrompt: string;
  private history: Map<string, ChatMessage[]> = new Map();

  constructor(ctx: AgentContext, systemPrompt: string) {
    this.ctx = ctx;
    this.systemPrompt = systemPrompt;
  }

  async respond(
    chatId: string,
    userName: string,
    userMessage: string
  ): Promise<string> {
    // Build conversation messages
    const messages = this.history.get(chatId) ?? [];
    messages.push({ role: "user", content: `${userName}: ${userMessage}` });

    const allMessages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...messages,
    ];

    // Call LLM
    const response = await callProvider(this.ctx.config, allMessages, this.ctx.tools);

    // Handle tool calls if present
    let finalReply = response.content;

    if (response.toolCalls && response.toolCalls.length > 0) {
      // Execute tools
      for (const call of response.toolCalls) {
        const tool = this.ctx.tools.get(call.function.name);
        if (tool) {
          try {
            const args = JSON.parse(call.function.arguments);
            const result = await tool.execute(args, this.ctx);
            messages.push({
              role: "tool",
              content: JSON.stringify(result),
              toolCallId: call.id,
            });
          } catch (e) {
            messages.push({
              role: "tool",
              content: `Error: ${e}`,
              toolCallId: call.id,
            });
          }
        }
      }

      // Call LLM again with tool results
      const followUp = await callProvider(
        this.ctx.config,
        [{ role: "system", content: this.systemPrompt }, ...messages],
        this.ctx.tools
      );
      finalReply = followUp.content;
    }

    // Save to history
    messages.push({ role: "assistant", content: finalReply });
    this.trimHistory(messages);
    this.history.set(chatId, messages);

    return finalReply;
  }

  private trimHistory(messages: ChatMessage[]): void {
    const maxMessages = this.ctx.config.maxTokens ? 50 : 20;
    if (messages.length > maxMessages) {
      messages.splice(0, messages.length - maxMessages);
    }
  }

  clearMemory(chatId: string): void {
    this.history.delete(chatId);
  }
}