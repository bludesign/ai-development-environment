import { afterEach, describe, expect, test, vi } from "vitest";

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool-call endpoint authentication", () => {
  test("rejects cross-origin requests when no bearer token is configured", async () => {
    vi.stubEnv("TOOLS_API_TOKEN", "");
    const response = await POST(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    expect(response.status).toBe(503);
  });

  test("rejects an invalid bearer token before parsing the call", async () => {
    vi.stubEnv("TOOLS_API_TOKEN", "deployment-secret");
    const response = await POST(
      new Request("https://control.example/api/tools/call", {
        method: "POST",
        headers: { authorization: "Bearer incorrect" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
