import { describe, expect, test } from "vitest";

import {
  preferredWorkflowResourceDestination,
  pullRequestResourceId,
  workflowResourceDestination,
  workflowTriggerResourceLink,
} from "./resources";

describe("workflow resource navigation", () => {
  test("derives encoded internal detail routes", () => {
    expect(
      workflowResourceDestination({
        kind: "JIRA_TICKET",
        resourceId: "AIDE 42",
      }),
    ).toEqual({ href: "/jira/tickets/AIDE%2042", external: false });
    expect(
      workflowResourceDestination({
        kind: "PULL_REQUEST",
        resourceId: pullRequestResourceId("Open AI", "Codex App", 17),
        url: "https://github.com/openai/codex/pull/17",
      }),
    ).toEqual({
      href: "/pull-requests/open%20ai/codex%20app/17",
      external: false,
    });
  });

  test("prefers explicit app routes and safely falls back to provider URLs", () => {
    expect(
      workflowResourceDestination({
        kind: "BUILD",
        resourceId: "build-1",
        url: "/builds/build-1/coverage",
      }),
    ).toEqual({ href: "/builds/build-1/coverage", external: false });
    expect(
      workflowResourceDestination({
        kind: "GITHUB_WORKFLOW_RUN",
        resourceId: "88",
        url: "https://github.com/openai/codex/actions/runs/88",
      }),
    ).toEqual({
      href: "https://github.com/openai/codex/actions/runs/88",
      external: true,
    });
    expect(
      workflowResourceDestination({
        kind: "UNKNOWN",
        resourceId: "value",
        url: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  test("prefers domain resources over operational jobs", () => {
    expect(
      preferredWorkflowResourceDestination([
        { kind: "AGENT_JOB", resourceId: "job-1" },
        { kind: "WORKTREE", resourceId: "worktree-1" },
      ]),
    ).toEqual({ href: "/worktrees/worktree-1", external: false });
  });

  test("maps trigger payloads to their primary resources", () => {
    expect(
      workflowTriggerResourceLink("RUN_COMPLETED", {
        sessionData: { run: { id: "run-1", kind: "PLAN" } },
      }),
    ).toEqual({
      kind: "AGENT_RUN",
      resourceId: "run-1",
      metadata: { runKind: "PLAN" },
    });
    expect(
      workflowTriggerResourceLink("GITHUB_PR_STATE", {
        sessionData: {
          repo: { displayOrigin: "git@github.com:OpenAI/Codex.git" },
          pr: { number: 42 },
        },
      }),
    ).toEqual({ kind: "PULL_REQUEST", resourceId: "openai/codex#42" });
    expect(
      workflowTriggerResourceLink("GITHUB_REVIEW_COMMENT", {
        sessionData: {
          repo: { displayOrigin: "OpenAI/Codex" },
          pr: { number: 43 },
        },
      }),
    ).toEqual({ kind: "PULL_REQUEST", resourceId: "openai/codex#43" });
    expect(
      workflowTriggerResourceLink("SCHEDULE", { sessionData: {} }),
    ).toBeNull();
    expect(
      workflowTriggerResourceLink("WORKTREE_CREATED", {
        sessionData: { worktree: { id: "worktree-1" } },
      }),
    ).toEqual({ kind: "WORKTREE", resourceId: "worktree-1" });
  });
});
