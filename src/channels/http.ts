/**
 * HTTP channel — exposes the agent via a simple HTTP endpoint
 */

import { createServer } from "http";
import type { ChannelDef, ChannelMessage, AgentContext } from "../core/types.js";

export function defineHTTPChannel(opts: {
  port: number;
  onMessage: (msg: ChannelMessage, ctx: AgentContext) => Promise<string>;
}): ChannelDef {
  return {
    name: "http",
    type: "http",
    handler: async (msg, ctx) => {
      const reply = await opts.onMessage(msg, ctx);
      // The HTTP server is started separately by the runner
      (msg as any)._reply = reply;
    },
  };
}

export function startHTTPServer(
  port: number,
  onMessage: (msg: ChannelMessage) => Promise<string>
): void {
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const msg: ChannelMessage = {
            text: data.message ?? "",
            userId: data.userId ?? "anon",
            userName: data.userName ?? "Anonymous",
            chatId: data.chatId ?? "default",
            channel: "http",
          };
          const reply = await onMessage(msg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "gheystack-agent" }));
    }
  });

  server.listen(port);
  console.log(`[gheystack] HTTP channel listening on :${port}`);
}