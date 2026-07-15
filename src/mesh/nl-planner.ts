/**
 * Natural Language Supply Chain Planner
 *
 * The breakthrough: describe what you want in plain English, and the framework
 * automatically decomposes it into a multi-agent supply chain, finds capable agents,
 * estimates budgets, and executes the entire pipeline autonomously.
 *
 * Example:
 *   "Analyze this GitHub repo for security vulnerabilities and generate a fix PR"
 *
 * Decomposes into:
 *   1. clone_repo (capability: "code.git") → $0.50
 *   2. scan_vulnerabilities (capability: "security.scan") → $2.00
 *   3. generate_fix (capability: "code.generate") → $1.50
 *   4. create_pr (capability: "code.git") → $0.50
 *   Total: $4.50, executed as a DAG with parallelism where possible
 */

import type { DecompositionPlan, AggregationStrategy } from "./types.js";
import { callProvider } from "../providers/index.js";
import type { AgentConfig, ChatMessage } from "../core/types.js";

export interface NLPlanConfig {
  /** LLM model identifier, e.g. "groq/llama-3.3-70b-versatile" */
  model: string;
  /** Max budget in USDC for the entire supply chain */
  maxBudget: number;
  /** Max depth for recursive decomposition */
  maxDepth?: number;
  /** Known capabilities in the mesh (for the LLM to reference) */
  knownCapabilities?: string[];
  /** Temperature for LLM creativity (lower = more deterministic) */
  temperature?: number;
  /** Max tokens for LLM response */
  maxTokens?: number;
}

export interface NLPlanResult {
  plan: DecompositionPlan;
  reasoning: string;
  estimatedCost: number;
  estimatedTimeSeconds: number;
  warnings: string[];
}

interface LLMDecomposition {
  reasoning: string;
  steps: Array<{
    label: string;
    capability: string;
    description: string;
    estimatedCost: number;
    estimatedTimeSeconds: number;
    dependsOn: string[];  // labels of steps this depends on
    canParallelize: boolean;
  }>;
  aggregationStrategy: AggregationStrategy;
  totalEstimatedCost: number;
  totalEstimatedTimeSeconds: number;
  warnings: string[];
}

const DECOMPOSITION_SYSTEM_PROMPT = `You are a supply chain decomposition engine for an AI agent mesh network.

Your job: take a natural language task description and decompose it into a sequence of subtasks
that can be executed by autonomous AI agents. Each subtask maps to a "capability" that agents
in the mesh network can provide.

Available capabilities include (but are not limited to):
- code.git: Git operations (clone, commit, PR, merge)
- code.analyze: Code analysis and review
- code.generate: Code generation
- code.test: Test generation and execution
- text.translate: Translation between languages
- text.summarize: Text summarization
- text.analyze: Sentiment analysis, entity extraction
- image.generate: Image generation
- image.analyze: Image analysis and classification
- data.extract: Data extraction (from documents, APIs, databases)
- data.transform: Data transformation and cleaning
- data.analyze: Statistical analysis and insights
- research.web: Web research and information gathering
- research.academic: Academic paper search and analysis
- security.scan: Security vulnerability scanning
- security.audit: Smart contract audit
- ml.train: Model training
- ml.predict: Model inference/prediction
- payment.send: USDC payment routing
- verify.notarize: Result verification and notarization

Rules:
1. Each step must have a clear, actionable label
2. Dependencies must reference step labels exactly
3. Maximize parallelism — independent steps should have no dependencies on each other
4. Estimate costs in USDC (6 decimal unit, typically $0.10 - $10.00 per step)
5. Estimate time in seconds (typically 30s - 600s per step)
6. The total cost must not exceed the budget
7. Use "last" aggregation if there's a single final output
8. Use "merge" if multiple outputs need to be combined into a dict
9. Use "concat" if outputs should be concatenated as a list

Output valid JSON only, no markdown.`;

