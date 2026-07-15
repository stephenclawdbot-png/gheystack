import { defineTool } from "../../src/core/define-tool.js";

export default defineTool({
  name: "get_weather",
  description: "Get mock weather data for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
  async execute({ city }) {
    return {
      city,
      condition: "Sunny ☀️",
      temperatureF: 72,
      temperatureC: 22,
    };
  },
});