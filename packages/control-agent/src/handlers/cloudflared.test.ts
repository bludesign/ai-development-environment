import { describe, expect, test } from "vitest";

import { validateCloudflaredPayload } from "./cloudflared.js";

describe("cloudflared handler payload", () => {
  test("accepts a fixed tunnel-name payload", () => {
    expect(
      validateCloudflaredPayload({ tunnelName: "example-tunnel_2" }),
    ).toEqual({
      tunnelName: "example-tunnel_2",
    });
  });

  test.each([
    { tunnelName: "example; rm -rf /" },
    { tunnelName: "$(whoami)" },
    { tunnelName: "example", extraArgument: "--config=/tmp/file" },
    { tunnelName: ["example"] },
  ])("rejects unsafe or unexpected payloads", (payload) => {
    expect(() => validateCloudflaredPayload(payload)).toThrow();
  });
});
