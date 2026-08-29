import { describe, expect, it } from "vitest";

import type { TailscaleServeRoute } from "@ai-development-environment/agent-contract/tailscale";

import {
  normalizeTailscaleServeSnapshot,
  parseTailscaleJson,
  resolveTailscaleExecutable,
  tailscaleCommandFailure,
  tailscaleRemoveArguments,
  tailscaleUpsertCommandSequence,
  tailscaleUpsertArguments,
} from "./tailscale.js";

const route: TailscaleServeRoute = {
  protocol: "HTTPS",
  listenPort: 443,
  mountPath: "/api",
  destination: { protocol: "HTTP", port: 3000, path: "/v1" },
  funnel: false,
  appCapabilities: ["example.com/editor"],
  proxyProtocol: "NONE",
};

describe("Tailscale Serve agent handler", () => {
  it("builds argument arrays without a shell", () => {
    expect(tailscaleUpsertArguments(route)).toEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      "--set-path=/api",
      "--accept-app-caps=example.com/editor",
      "http://127.0.0.1:3000/v1",
    ]);
    expect(tailscaleRemoveArguments(route)).toEqual([
      "serve",
      "--https=443",
      "--set-path=/api",
      "off",
    ]);
  });

  it("normalizes identity and web proxy routes", () => {
    const snapshot = normalizeTailscaleServeSnapshot(
      {
        BackendState: "Running",
        TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
        Self: { DNSName: "agent.tailnet.ts.net." },
      },
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "agent.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
          },
        },
        AllowFunnel: {},
      },
      "2026-08-29T00:00:00.000Z",
    );
    expect(snapshot.identity.dnsHostname).toBe("agent.tailnet.ts.net");
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]?.destination.port).toBe(3000);
  });

  it("leaves non-loopback and file handlers unmanaged", () => {
    const snapshot = normalizeTailscaleServeSnapshot(
      { BackendState: "Running" },
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "agent.tailnet.ts.net:443": {
            Handlers: {
              "/remote": { Proxy: "http://192.0.2.10:3000" },
              "/file": { Path: "/tmp/public" },
            },
          },
        },
      },
    );

    expect(snapshot.routes).toEqual([]);
  });

  it("rejects malformed status JSON via empty non-object shapes", () => {
    expect(() =>
      parseTailscaleJson("not-json", "tailscale status --json"),
    ).toThrow(/malformed JSON/);
    expect(() =>
      parseTailscaleJson("[]", "tailscale serve status --json"),
    ).toThrow(/expected an object/);
  });

  it("reports missing CLIs and daemon failures actionably", () => {
    expect(() => resolveTailscaleExecutable("linux", () => undefined)).toThrow(
      /CONTROL_AGENT_TAILSCALE_EXECUTABLE/,
    );
    expect(
      tailscaleCommandFailure("tailscale status --json", {
        stdout: "",
        stderr: "failed to connect to local tailscaled",
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      }).message,
    ).toContain("failed to connect to local tailscaled");
  });

  it("removes a moved listener before applying its replacement", () => {
    const previous = { ...route, listenPort: 8443, mountPath: "/old" };
    expect(tailscaleUpsertCommandSequence(route, previous)).toEqual([
      tailscaleRemoveArguments(previous),
      tailscaleUpsertArguments(route),
    ]);
    expect(tailscaleUpsertCommandSequence(route, route)).toEqual([
      tailscaleUpsertArguments(route),
    ]);
  });
});
