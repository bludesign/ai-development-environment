import { describe, expect, test, vi } from "vitest";
import { WORKFLOW_CAPABILITY_ACTIONS } from "@/lib/workflows/capability-actions";
import { WORKFLOW_STEP_BY_KIND } from "@/lib/workflows/definition";
import { getConfigDescriptor } from "@/lib/workflows/config-descriptors";
import { createBuiltInToolRegistry } from "@/services/tools/builtin-tools";
import { registerCapabilityActionAdapters } from "./capability-action-adapters";
import {
  WorkflowStepExecutor,
  type WorkflowExecutionContext,
} from "./step-executor";

function registry() {
  const placeholder = {} as never;
  return createBuiltInToolRegistry({
    codebaseTools: placeholder,
    builds: placeholder,
    codebases: placeholder,
    telemetry: placeholder,
    pushNotifications: placeholder,
    agents: placeholder,
    diskSpace: placeholder,
    worktrees: placeholder,
    runs: placeholder,
    commands: placeholder,
    jira: placeholder,
    jiraWebhooks: placeholder,
    github: placeholder,
    gitlab: placeholder,
    skills: placeholder,
    buildData: placeholder,
    tailscale: placeholder,
    signingAssets: placeholder,
    iosDevices: placeholder,
    notifications: placeholder,
    ccusage: placeholder,
    modelCosts: placeholder,
    systemStatus: placeholder,
    polling: placeholder,
    credentials: placeholder,
    cacheServer: placeholder,
    toolAudit: placeholder,
    testExternalMcpServer: vi.fn(),
    listMcpToolPresets: vi.fn(),
    toolAdministration: placeholder,
    workflows: () => placeholder,
    worktreeAutomations: () => placeholder,
    sse: placeholder,
    globalSearch: placeholder,
    actionCenter: placeholder,
    apps: placeholder,
    cliHealth: placeholder,
    crashes: placeholder,
    repositoryTransfer: placeholder,
  });
}

describe("dedicated workflow capability actions", () => {
  test("every action targets a registered tool and describes its accepted and required arguments", () => {
    const tools = registry()
      .catalog()
      .flatMap(function flatten(group): typeof group.tools {
        return [...group.tools, ...group.children.flatMap(flatten)];
      });
    const errors: string[] = [];
    for (const action of WORKFLOW_CAPABILITY_ACTIONS) {
      const tool = tools.find(({ name }) => name === action.toolName);
      if (!tool) {
        errors.push(`${action.kind}: missing tool ${action.toolName}`);
        continue;
      }
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const keys = new Set(action.fields.map(({ key }) => key));
      if (action.mutates !== (tool.annotations?.readOnlyHint !== true))
        errors.push(`${action.kind}: write-effect mismatch`);
      for (const key of schema.required ?? []) {
        if (!keys.has(key))
          errors.push(`${action.kind}: missing required argument ${key}`);
      }
      for (const key of keys) {
        if (schema.properties && !(key in schema.properties))
          errors.push(`${action.kind}: unknown argument ${key}`);
      }
      expect(WORKFLOW_STEP_BY_KIND.has(action.kind)).toBe(true);
      expect(getConfigDescriptor(action.kind, "step")?.fields).toEqual(
        action.fields,
      );
    }
    expect(errors).toEqual([]);
  });

  test("uses the fixed tool identity, audited workflow context, stable request id and step-scoped structured output", async () => {
    const callBuiltInTool = vi
      .fn()
      .mockResolvedValue({ structuredContent: { sources: ["app.xcodeproj"] } });
    const executor = new WorkflowStepExecutor();
    registerCapabilityActionAdapters(executor, { callBuiltInTool });
    const context = {
      run: { id: "workflow-run" },
      attempt: { id: "attempt" },
      node: {
        id: "discover",
        kind: "BUILD_DISCOVER_SOURCES",
        config: { worktreeId: "worktree", name: "arbitrary_tool" },
      },
      sessionData: {},
      signal: new AbortController().signal,
    } as unknown as WorkflowExecutionContext;
    const result = await executor.execute(context);
    expect(callBuiltInTool).toHaveBeenCalledWith(
      "discover_build_sources",
      {
        worktreeId: "worktree",
        requestId: "workflow-run:discover",
      },
      {
        caller: "workflow:workflow-run",
        correlationId: "attempt",
        source: "WORKFLOW",
      },
    );
    expect(result.sessionPatch).toEqual({
      steps: { discover: { output: { sources: ["app.xcodeproj"] } } },
    });
  });

  test("routes tool error envelopes into workflow failure handling", async () => {
    const executor = new WorkflowStepExecutor();
    registerCapabilityActionAdapters(executor, {
      callBuiltInTool: vi.fn().mockResolvedValue({ isError: true }),
    });
    await expect(
      executor.execute({
        run: { id: "r" },
        attempt: { id: "a" },
        node: {
          id: "remove",
          kind: "CODEBASE_REMOVE",
          config: { id: "c" },
        },
      } as unknown as WorkflowExecutionContext),
    ).rejects.toThrow("failed");
  });
});
