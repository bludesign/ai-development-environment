import { describe, expect, test, vi } from "vitest";

import {
  runSseScript,
  type SseScriptStorage,
  type SseStoredValue,
} from "./script-runner";

function storage(): SseScriptStorage {
  const values = new Map<string, { value: unknown; version: number }>();
  const view = (key: string): SseStoredValue => {
    const value = values.get(key);
    return value ? { key, ...value } : null;
  };
  return {
    get: async (key) => view(key),
    set: async (key, value) => {
      const next = { value, version: (values.get(key)?.version ?? 0) + 1 };
      values.set(key, next);
      return { key, ...next };
    },
    delete: async (key) => values.delete(key),
    compareAndSet: async (key, expectedVersion, value) => {
      if ((values.get(key)?.version ?? null) !== expectedVersion)
        throw new Error("version conflict");
      const next = { value, version: (expectedVersion ?? 0) + 1 };
      values.set(key, next);
      return { key, ...next };
    },
    increment: async (key, delta) => {
      const current = Number(values.get(key)?.value ?? 0);
      const next = {
        value: current + delta,
        version: (values.get(key)?.version ?? 0) + 1,
      };
      values.set(key, next);
      return { key, ...next };
    },
  };
}

describe("runSseScript", () => {
  test("supports async storage, console capture, and HeaderBag mutations", async () => {
    const result = await runSseScript({
      source: `
        console.info("running", request.method);
        await storage.increment("requests", 1);
        forward.headers.delete("authorization");
        forward.headers.set("x-scripted", "yes");
        return { url: "https://example.com/overridden" };
      `,
      context: {
        request: {
          method: "POST",
          headers: [{ name: "authorization", value: "Bearer secret" }],
        },
        forward: {
          url: "https://example.com",
          method: "POST",
          headers: [{ name: "authorization", value: "Bearer secret" }],
          body: "test",
        },
      },
      timeoutMs: 5_000,
      memoryLimitMb: 32,
      fetchTimeoutMs: 1_000,
      storage: storage(),
    });
    expect(result.result).toEqual({ url: "https://example.com/overridden" });
    expect(result.console[0]).toEqual({
      level: "info",
      message: "running POST",
    });
    expect((result.context.forward as { headers: unknown }).headers).toEqual([
      { name: "x-scripted", value: "yes" },
    ]);
  });

  test("awaits HTTP fetch results and exposes documented request aliases", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ answer: 42 }), {
          status: 200,
          headers: { "content-type": "application/json", "x-test": "yes" },
        }),
    );
    try {
      const result = await runSseScript({
        source: `
          const fetched = await fetch("https://example.test/value");
          const payload = await fetched.json();
          forwarding.headers.set("x-answer", String(payload.answer));
          return { status: fetched.status, phase, method: originalRequest.method, answer: forwarding.headers.get("x-answer") };
        `,
        context: {
          phase: "request",
          request: { method: "POST", headers: [], body: { text: "hello" } },
          forward: {
            url: "https://example.test/events",
            method: "POST",
            headers: [],
            body: "hello",
          },
        },
        timeoutMs: 1_000,
        memoryLimitMb: 32,
        fetchTimeoutMs: 500,
        storage: storage(),
      });
      expect(result.result).toEqual({
        status: 200,
        phase: "request",
        method: "POST",
        answer: "42",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
