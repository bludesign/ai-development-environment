import { describe, expect, test } from "vitest";

import { resolveControlPlaneWebSocketUrl } from "./control-plane-client";

describe("resolveControlPlaneWebSocketUrl", () => {
  test("uses the same-origin secure proxy on HTTPS pages", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "ws://127.0.0.1:3091/graphql",
        "https:",
        "weblocalair.fwd10.com",
      ),
    ).toBe("wss://weblocalair.fwd10.com/graphql");
  });

  test("keeps an explicitly configured secure URL", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "wss://events.example.com/graphql",
        "https:",
        "app.example.com",
      ),
    ).toBe("wss://events.example.com/graphql");
  });

  test("uses a configured local URL on HTTP pages", () => {
    expect(
      resolveControlPlaneWebSocketUrl(
        "ws://127.0.0.1:3091/graphql",
        "http:",
        "127.0.0.1:3000",
      ),
    ).toBe("ws://127.0.0.1:3091/graphql");
  });
});
