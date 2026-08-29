import { describe, expect, test, vi } from "vitest";

import type { BuiltInToolGroup } from "../builtin-tools";
import { createTailscaleToolGroup } from "./tailscale";

function tool(group: BuiltInToolGroup, name: string) {
  return group.tools.find((candidate) => candidate.name === name)!;
}

describe("Tailscale MCP tools", () => {
  test("publishes the complete surface with risk-appropriate annotations", () => {
    const group = createTailscaleToolGroup({} as never);
    expect(group.id).toBe("builtin:tailscale");
    expect(group.tools.map(({ name }) => name)).toEqual([
      "get_tailscale_serve_overview",
      "inspect_tailscale_serve",
      "upsert_tailscale_serve_template",
      "set_tailscale_serve_agent_enabled",
      "delete_tailscale_serve_template",
    ]);
    expect(
      tool(group, "get_tailscale_serve_overview").annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool(group, "inspect_tailscale_serve").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      tool(group, "upsert_tailscale_serve_template").annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(
      tool(group, "delete_tailscale_serve_template").annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  test("maps typed assignments without accepting raw command fields", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "operation-1" });
    const group = createTailscaleToolGroup({ upsert } as never);
    const result = await tool(group, "upsert_tailscale_serve_template").invoke({
      input: {
        name: "Developer API",
        protocol: "HTTPS",
        listenPort: 443,
        mountPath: "/api",
        destinationProtocol: "HTTP",
        destinationPort: 3000,
        destinationPath: "",
        funnel: false,
        appCapabilities: [],
        proxyProtocol: "NONE",
        assignments: [{ agentId: "agent-1", enabled: true }],
        command: "tailscale serve --bg anything",
      },
      requestId: "request-1",
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.not.objectContaining({ command: expect.anything() }),
      "request-1",
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        assignments: [{ agentId: "agent-1", enabled: true }],
      }),
      "request-1",
    );
    expect(result).toEqual({ operation: { id: "operation-1" } });
  });

  test("rejects invalid typed ports before service invocation", async () => {
    const upsert = vi.fn();
    const group = createTailscaleToolGroup({ upsert } as never);
    await expect(
      tool(group, "upsert_tailscale_serve_template").invoke({
        input: {
          name: "Invalid",
          protocol: "HTTPS",
          listenPort: 70_000,
          destinationProtocol: "HTTP",
          destinationPort: 3000,
          funnel: false,
          proxyProtocol: "NONE",
          assignments: [{ agentId: "agent-1", enabled: true }],
        },
        requestId: "request-invalid",
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
});
