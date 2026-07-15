/**
 * Agent Service Marketplace — agents discover and consume API services
 * Sellers list endpoints with USDC pricing; agents browse and pay-per-call
 */

import type { ServiceProvider } from "../core/types.js";

export class Marketplace {
  private services: Map<string, ServiceProvider> = new Map();

  /** Register a service for agents to discover */
  register(service: ServiceProvider): void {
    this.services.set(service.name, service);
    console.log(`[gheystack] Service registered: ${service.name} (${service.pricePerCall} USDC/call)`);
  }

  /** List all available services */
  list(): ServiceProvider[] {
    return Array.from(this.services.values());
  }

  /** Find services by category/keyword */
  search(query: string): ServiceProvider[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }

  /** Get a specific service */
  get(name: string): ServiceProvider | undefined {
    return this.services.get(name);
  }

  /** Remove a service */
  unregister(name: string): void {
    this.services.delete(name);
  }
}

/** Default marketplace instance */
export const marketplace = new Marketplace();

// Seed with example services
marketplace.register({
  name: "weather-api",
  description: "Real-time weather data for any city",
  endpoint: "https://api.gheystack.dev/weather",
  pricePerCall: 0.01,
  currency: "USDC",
});

marketplace.register({
  name: "token-price",
  description: "Live crypto token prices and charts",
  endpoint: "https://api.gheystack.dev/price",
  pricePerCall: 0.02,
  currency: "USDC",
});

marketplace.register({
  name: "contract-scanner",
  description: "Scan smart contracts for vulnerabilities",
  endpoint: "https://api.gheystack.dev/scan",
  pricePerCall: 0.05,
  currency: "USDC",
});