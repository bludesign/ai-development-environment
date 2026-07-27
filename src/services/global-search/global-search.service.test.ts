import { beforeEach, describe, expect, test, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  agent: { findMany: vi.fn() },
  agentJob: { findMany: vi.fn() },
  codebaseRepository: { findMany: vi.fn() },
  codebase: { findMany: vi.fn() },
  worktree: { findMany: vi.fn() },
  build: { findMany: vi.fn() },
  workflow: { findMany: vi.fn() },
  workflowRun: { findMany: vi.fn() },
  workflowRunResourceLink: { findMany: vi.fn() },
  jiraCachedTicket: { findMany: vi.fn() },
  worktreePullRequest: { findMany: vi.fn() },
  gitHubPipelineRecord: { findMany: vi.fn() },
  agentRun: { findMany: vi.fn() },
  commandDefinition: { findMany: vi.fn() },
  commandRun: { findMany: vi.fn() },
  skill: { findMany: vi.fn() },
  skillGroup: { findMany: vi.fn() },
  iosDevice: { findMany: vi.fn() },
  signingProfileAsset: { findMany: vi.fn() },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: vi.fn().mockResolvedValue(prisma),
}));

import {
  GlobalSearchService,
  globalSearchScore,
} from "./global-search.service";

const searchableModels = Object.values(prisma);

describe("globalSearchScore", () => {
  test("prioritizes identifiers, exact names, prefixes, and substrings", () => {
    const identifier = globalSearchScore("AIDE-42", "Fix search", ["AIDE-42"]);
    const exactName = globalSearchScore("AIDE-42", "AIDE-42", []);
    const prefix = globalSearchScore("AIDE", "AIDE command search", []);
    const substring = globalSearchScore("command", "Global command search", []);

    expect(identifier).toBeGreaterThan(exactName ?? 0);
    expect(exactName).toBeGreaterThan(prefix ?? 0);
    expect(prefix).toBeGreaterThan(substring ?? 0);
  });

  test("requires every query token while allowing tokens across fields", () => {
    expect(
      globalSearchScore("release acme", "Release workflow", [], ["acme/app"]),
    ).not.toBeNull();
    expect(
      globalSearchScore(
        "release missing",
        "Release workflow",
        [],
        ["acme/app"],
      ),
    ).toBeNull();
  });
});

