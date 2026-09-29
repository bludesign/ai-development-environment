import { describe, expect, test, vi } from "vitest";
import * as z from "zod/v4";

import type { BuiltInToolGroup } from "../builtin-tools";
import {
  createActionCenterToolGroup,
  createAppsToolGroup,
  createCliHealthToolGroup,
  createSearchToolGroup,
} from "./discovery";

function tool(group: BuiltInToolGroup, name: string) {
  return group.tools.find((entry) => entry.name === name)!;
}

describe("discovery MCP tools", () => {
  test("bounds search and action-center queries before service invocation", async () => {
    const search = vi.fn().mockResolvedValue({
      items: [
        {
          key: "run-1",
          kind: "PLAN",
          group: "PLANS_SESSIONS",
          title: "Login",
          subtitle: null,
          href: "/plans/run-1",
          status: "RUNNING",
          updatedAt: null,
          children: [],
          privateRecord: "hidden",
        },
      ],
    });
    const group = createSearchToolGroup({ search } as never);
    const results = await tool(group, "global_search").invoke({
      query: "  login  ",
    });
    expect(JSON.stringify(results)).not.toContain("privateRecord");
    expect(search).toHaveBeenCalledWith("login", 5, 3);
    await expect(
      tool(group, "global_search").invoke({
        query: "login",
        firstPerGroup: 11,
      }),
    ).rejects.toThrow();
    await expect(
      tool(group, "global_search").invoke({ query: " " }),
    ).rejects.toThrow();
    expect(search).toHaveBeenCalledTimes(1);

    const list = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: "next",
      totalCount: 0,
      needsAttentionCount: 0,
      activeCount: 0,
    });
    const actionCenter = createActionCenterToolGroup({ list } as never);
    await expect(
      tool(actionCenter, "get_action_center").invoke({ after: "cursor" }),
    ).resolves.toMatchObject({ page: { nextCursor: "next" } });
    expect(list).toHaveBeenCalledWith({ first: 50, after: "cursor" });
    await expect(
      tool(actionCenter, "get_action_center").invoke({ first: 201 }),
    ).rejects.toThrow();
  });

  test("projects app summaries without returning nested agent or repository configuration", async () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    const app = {
      id: "app-1",
      name: "Example",
      description: "Mobile app",
      agentIds: ["agent-1"],
      repositories: [
        {
          id: "repo-1",
          name: "App",
          description: "Client",
          canonicalOrigin: "secret-url",
          codebases: [{ agent: { enrollmentSecret: "secret-agent" } }],
        },
      ],
      counts: {
        repositories: 1,
        codebases: 1,
        worktrees: 2,
        dirtyWorktrees: 0,
        plans: 1,
        sessions: 1,
        builds: 2,
      },
      normalizedName: "example",
      createdAt: now,
      updatedAt: now,
    };
    const list = vi.fn().mockResolvedValue([app]);
    const get = vi.fn().mockResolvedValueOnce(app).mockResolvedValueOnce(null);
    const group = createAppsToolGroup({ list, get } as never);
    const result = await tool(group, "get_apps").invoke({});
    expect(result).toMatchObject({
      apps: [
        {
          id: "app-1",
          createdAt: now.toISOString(),
          repositories: [{ id: "repo-1", name: "App" }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("normalizedName");
    await tool(group, "get_app").invoke({ id: "app-1" });
    expect(get).toHaveBeenCalledWith("app-1");
    await expect(
      tool(group, "get_app").invoke({ id: "missing" }),
    ).resolves.toEqual({ app: null });
  });

  test("reads cached CLI health without running checks", async () => {
    const installationStatus = vi.fn().mockResolvedValue({
      version: "0.1.0",
      dependencies: [],
      customChecks: [],
      agents: [],
    });
    const statusForAgent = vi.fn().mockResolvedValue({
      agentId: "agent-1",
      name: "Agent",
      hostname: "host",
      version: "0.1",
      connectionStatus: "ONLINE",
      supported: true,
      activeJobId: null,
      lastCheckedAt: null,
      overall: "HEALTHY",
      results: [],
    });
    const run = vi.fn();
    const group = createCliHealthToolGroup({
      installationStatus,
      statusForAgent,
      run,
    } as never);
    await tool(group, "get_installation_status").invoke({});
    expect(installationStatus).toHaveBeenCalledWith();
    await tool(group, "get_agent_cli_health").invoke({ agentId: "agent-1" });
    expect(statusForAgent).toHaveBeenCalledWith("agent-1");
    expect(run).not.toHaveBeenCalled();
    expect(
      group.tools.every(
        ({ annotations }) =>
          annotations.readOnlyHint && !annotations.destructiveHint,
      ),
    ).toBe(true);
  });

  test("all new discovery tools publish concrete nested result schemas", () => {
    const groups = [
      createSearchToolGroup({} as never),
      createActionCenterToolGroup({} as never),
      createAppsToolGroup({} as never),
      createCliHealthToolGroup({} as never),
    ];
    for (const definition of groups.flatMap(({ tools }) => tools)) {
      const schema = z.toJSONSchema(definition.outputSchema);
      expect(schema.type).toBe("object");
      const serialized = JSON.stringify(schema);
      expect(serialized).toContain('"required"');
      expect(serialized).not.toContain(":{}");
    }
  });
});
