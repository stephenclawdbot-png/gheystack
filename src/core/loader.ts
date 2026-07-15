/**
 * Filesystem loader — reads agent config from conventional folder structure
 *
 * my-agent/
 * └── agent/
 *     ├── agent.ts          # Model + runtime config
 *     ├── instructions.md   # System prompt
 *     ├── tools/            # Typed functions
 *     ├── skills/           # On-demand procedures
 *     ├── channels/         # Message channels
 *     └── schedules/        # Cron jobs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import type { AgentConfig, ToolDef, ChannelDef, ScheduleDef, AgentContext } from "./types.js";

export interface LoadedAgent {
  config: AgentConfig;
  systemPrompt: string;
  tools: Map<string, ToolDef>;
  channels: Map<string, ChannelDef>;
  schedules: ScheduleDef[];
  skills: Map<string, string>;
}

export async function loadAgent(agentDir: string): Promise<LoadedAgent> {
  if (!existsSync(agentDir)) {
    throw new Error(`Agent directory not found: ${agentDir}`);
  }

  // 1. Load agent config (agent.ts or agent.json)
  const config = await loadConfig(agentDir);

  // 2. Load system prompt from instructions.md
  const instructionsPath = join(agentDir, "instructions.md");
  const systemPrompt = config.systemPrompt ?? loadInstructions(instructionsPath);

  // 3. Load tools from tools/ directory
  const tools = await loadTools(join(agentDir, "tools"));

  // 4. Load channels from channels/ directory
  const channels = await loadChannels(join(agentDir, "channels"));

  // 5. Load schedules from schedules/ directory
  const schedules = await loadSchedules(join(agentDir, "schedules"));

  // 6. Load skills from skills/ directory (markdown procedures)
  const skills = await loadSkills(join(agentDir, "skills"));

  return { config, systemPrompt, tools, channels, schedules, skills };
}

async function loadConfig(agentDir: string): Promise<AgentConfig> {
  // Try agent.ts (dynamic import)
  const tsPath = join(agentDir, "agent.ts");
  const jsPath = join(agentDir, "agent.js");
  const jsonPath = join(agentDir, "agent.json");

  if (existsSync(jsPath)) {
    const mod = await import(`file://${jsPath}`);
    return mod.default ?? mod;
  }
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, "utf-8"));
  }
  if (existsSync(tsPath)) {
    // In dev mode, try to load .ts via tsx/esbuild
    console.warn(`[stack] agent.ts found but requires compilation. Using default config.`);
  }

  return { model: "groq/llama-3.3-70b-versatile", maxTokens: 500, temperature: 0.9, topP: 0.95 };
}

function loadInstructions(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  return "You are a helpful AI agent.";
}

async function loadTools(toolsDir: string): Promise<Map<string, ToolDef>> {
  const tools = new Map<string, ToolDef>();
  if (!existsSync(toolsDir)) return tools;

  const files = readdirSync(toolsDir).filter(
    (f) => [".ts", ".js", ".mjs"].includes(extname(f))
  );

  for (const file of files) {
    const fullPath = join(toolsDir, file);
    try {
      const mod = await import(`file://${fullPath}`);
      const tool: ToolDef = mod.default ?? mod;
      if (tool.name && typeof tool.execute === "function") {
        tools.set(tool.name, tool);
      }
    } catch (e) {
      console.warn(`[stack] Failed to load tool ${file}: ${e}`);
    }
  }

  return tools;
}

async function loadChannels(channelsDir: string): Promise<Map<string, ChannelDef>> {
  const channels = new Map<string, ChannelDef>();
  if (!existsSync(channelsDir)) return channels;

  const files = readdirSync(channelsDir).filter(
    (f) => [".ts", ".js", ".mjs"].includes(extname(f))
  );

  for (const file of files) {
    const fullPath = join(channelsDir, file);
    try {
      const mod = await import(`file://${fullPath}`);
      const channel: ChannelDef = mod.default ?? mod;
      if (channel.name) {
        channels.set(channel.name, channel);
      }
    } catch (e) {
      console.warn(`[stack] Failed to load channel ${file}: ${e}`);
    }
  }

  return channels;
}

async function loadSchedules(schedulesDir: string): Promise<ScheduleDef[]> {
  const schedules: ScheduleDef[] = [];
  if (!existsSync(schedulesDir)) return schedules;

  const files = readdirSync(schedulesDir).filter(
    (f) => [".ts", ".js", ".mjs"].includes(extname(f))
  );

  for (const file of files) {
    const fullPath = join(schedulesDir, file);
    try {
      const mod = await import(`file://${fullPath}`);
      const schedule: ScheduleDef = mod.default ?? mod;
      if (schedule.cron) {
        schedules.push(schedule);
      }
    } catch (e) {
      console.warn(`[stack] Failed to load schedule ${file}: ${e}`);
    }
  }

  return schedules;
}

function loadSkills(skillsDir: string): Promise<Map<string, string>> {
  return Promise.resolve().then(() => {
    const skills = new Map<string, string>();
    if (!existsSync(skillsDir)) return skills;

    const files = readdirSync(skillsDir).filter((f) => extname(f) === ".md");
    for (const file of files) {
      const content = readFileSync(join(skillsDir, file), "utf-8");
      const name = file.replace(/\.md$/, "");
      skills.set(name, content);
    }

    return skills;
  });
}

export function createAgentContext(
  loaded: LoadedAgent,
  agentDir: string
): AgentContext {
  return {
    agentDir,
    config: loaded.config,
    tools: loaded.tools,
    channels: loaded.channels,
    schedules: loaded.schedules,
    memory: new Map(),
  };
}