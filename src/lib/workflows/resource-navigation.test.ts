import { describe, expect, test } from "vitest";

import {
  currentPageWorkflowNodeIds,
  workflowRunNodeDestinations,
} from "./resource-navigation";

const run = {
  generation: 1,
  trigger: { nodeId: "resource-trigger" },
  attempts: [
    {
      id: "old",
      nodeId: "ticket",
      generation: 0,
      iterationKey: "",
      attempt: 0,
      resourceLinks: [
        { kind: "JIRA_TICKET", resourceId: "AIDE-1", createdAt: "2026-01-01" },
      ],
    },
    {
      id: "current",
      nodeId: "ticket",
      generation: 1,
      iterationKey: "",
      attempt: 0,
      resourceLinks: [],
    },
  ],
  resourceLinks: [
    {
      kind: "WORKTREE",
      resourceId: "worktree-1",
      attemptId: null,
    },
    {
      kind: "JIRA_TICKET",
      resourceId: "AIDE-1",
      attemptId: "old",
    },
  ],
};

describe("workflow resource graph projection", () => {
  test("maps trigger-owned and attempt-owned links to graph nodes", () => {
    expect(currentPageWorkflowNodeIds(run, "WORKTREE", "worktree-1")).toEqual(
      new Set(["resource-trigger"]),
    );
    expect(currentPageWorkflowNodeIds(run, "jira_ticket", "AIDE-1")).toEqual(
      new Set(["ticket"]),
    );
  });

  test("falls back to a prior generation's navigable attempt", () => {
    expect(workflowRunNodeDestinations(run)).toEqual(
      new Map([
        ["ticket", { href: "/jira/tickets/AIDE-1", external: false }],
        [
          "resource-trigger",
          { href: "/worktrees/worktree-1", external: false },
        ],
      ]),
    );
  });
});
