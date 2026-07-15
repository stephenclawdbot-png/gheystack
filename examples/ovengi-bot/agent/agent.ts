import { defineAgent } from "gheystack";

export default defineAgent({
  model: "groq/llama-3.3-70b-versatile",
  maxTokens: 200,
  temperature: 0.9,
  topP: 0.95,
});