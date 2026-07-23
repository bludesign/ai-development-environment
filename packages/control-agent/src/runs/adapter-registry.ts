import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import type { ProviderAdapter } from "./provider.js";

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.key)) {
        throw new Error(`Duplicate provider adapter ${adapter.key}`);
      }
      this.adapters.set(adapter.key, adapter);
    }
  }

  get(key: string): ProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  values(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createProviderAdapterRegistry(): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry([
    new CodexAdapter(),
    new ClaudeAdapter(),
    new OpenCodeAdapter(),
  ]);
}
