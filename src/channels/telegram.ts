/**
 * Telegram channel — connects the agent to a Telegram bot
 */

import type { ChannelDef, ChannelMessage, AgentContext } from "../core/types.js";

export function defineTelegramChannel(opts: {
  token: string;
  onMessage: (msg: ChannelMessage, ctx: AgentContext) => Promise<string>;
}): ChannelDef {
  return {
    name: "telegram",
    type: "telegram",
    handler: async (msg, ctx) => {
      const reply = await opts.onMessage(msg, ctx);
      // Send reply via Telegram API
      const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: msg.chatId,
          text: reply,
          parse_mode: "Markdown",
        }),
      });
    },
  };
}

export const TelegramChannel = defineTelegramChannel;