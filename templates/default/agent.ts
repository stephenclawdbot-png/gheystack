import { defineAgent } from "../../src/core/define-agent.js";

export default defineAgent({
  model: "groq/llama-3.3-70b-versatile",
  maxTokens: 500,
  temperature: 0.9,
  topP: 0.95,
});