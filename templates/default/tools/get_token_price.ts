import { defineTool } from "../../src/core/define-tool.js";

export default defineTool({
  name: "get_token_price",
  description: "Get the current price of a crypto token",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Token symbol e.g. ETH, BTC, USDC" },
    },
    required: ["symbol"],
  },
  async execute({ symbol }) {
    // In production, call a real API (CoinGecko, etc.)
    const prices: Record<string, number> = {
      ETH: 3200,
      BTC: 65000,
      USDC: 1,
      GHEY: 0.069,
    };
    return {
      symbol: symbol.toUpperCase(),
      price: prices[symbol.toUpperCase()] ?? "Unknown",
      currency: "USD",
    };
  },
});