describe("GlobalSearchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const model of searchableModels) model.findMany.mockResolvedValue([]);
  });

  test("validates result and relationship limits", async () => {
    const service = new GlobalSearchService();

    await expect(service.search("search", 0)).rejects.toThrow(
      "firstPerGroup must be an integer from 1 to 10",
    );
    await expect(service.search("search", 5, 6)).rejects.toThrow(
      "relatedFirst must be an integer from 0 to 5",
    );
  });

  test("orders equally ranked records by recency", async () => {
    prisma.agent.findMany.mockResolvedValue([
      {
        id: "agent-old",
        name: "Build Agent",
        hostname: "old.local",
        disconnectedAt: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "agent-new",
        name: "Build Agent",
        hostname: "new.local",
        disconnectedAt: null,
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const result = await new GlobalSearchService().search("Build Agent", 5, 0);

    expect(result.items.map((item) => item.key)).toEqual([
      "agent:agent-new",
      "agent:agent-old",
    ]);
  });

  test("applies firstPerGroup across kinds that share a rendered group", async () => {
    prisma.agent.findMany.mockResolvedValue([
      {
        id: "agent-one",
        name: "Needle",
        hostname: "one.local",
        disconnectedAt: null,
        updatedAt: new Date("2026-06-04T00:00:00.000Z"),
      },
      {
        id: "agent-two",
        name: "Needle",
        hostname: "two.local",
        disconnectedAt: null,
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
    ]);
    prisma.agentJob.findMany.mockResolvedValue([
      {
        id: "job-one",
        kind: "Needle",
        status: "SUCCEEDED",
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        agent: { name: "Worker One", hostname: "one.local" },
      },
      {
        id: "job-two",
        kind: "Needle",
        status: "SUCCEEDED",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        agent: { name: "Worker Two", hostname: "two.local" },
      },
    ]);

    const result = await new GlobalSearchService().search("Needle", 2, 0);

    expect(
      result.items.filter((item) => item.group === "AGENTS_JOBS"),
    ).toHaveLength(2);
    expect(result.items.map((item) => item.key)).toEqual([
      "agent:agent-one",
      "agent:agent-two",
    ]);
  });

  test("keeps a worktree first, nests recent runs then builds, and encodes routes", async () => {
    prisma.worktree.findMany.mockResolvedValue([
      {
        id: "worktree/one",
        branch: "feature/AIDE-42-search",
        relativePath: "AIDE-search",
        folder: "/repos/AIDE-search",
        availability: "AVAILABLE",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        codebase: {
          repository: { name: "AIDE" },
          agent: { name: "Studio Mac" },
        },
        pullRequest: null,
      },
    ]);
    prisma.workflowRunResourceLink.findMany.mockResolvedValue([
      {
        resourceId: "worktree/one",
        runId: "workflow/run",
        run: {
          id: "workflow/run",
          displayNumber: 19,
          status: "SUCCEEDED",
          updatedAt: new Date("2026-06-02T00:00:00.000Z"),
          workflow: { name: "Release" },
        },
      },
    ]);
    prisma.build.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "build/one",
        worktreeId: "worktree/one",
        action: "BUILD",
        status: "SUCCEEDED",
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
        configuration: { name: "Debug" },
      },
    ]);

    const result = await new GlobalSearchService().search("AIDE-42", 5, 3);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      key: "worktree:worktree/one",
      href: "/worktrees/worktree%2Fone",
    });
    expect(result.items[0]?.children).toEqual([
      expect.objectContaining({
        key: "workflow-run:workflow/run",
        href: "/workflows/runs/workflow%2Frun",
      }),
      expect.objectContaining({
        key: "build:build/one",
        href: "/builds/build%2Fone",
      }),
    ]);
    expect(result.items.filter((item) => item.kind === "BUILD")).toHaveLength(
      0,
    );
    expect(
      result.items.filter((item) => item.kind === "WORKFLOW_RUN"),
    ).toHaveLength(0);
  });

  test("nests one child per run when a worktree is linked by several attempts", async () => {
    prisma.worktree.findMany.mockResolvedValue([
      {
        id: "worktree/one",
        branch: "feature/AIDE-42-search",
        relativePath: "AIDE-search",
        folder: "/repos/AIDE-search",
        availability: "AVAILABLE",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        codebase: {
          repository: { name: "AIDE" },
          agent: { name: "Studio Mac" },
        },
        pullRequest: null,
      },
    ]);
    const run = {
      id: "workflow/run",
      displayNumber: 19,
      status: "SUCCEEDED",
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      workflow: { name: "Release" },
    };
    prisma.workflowRunResourceLink.findMany.mockResolvedValue([
      { resourceId: "worktree/one", runId: run.id, run },
      { resourceId: "worktree/one", runId: run.id, run },
    ]);
    prisma.build.findMany.mockResolvedValue([]);

    const result = await new GlobalSearchService().search("AIDE-42", 5, 3);

    expect(result.items[0]?.children).toEqual([
      expect.objectContaining({ key: "workflow-run:workflow/run" }),
    ]);
  });

  test("builds encoded detail routes for every remaining primary resource kind", async () => {
    const updatedAt = new Date("2026-06-01T00:00:00.000Z");
    prisma.jiraCachedTicket.findMany.mockResolvedValue([
      {
        issueKey: "NEEDLE-1",
        projectKey: "NEEDLE",
        summaryJson: JSON.stringify({ fields: { summary: "Needle ticket" } }),
        detailJson: null,
        updatedAt,
      },
    ]);
    prisma.codebaseRepository.findMany.mockResolvedValue([
      {
        id: "repository/one",
        name: "Needle Repository",
        description: "Needle source",
        canonicalOrigin: "github.com/acme/needle",
        displayOrigin: "github.com/acme/needle",
        updatedAt,
      },
    ]);
    prisma.codebase.findMany.mockResolvedValue([
      {
        id: "codebase/one",
        folder: "Needle Codebase",
        branch: "main",
        observedOrigin: "github.com/acme/needle",
        availability: "AVAILABLE",
        updatedAt,
        repository: { name: "Needle Repository" },
        agent: { name: "Studio Mac" },
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([
      {
        id: "workflow/one",
        name: "Needle Workflow",
        description: "Needle automation",
        enabled: true,
        archivedAt: null,
        updatedAt,
      },
    ]);
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: "workflow-run/one",
        workflowId: "workflow/one",
        displayNumber: 7,
        status: "SUCCEEDED",
        triggerSubjectKey: "needle",
        updatedAt,
        workflow: { name: "Needle Workflow" },
      },
    ]);
    prisma.gitHubPipelineRecord.findMany.mockResolvedValue([
      {
        id: "pipeline/one",
        githubPipelineId: "pipeline-needle",
        workflowRunId: "remote-run/one",
        workflowId: "remote-workflow/one",
        runNumber: 8,
        name: "Needle Action",
        status: "COMPLETED",
        updatedAt,
        snapshot: { repositoryNameWithOwner: "acme/needle" },
      },
    ]);
    prisma.build.findMany.mockResolvedValue([
      {
        id: "build/one",
        requestId: "request-needle",
        action: "BUILD",
        status: "SUCCEEDED",
        commandSummary: "Needle build",
        updatedAt,
        configuration: { name: "Needle Debug" },
        worktree: null,
        codebase: { repository: { name: "Needle Repository" } },
      },
    ]);
    prisma.agent.findMany.mockResolvedValue([
      {
        id: "agent/one",
        name: "Needle Agent",
        hostname: "needle.local",
        disconnectedAt: null,
        updatedAt,
      },
    ]);
    prisma.agentJob.findMany.mockResolvedValue([
      {
        id: "job/one",
        kind: "NEEDLE_JOB",
        status: "SUCCEEDED",
        updatedAt,
        agent: { name: "Needle Agent", hostname: "needle.local" },
      },
    ]);
    prisma.agentRun.findMany.mockResolvedValue([
      {
        id: "plan/one",
        kind: "PLAN",
        displayNumber: 9,
        initialPrompt: "Needle plan",
        repositoryName: "Needle Repository",
        branch: "main",
        jiraIssueKey: null,
        model: "codex",
        status: "SUCCEEDED",
        updatedAt,
      },
      {
        id: "session/one",
        kind: "SESSION",
        displayNumber: 10,
        initialPrompt: "Needle session",
        repositoryName: "Needle Repository",
        branch: "main",
        jiraIssueKey: null,
        model: "codex",
        status: "SUCCEEDED",
        updatedAt,
      },
    ]);
    prisma.commandDefinition.findMany.mockResolvedValue([
      {
        id: "command/one",
        name: "Needle Command",
        description: "Needle script",
        script: "true",
        archivedAt: null,
        updatedAt,
      },
    ]);
    prisma.commandRun.findMany.mockResolvedValue([
      {
        id: "command-run/one",
        displayNumber: 11,
        snapshotName: "Needle Command Run",
        snapshotDescription: "Needle script",
        agentName: "Studio Mac",
        worktreeBranch: "main",
        status: "SUCCEEDED",
        updatedAt,
      },
    ]);
    prisma.skill.findMany.mockResolvedValue([
      {
        id: "skill/one",
        name: "Needle Skill",
        description: "Needle capability",
        updatedAt,
      },
    ]);
    prisma.skillGroup.findMany.mockResolvedValue([
      { id: "skill-group/one", name: "Needle Group", updatedAt },
    ]);
    prisma.iosDevice.findMany.mockResolvedValue([
      {
        id: "device/one",
        udid: "needle-udid",
        displayName: "Needle Phone",
        product: "iPhone",
        osVersion: "26.0",
        status: "REGISTERED",
        updatedAt,
      },
    ]);
    prisma.signingProfileAsset.findMany.mockResolvedValue([
      {
        id: "profile/one",
        uuid: "needle-uuid",
        name: "Needle Profile",
        bundleId: "com.acme.needle",
        teamName: "Acme",
        profileType: "DEVELOPMENT",
        expired: false,
        observedAt: updatedAt,
        agent: { name: "Studio Mac" },
      },
    ]);

    const result = await new GlobalSearchService().search("needle", 10, 0);
    const hrefByKind = Object.fromEntries(
      result.items.map((item) => [item.kind, item.href]),
    );

    expect(hrefByKind).toEqual({
      JIRA_TICKET: "/jira/tickets/NEEDLE-1",
      REPOSITORY: "/codebases/repositories/repository%2Fone",
      CODEBASE: "/codebases/codebase%2Fone",
      WORKFLOW: "/workflows/workflow%2Fone",
      WORKFLOW_RUN: "/workflows/runs/workflow-run%2Fone",
      GITHUB_ACTIONS_RUN:
        "/actions?repository=repository%2Fone&pipeline=remote-workflow%2Fone",
      BUILD: "/builds/build%2Fone",
      AGENT: "/agents/agent%2Fone",
      AGENT_JOB: "/jobs/job%2Fone",
      PLAN: "/plans/plan%2Fone",
      SESSION: "/sessions/session%2Fone",
      COMMAND: "/commands/command%2Fone/edit",
      COMMAND_RUN: "/commands/runs/command-run%2Fone",
      SKILL: "/skills/skill%2Fone",
      SKILL_GROUP: "/skills/groups/skill-group%2Fone",
      DEVICE: "/devices/device%2Fone",
      PROVISIONING_PROFILE: "/provisioning-profiles/profile%2Fone",
    });
  });

  test("uses persisted pull-request data and excludes missing local records", async () => {
    prisma.worktreePullRequest.findMany.mockResolvedValue([
      {
        githubId: "github-pr-42",
        number: 42,
        title: "Global command search",
        repositoryNameWithOwner: "acme/aide web",
        headRefName: "feature/AIDE-42",
        jiraKey: "AIDE-42",
        state: "OPEN",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        worktree: null,
      },
    ]);

    const result = await new GlobalSearchService().search("#42", 5, 0);

    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "GITHUB_PULL_REQUEST",
        href: "/pull-requests/acme/aide%20web/42",
      }),
    ]);
    expect(prisma.worktree.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          missingAt: null,
          availability: { not: "MISSING" },
        }),
      }),
    );
    expect(prisma.codebase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ availability: { not: "MISSING" } }),
      }),
    );
    expect(prisma.worktreePullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ worktree: { missingAt: null } }),
      }),
    );
    expect(prisma.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
    expect(prisma.signingProfileAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ missingAt: null }),
      }),
    );
  });
});
