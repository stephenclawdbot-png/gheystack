import { defineTool } from "../../src/core/define-tool.js";

export default defineTool({
  name: "send_usdc",
  description: "Send USDC payment to an address",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient wallet address" },
      amount: { type: "number", description: "Amount in USDC" },
      memo: { type: "string", description: "Optional memo" },
    },
    required: ["to", "amount"],
  },
  async execute({ to, amount, memo }, ctx) {
    if (!ctx.wallet) {
      return { error: "No wallet configured. Run `gheystack fund` first." };
    }
    const txHash = await ctx.wallet.send(to, amount);
    return { success: true, txHash, amount, to, memo };
  },
});