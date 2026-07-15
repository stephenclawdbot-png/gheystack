/**
 * LLM Provider registry — supports Groq, OpenAI, Anthropic
 * Model format: "provider/model-name"
 * Examples:
 *   groq/llama-3.3-70b-versatile
 *   openai/gpt-4o
 *   anthropic/claude-sonnet-5
 */

import type { AgentConfig, ChatMessage, ToolDef } from "../core/types.js";

export interface ProviderResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export async function callProvider(
  config: AgentConfig,
  messages: ChatMessage[],
  tools?: Map<string, ToolDef>
): Promise<ProviderResponse> {
  const [provider, ...modelParts] = config.model.split("/");
  const model = modelParts.join("/");

  switch (provider) {
    case "groq":
      return callGroq(config, model, messages, tools);
    case "openai":
      return callOpenAI(config, model, messages, tools);
    case "anthropic":
      return callAnthropic(config, model, messages, tools);
    default:
      throw new Error(`Unknown provider: ${provider}. Use groq/, openai/, or anthropic/ prefix.`);
  }
}

async function callGroq(
  config: AgentConfig,
  model: string,
  messages: ChatMessage[],
  tools?: Map<string, ToolDef>
): Promise<ProviderResponse> {
  const Groq = (await import("groq-sdk")).default;
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const toolDefs = tools && tools.size > 0
    ? Array.from(tools.values()).map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    : undefined;

  const groqMessages: any[] = messages.map((m) => ({ role: m.role, content: m.content }));

  const res = await client.chat.completions.create({
    model: model || "llama-3.3-70b-versatile",
    messages: groqMessages,
    max_tokens: config.maxTokens ?? 500,
    temperature: config.temperature ?? 0.9,
    top_p: config.topP ?? 0.95,
    tools: toolDefs,
  });

  const choice = res.choices[0];
  return {
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })),
  };
}

async function callOpenAI(
  config: AgentConfig,
  model: string,
  messages: ChatMessage[],
  tools?: Map<string, ToolDef>
): Promise<ProviderResponse> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const toolDefs = tools && tools.size > 0
    ? Array.from(tools.values()).map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    : undefined;

  const openaiMessages: any[] = messages.map((m) => ({ role: m.role, content: m.content }));

  const res = await client.chat.completions.create({
    model: model || "gpt-4o",
    messages: openaiMessages,
    max_tokens: config.maxTokens ?? 500,
    temperature: config.temperature ?? 0.9,
    tools: toolDefs,
  });

  const choice = res.choices[0];
  return {
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })),
  };
}

async function callAnthropic(
  config: AgentConfig,
  model: string,
  messages: ChatMessage[],
  tools?: Map<string, ToolDef>
): Promise<ProviderResponse> {
  // Anthropic uses a different SDK — lazy load
  // For now, route through OpenAI-compatible endpoint if available
  console.warn("[stack] Anthropic provider not yet implemented. Using Groq fallback.");
  return callGroq(config, "llama-3.3-70b-versatile", messages, tools);
}