/**
 * Base channel interface — channels receive messages and route them to the agent
 */

import type { ChannelDef, ChannelMessage, AgentContext } from "../core/types.js";

export function defineChannel(opts: {
  name: string;
  type: "telegram" | "discord" | "http" | "slack";
  handler: (msg: ChannelMessage, ctx: AgentContext) => Promise<void>;
}): ChannelDef {
  return opts;
}

export { TelegramChannel } from "./telegram.js";
export { HTTPChannel } from "./http.js";