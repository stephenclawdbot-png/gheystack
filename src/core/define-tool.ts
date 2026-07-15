/**
 * Tool definition helper — like Eve's defineTool but simpler
 */

import type { ToolDef, AgentContext } from "./types.js";

export function defineTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
}): ToolDef {
  return opts;
}