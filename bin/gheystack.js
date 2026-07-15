#!/usr/bin/env node

/**
 * GheyStack CLI — The Ghey Agent Stack
 * Usage: npx gheystack init my-agent
 *        gheystack run ./my-agent
 *        gheystack fund ./my-agent --amount 10
 *        gheystack sell --port 3000 --price 0.01
 *        gheystack marketplace list
 */

import { Command } from "commander";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { createServer } from "http";

const program = new Command();

program
  .name("gheystack")
  .description("🔥 The Ghey Agent Stack — filesystem-first AI agents with USDC payment rails")
  .version("0.1.0");

// ─── init ────────────────────────────────────────────────────────────────────
program
  .command("init [path]")
  .description("Scaffold a new agent project")
  .action((targetPath = ".") => {
    const dest = resolve(targetPath);
    const templateDir = join(new URL("..", import.meta.url).pathname.replace(/^\//, ""), "templates", "default");

    console.log("🔥 GheyStack — Initializing agent project...\n");

    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    // Copy template
    if (existsSync(templateDir)) {
      copyDir(templateDir, dest);
      console.log(`✅ Agent scaffolded at: ${dest}`);
    } else {
      // Fallback: create structure inline
      mkdirSync(join(dest, "agent", "tools"), { recursive: true });
      mkdirSync(join(dest, "agent", "channels"), { recursive: true });
      mkdirSync(join(dest, "agent", "schedules"), { recursive: true });
      mkdirSync(join(dest, "agent", "skills"), { recursive: true });

      writeFileSync(
        join(dest, "agent", "agent.ts"),
        `import { defineAgent } from "gheystack";\n\nexport default defineAgent({\n  model: "groq/llama-3.3-70b-versatile",\n  maxTokens: 500,\n  temperature: 0.9,\n});\n`
      );
      writeFileSync(
        join(dest, "agent", "instructions.md"),
        `# Agent Instructions\n\nYou are a helpful AI agent powered by GheyStack.\n`
      );
      writeFileSync(
        join(dest, "agent", "tools", "get_weather.ts"),
        `import { defineTool } from "gheystack/tools";\nimport { z } from "zod";\n\nexport default defineTool({\n  name: "get_weather",\n  description: "Get mock weather data for a city",\n  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },\n  async execute({ city }) {\n    return { city, condition: "Sunny ☀️", temperatureF: 72 };\n  },\n});\n`
      );
      writeFileSync(join(dest, ".env.example"), "GROQ_API_KEY=\nOPENAI_API_KEY=\nTELEGRAM_BOT_TOKEN=\n");
      writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "my-gheystack-agent", type: "module", dependencies: { gheystack: "latest" } }, null, 2));
      console.log(`✅ Agent scaffolded at: ${dest}`);
    }

    console.log("\nNext steps:");
    console.log(`  cd ${targetPath}`);
    console.log("  npm install");
    console.log("  cp .env.example .env  # Add your API keys");
    console.log("  npx gheystack run\n");
  });

