import { describe, expect, test } from "vitest";
import * as z from "zod/v4";
import { compileMcpJsonSchema } from "../mcp-json-schema";
import { AgentCliHealthSchema, SearchResultsSchema } from "./discovery-schemas";

describe("discovery DTO schema compatibility", () => {
  test("exports recursive search children with resolvable, enforced JSON Schema references", () => {
    const output = z.object({ results: SearchResultsSchema });
    const schema = z.toJSONSchema(output);
    const validate = compileMcpJsonSchema(schema);
    const item = {
      key: "one",
      kind: "WORKTREE",
      group: "WORKTREES",
      title: "Feature",
      subtitle: null,
      href: "/worktrees/one",
      status: null,
      updatedAt: null,
      children: [],
    };
    const value = {
      results: {
        items: [
          {
            ...item,
            children: [
              { ...item, key: "two", children: [{ ...item, key: "three" }] },
            ],
          },
        ],
      },
    };
    expect(validate(value).valid).toBe(true);
    expect(output.parse(value)).toEqual(value);
    value.results.items[0]!.children[0]!.children[0]!.kind = "UNKNOWN";
    expect(validate(value).valid).toBe(false);
    expect(output.safeParse(value).success).toBe(false);
  });

  test.each(["HEALTHY", "ISSUES", "NOT_CHECKED", "RUNNING", "UNSUPPORTED"])(
    "accepts the %s CLI branch with nullable not-run check details",
    (overall) => {
      const value = {
        agentId: "agent",
        name: "Agent",
        hostname: "host",
        version: "0.1",
        connectionStatus: "OFFLINE",
        supported: false,
        activeJobId: null,
        lastCheckedAt: null,
        overall,
        results: [
          {
            id: "git",
            name: "Git",
            command: "git --version",
            builtIn: true,
            state: "NOT_RUN",
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: null,
            checkedAt: null,
            timedOut: false,
            launchError: null,
            outputTruncated: false,
          },
        ],
      };
      expect(AgentCliHealthSchema.parse(value)).toEqual(value);
      expect(
        compileMcpJsonSchema(z.toJSONSchema(AgentCliHealthSchema))(value).valid,
      ).toBe(true);
    },
  );
});