export async function planSupplyChainFromNL(
  task: string,
  config: NLPlanConfig
): Promise<NLPlanResult> {
  const maxDepth = config.maxDepth ?? 3;
  const temperature = config.temperature ?? 0.3;

  const userPrompt = `Task: ${task}

Budget: ${config.maxBudget} USDC max
Max depth: ${config.maxDepth}

${config.knownCapabilities?.length ? `Known capabilities in mesh: ${config.knownCapabilities.join(", ")}` : ""}

Decompose this task into a supply chain. Respond as JSON with this exact shape:
{
  "reasoning": "Why you chose this decomposition",
  "steps": [
    {
      "label": "short_snake_case_label",
      "capability": "capability.from.list",
      "description": "What this step does",
      "estimatedCost": 0.50,
      "estimatedTimeSeconds": 120,
      "dependsOn": ["other_step_label"],
      "canParallelize": true
    }
  ],
  "aggregationStrategy": "last" | "merge" | "concat",
  "totalEstimatedCost": 4.50,
  "totalEstimatedTimeSeconds": 600,
  "warnings": ["any warnings about feasibility"]
}`;

  const messages: ChatMessage[] = [
    { role: "system", content: DECOMPOSITION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const providerConfig: AgentConfig = {
    model: config.model,
    temperature,
    maxTokens: config.maxTokens ?? 2000,
  };

  const response = await callProvider(providerConfig, messages);

  const content = response.content?.trim() || "";
  const jsonStr = extractJson(content);

  let decomposition: LLMDecomposition;
  try {
    decomposition = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM did not return valid JSON. Got: ${content.slice(0, 200)}`);
  }

  // Validate
  if (!decomposition.steps || !Array.isArray(decomposition.steps) || decomposition.steps.length === 0) {
    throw new Error("LLM decomposition has no steps");
  }

  if (decomposition.totalEstimatedCost > config.maxBudget) {
    decomposition.warnings.push(
      `Estimated cost ${decomposition.totalEstimatedCost} exceeds budget ${config.maxBudget}`
    );
  }

  // Convert to DecompositionPlan
  const nodes: DecompositionPlan["nodes"] = decomposition.steps.map((step, _i) => ({
    label: step.label,
    capability: step.capability,
    input: { description: step.description },  // LLM generates the input description
    budget: step.estimatedCost,
    dependsOn: step.dependsOn || [],
    mergeInputs: step.dependsOn && step.dependsOn.length > 1,
    allowSubDecomposition: maxDepth > 1,
    maxDepth: maxDepth - 1,
  }));

  // Find terminal nodes (nodes that nothing depends on)
  const allDeps = new Set<string>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      allDeps.add(dep);
    }
  }
  const terminalNodes = nodes
    .filter(n => !allDeps.has(n.label))
    .map(n => n.label);

  const plan: DecompositionPlan = {
    nodes,
    terminalNodes: terminalNodes.length > 0 ? terminalNodes : [nodes[nodes.length - 1].label],
    aggregationStrategy: decomposition.aggregationStrategy || "last",
  };

  return {
    plan,
    reasoning: decomposition.reasoning,
    estimatedCost: decomposition.totalEstimatedCost,
    estimatedTimeSeconds: decomposition.totalEstimatedTimeSeconds,
    warnings: decomposition.warnings || [],
  };
}

function extractJson(text: string): string {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find raw JSON
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  return text;
}

/**
 * Interactive supply chain execution with human-in-the-loop approval.
 *
 * Plans the supply chain, presents it to the user for approval,
 * then executes it through the mesh network.
 */
export async function planAndApprove(
  task: string,
  config: NLPlanConfig,
  onPlan: (result: NLPlanResult) => Promise<boolean>
): Promise<{ plan: NLPlanResult; approved: boolean }> {
  const plan = await planSupplyChainFromNL(task, config);
  const approved = await onPlan(plan);
  return { plan, approved };
}