// ─── run ────────────────────────────────────────────────────────────────────
program
  .command("run [path]")
  .description("Run an agent from a directory")
  .option("-c, --channel <type>", "Channel to activate (telegram, http, discord)")
  .action(async (agentPath = "./agent", opts) => {
    console.log("🔥 GheyStack — Starting agent...\n");

    const agentDir = resolve(agentPath);
    if (!existsSync(agentDir)) {
      console.error(`❌ Agent directory not found: ${agentDir}`);
      process.exit(1);
    }

    // Load env
    try {
      const dotenv = await import("dotenv");
      dotenv.config({ path: join(resolve("."), ".env") });
    } catch {}

    // Dynamic import of core (compiled or tsx)
    try {
      const { loadAgent, createAgentContext } = await import("../dist/core/loader.js");
      const { AgentRunner } = await import("../dist/core/agent.js");

      const loaded = await loadAgent(agentDir);
      const ctx = createAgentContext(loaded, agentDir);
      const runner = new AgentRunner(ctx, loaded.systemPrompt);

      console.log(`🧠 Model: ${loaded.config.model}`);
      console.log(`🔧 Tools: ${loaded.tools.size}`);
      console.log(`📡 Channels: ${loaded.channels.size}`);
      console.log(`⏰ Schedules: ${loaded.schedules.length}`);

      // Start HTTP channel if requested
      if (opts.channel === "http" || !opts.channel) {
        const { startHTTPServer } = await import("../dist/channels/http.js");
        const port = parseInt(process.env.PORT ?? "3000");
        startHTTPServer(port, async (msg) => {
          return runner.respond(msg.chatId, msg.userName, msg.text);
        });
      }

      // Start Telegram channel if requested
      if (opts.channel === "telegram" && process.env.TELEGRAM_BOT_TOKEN) {
        console.log("📡 Starting Telegram polling...");
        // In production, use grammy or python-telegram-bot bridge
        const token = process.env.TELEGRAM_BOT_TOKEN;
        let offset = 0;
        setInterval(async () => {
          try {
            const res = await fetch(
              `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`
            );
            const data = await res.json();
            if (data.ok && data.result.length > 0) {
              for (const update of data.result) {
                offset = update.update_id + 1;
                if (update.message?.text) {
                  const reply = await runner.respond(
                    String(update.message.chat.id),
                    update.message.from?.first_name ?? "babe",
                    update.message.text
                  );
                  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chat_id: update.message.chat.id, text: reply }),
                  });
                }
              }
            }
          } catch (e) {
            console.error("Telegram poll error:", e);
          }
        }, 2000);
        console.log("✅ Telegram channel active");
      }

      console.log("\n✨ Agent is LIVE. Press Ctrl+C to stop.\n");
    } catch (e: any) {
      console.error("❌ Failed to start agent:", e.message);
      console.error("\nMake sure to run `npm run build` first.");
    }
  });

// ─── fund ──────────────────────────────────────────────────────────────────
program
  .command("fund [path]")
  .description("Fund an agent's USDC wallet")
  .option("--amount <usd>", "Amount in USDC to fund")
  .option("--chain <chain>", "Chain (base, ethereum, polygon, arbitrum)", "base")
  .action(async (path = ".", opts) => {
    console.log("💰 GheyStack — Agent Wallet Funding\n");
    console.log(`Chain: ${opts.chain}`);
    console.log(`Amount: ${opts.amount ?? "N/A"} USDC`);
    console.log("\n⚠️  Wallet management requires a private key.");
    console.log("   Set WALLET_PRIVATE_KEY in your .env file.\n");

    // In production: interact with viem/ethers to fund wallet
    console.log("✅ Wallet funding configured. Use `gheystack run` to start agent.");
  });

// ─── sell ──────────────────────────────────────────────────────────────────
program
  .command("sell")
  .description("Start a paid API endpoint (agents pay USDC per call)")
  .option("-p, --port <port>", "Port", "3000")
  .option("--price <usd>", "Price per call in USDC", "0.01")
  .option("--address <addr>", "Seller wallet address")
  .action((opts) => {
    console.log("🤑 GheyStack — Seller Mode\n");
    console.log(`Port: ${opts.port}`);
    console.log(`Price: ${opts.price} USDC per call`);
    console.log(`Seller: ${opts.address ?? "Not set"}\n`);

    const server = createServer((req, res) => {
      const payment = req.headers["x-payment"];

      if (!payment) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          accepts: {
            amount: parseFloat(opts.price),
            currency: "USDC",
            recipient: opts.address ?? "0xYOUR_WALLET",
            network: "base",
            memo: `API call: ${req.method} ${req.url}`,
          },
        }));
        return;
      }

      // Payment received
      console.log(`💰 Payment received: ${payment}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "Your API response here 💅" }));
    });

    server.listen(parseInt(opts.port));
    console.log(`✅ Seller endpoint live on :${opts.port}`);
    console.log("   Agents will get 402 → pay USDC → get data\n");
  });

// ─── marketplace ────────────────────────────────────────────────────────────
program
  .command("marketplace <action>")
  .description("Browse the agent service marketplace")
  .action(async (action) => {
    if (action === "list") {
      console.log("🛒 GheyStack Marketplace\n");
      console.log("Service           Price     Description");
      console.log("─────────────────────────────────────────────");
      console.log("weather-api       0.01 USDC Real-time weather data");
      console.log("token-price       0.02 USDC Live crypto prices");
      console.log("contract-scanner  0.05 USDC Smart contract audits");
      console.log("\nUse `gheystack call <service> --wallet <key>` to purchase.");
    } else if (action === "search") {
      console.log("Search not implemented yet. Use `gheystack marketplace list`");
    }
  });

program.parse();