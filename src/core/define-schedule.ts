/**
 * Schedule definition helper — cron-based recurring tasks
 */

import type { ScheduleDef } from "./types.js";

export function defineSchedule(opts: {
  name: string;
  cron: string;
  execute: (ctx: import("./types.js").AgentContext) => Promise<void>;
}): ScheduleDef {
  return opts;
}