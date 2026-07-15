import { defineTool } from "gheystack/tools";

export default defineTool({
  name: "get_token_info",
  description: "Get $GHEY token info including contract address and buy link",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Token symbol (default: GHEY)" },
    },
  },
  async execute({ symbol = "GHEY" }) {
    return {
      symbol: "$GHEY",
      name: "Ghey Intelligence",
      contract: "0x6898c94f1d4517368a2d900b3fee880ef24bdf44",
      network: "Robinhood Chain",
      buyLink: "https://pons.family/launchpad/0x6898c94f1d4517368a2d900b3fee880ef24bdf44",
      website: "https://ovenghey.fun",
    };
  },
});