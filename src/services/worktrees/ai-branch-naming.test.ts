import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_JIRA_BRANCH_NAMING_PROMPT,
  JIRA_BRANCH_GENERATE_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { WorktreesService } from "./worktrees.service";
import type { AgentControlService } from "@/services/agent-control";
import type { JiraService } from "@/services/jira";
import type { GitHubService } from "@/services/github";
const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
const branchTicket = vi.fn();
const createJob = vi.fn(async (input) => ({ ...input, id: "job-1" }));
const codebase = {
  id: "codebase-1",
  repositoryId: "repo-1",
  agentId: "agent-1",
  folder: "/repo",
  defaultBranch: "main",
  availability: "AVAILABLE",
  localBranchesJson: "[]",
  remoteBranchesJson: '["main"]',
  repository: {
    canonicalOrigin: "https://github.com/acme/repo",
    preparations: [],
  },
  agent: {
    lastSeenAt: new Date(),
    disconnectedAt: null,
    capabilitiesJson: JSON.stringify([
      "worktree.branch",
      JIRA_BRANCH_GENERATE_JOB_KIND,
      "runs.provider.codex",
    ]),
  },
};
const ticket = {
  ticketKey: "APP-1",
  ticketTitle: "Search",
  ticketType: "Story",
  projectKey: "APP",
  ticketDescription: "Details",
  branchNamingMode: "AI",
  branchNamingProvider: "CODEX",
  branchNamingModel: "model-1",
  branchNamingEffort: "low",
  branchNamingPrompt: DEFAULT_JIRA_BRANCH_NAMING_PROMPT,
};
let database: {
  agentJob: { findFirst: ReturnType<typeof vi.fn> };
  worktreeMove: { findFirst: ReturnType<typeof vi.fn> };
  codebase: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  runProviderSync: { findUnique: ReturnType<typeof vi.fn> };
};
function service() {
  return new WorktreesService(
    {
      createJob,
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService,
    { branchTicket } as unknown as JiraService,
    {} as GitHubService,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  branchTicket.mockResolvedValue(ticket);
  database = {
    agentJob: { findFirst: vi.fn().mockResolvedValue(null) },
    worktreeMove: { findFirst: vi.fn().mockResolvedValue(null) },
    codebase: {
      findUnique: vi.fn().mockResolvedValue(codebase),
      findMany: vi.fn().mockResolvedValue([
        {
          localBranchesJson: '["feature/APP-1-search"]',
          remoteBranchesJson: "[]",
          worktrees: [],
        },
      ]),
    },
    runProviderSync: {
      findUnique: vi.fn().mockResolvedValue({
        status: "COMPLETED",
        catalogJson: JSON.stringify({
          models: [{ id: "model-1", efforts: ["low"] }],
        }),
      }),
    },
  };
  getPrismaClient.mockResolvedValue(database);
});
describe("AI ticket branch orchestration", () => {
  test("metadata never invokes AI or fetches descriptions", async () => {
    const context = await service().worktreeTicketBranchContext({
      codebaseId: "codebase-1",
      ticketKey: "APP-1",
    });
    expect(context.branchName).toBeNull();
    expect(context.branchNamingMode).toBe("AI");
    expect(branchTicket).toHaveBeenCalledExactlyOnceWith("APP-1");
    expect(createJob).not.toHaveBeenCalled();
  });
  test("generation is targeted, rendered and idempotency-keyed", async () => {
    await service().generateTicketBranch({
      codebaseId: "codebase-1",
      ticketKey: "APP-1",
      requestId: "request-1",
    });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        kind: JIRA_BRANCH_GENERATE_JOB_KIND,
        timeoutSeconds: 120,
        idempotencyKey: "jira:branch:generate:request-1:codebase-1",
        payload: expect.objectContaining({
          naming: expect.objectContaining({
            prompt: expect.stringContaining("APP-1 (Story): Search"),
          }),
          takenBranches: ["feature/APP-1-search"],
        }),
      }),
    );
    expect(branchTicket).toHaveBeenCalledTimes(1);
  });
  test("description is requested only when referenced", async () => {
    branchTicket.mockResolvedValue({
      ...ticket,
      branchNamingPrompt: "{{ticket.description}}",
    });
    await service().generateTicketBranch({
      codebaseId: "codebase-1",
      ticketKey: "APP-1",
      requestId: "request-1",
    });
    expect(branchTicket).toHaveBeenCalledWith("APP-1", true);
    expect(createJob.mock.calls[0]![0].payload.naming.prompt).toBe("Details");
  });
  test("submission defers generation into the branch job", async () => {
    await service().createWorktree({
      codebaseId: "codebase-1",
      requestId: "create-1",
      selection: { mode: "TICKET", ticketKey: "APP-1", baseBranch: "main" },
    });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "worktree.branch",
        payload: expect.objectContaining({
          candidates: [],
          aiNaming: expect.objectContaining({
            naming: expect.objectContaining({ model: "model-1" }),
          }),
        }),
      }),
    );
  });
  test("an edited preview bypasses inference and resolves recorded collisions locally", async () => {
    await service().createWorktree({
      codebaseId: "codebase-1",
      requestId: "create-1",
      selection: {
        mode: "TICKET",
        ticketKey: "APP-1",
        baseBranch: "main",
        branchName: "feature/APP-1-search",
      },
    });
    const payload = createJob.mock.calls[0]![0].payload;
    expect(payload.aiNaming).toBeUndefined();
    expect(payload.candidates[0]).toBe("feature/APP-1-search-2");
    expect(database.runProviderSync.findUnique).not.toHaveBeenCalled();
  });
  test("unavailable models stop before queueing Git work", async () => {
    database.runProviderSync.findUnique.mockResolvedValue({
      catalogJson: '{"models":[]}',
    });
    await expect(
      service().createWorktree({
        codebaseId: "codebase-1",
        requestId: "create-1",
        selection: { mode: "TICKET", ticketKey: "APP-1", baseBranch: "main" },
      }),
    ).rejects.toThrow("unavailable");
    expect(createJob).not.toHaveBeenCalled();
  });
});
