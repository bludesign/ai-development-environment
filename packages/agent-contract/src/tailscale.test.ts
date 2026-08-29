import { describe, expect, it } from "vitest";

import {
  parseTailscaleServeRoute,
  tailscaleServeFingerprint,
  tailscaleServeUpsertPayload,
} from "./tailscale.js";

const route = {
  protocol: "HTTPS",
  listenPort: 443,
  mountPath: "api/",
  destination: { protocol: "HTTP", port: 3000, path: "v1" },
  funnel: false,
  appCapabilities: ["example.com/editor"],
  proxyProtocol: "NONE",
} as const;

describe("Tailscale Serve contracts", () => {
  it("normalizes safe loopback routes", () => {
    expect(parseTailscaleServeRoute(route)).toEqual({
      ...route,
      mountPath: "/api",
      destination: { ...route.destination, path: "/v1" },
    });
  });

  it("rejects unsafe feature combinations", () => {
    expect(() => parseTailscaleServeRoute({ ...route, funnel: true })).toThrow(
      /App capabilities/,
    );
    expect(() =>
      parseTailscaleServeRoute({ ...route, protocol: "HTTP", funnel: true }),
    ).toThrow(/Funnel/);
    expect(() =>
      parseTailscaleServeRoute({
        ...route,
        listenPort: 8444,
        funnel: true,
        appCapabilities: [],
      }),
    ).toThrow(/443, 8443, or 10000/);
    expect(() => parseTailscaleServeRoute({ ...route, listenPort: 0 })).toThrow(
      /1 through 65535/,
    );
    expect(() =>
      parseTailscaleServeRoute({
        ...route,
        appCapabilities: ["not-a-capability"],
      }),
    ).toThrow(/domain\/name/);
    expect(() =>
      parseTailscaleServeRoute({ ...route, proxyProtocol: "V2" }),
    ).toThrow(/TCP/);
    expect(() =>
      parseTailscaleServeRoute({
        ...route,
        protocol: "TCP",
        destination: { protocol: "HTTP", port: 3000, path: "" },
        appCapabilities: [],
      }),
    ).toThrow(/TCP listeners/);
  });

  it("requires typed mutation fields and yields stable fingerprints", () => {
    const parsed = tailscaleServeUpsertPayload({
      operationId: "operation",
      templateId: "template",
      revision: 2,
      route,
      previousRoute: null,
    });
    expect(parsed.revision).toBe(2);
    expect(tailscaleServeFingerprint(parsed.route)).toHaveLength(64);
  });
});
