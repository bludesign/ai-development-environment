import { describe, expect, test, vi } from "vitest";

import { ProviderAdapterRegistry } from "./adapter-registry.js";
import type { ProviderAdapter } from "./provider.js";

const adapter = (key: ProviderAdapter["key"]) =>
  ({
    key,
    capabilities: {
      webSearch: true,
      questions: true,
      import: true,
      pause: true,
      steering: true,
      resume: true,
      nativeDelete: true,
    },
    start: vi.fn(),
    delete: vi.fn(),
    discover: vi.fn(),
  }) as unknown as ProviderAdapter;

describe("ProviderAdapterRegistry", () => {
  test("looks adapters up without coupling the run manager to an SDK", () => {
    const codex = adapter("CODEX");
    const claude = adapter("CLAUDE");
    const registry = new ProviderAdapterRegistry([codex, claude]);
    expect(registry.get("CODEX")).toBe(codex);
    expect(registry.values()).toEqual([codex, claude]);
  });

  test("rejects duplicate provider keys", () => {
    expect(
      () => new ProviderAdapterRegistry([adapter("CODEX"), adapter("CODEX")]),
    ).toThrow("Duplicate provider adapter CODEX");
  });
});
