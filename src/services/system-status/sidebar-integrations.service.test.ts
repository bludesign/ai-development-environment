// @vitest-environment node
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  ACTION_CENTER_CHANGED_TOPIC,
  ACTION_CENTER_SETTINGS_CHANGED_TOPIC,
  GITHUB_ACTIONS_COUNT_CHANGED_TOPIC,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
  INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import type { PollingService } from "@/services/polling";
import { GITLAB_PIPELINE_STATUS_CHANGED_TOPIC } from "@/services/gitlab/gitlab.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { SidebarIntegrationsService } from "./sidebar-integrations.service";

function dependencies() {
  const github = {
    getSettings: vi
      .fn()
      .mockResolvedValue({ tokenConfigured: true, updatedAt: "github-1" }),
    activeActionsCount: vi.fn().mockResolvedValue(4),
    cachedActiveActionsCount: vi.fn().mockResolvedValue(4),
  };
  const gitlab = {
    getSettings: vi.fn().mockResolvedValue({
      configured: true,
      updatedAt: "gitlab-1",
      baseUrl: "https://gitlab.example.com",
      viewer: { id: "1" },
    }),
    activePipelinesCount: vi.fn().mockResolvedValue(5),
  };
  const polling = {
    register: vi.fn(),
    configure: vi.fn(),
    schedule: vi.fn(),
    run: vi.fn(async (_id: string, work: () => Promise<unknown>) => work()),
  };
  const requests = {
    currentAccountKey: vi.fn().mockReturnValue("viewer"),
    invalidateAccount: vi.fn(),
  };
  const service = new SidebarIntegrationsService(
    github,
    gitlab,
    polling as unknown as PollingService,
    requests,
  );
  return { github, gitlab, polling, service, requests };
}

describe("sidebar integration request counts", () => {
  let prisma: PrismaClient;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
    });
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ActionCenterSettings (id TEXT PRIMARY KEY, maximumRequestAgeDays INTEGER, showMyRequestsInSidebar BOOLEAN, showReviewRequestsInSidebar BOOLEAN, confirmClearAllNotifications BOOLEAN NOT NULL DEFAULT true, showIntegrationCountsInSidebar BOOLEAN NOT NULL DEFAULT true, showWorktreeCountsInSidebar BOOLEAN NOT NULL DEFAULT true, hideUnapprovedRequestsInSidebar BOOLEAN NOT NULL DEFAULT true, hideRunningPipelineRequestsInSidebar BOOLEAN NOT NULL DEFAULT true, updatedAt DATETIME)`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ActionCenterRequest (id TEXT PRIMARY KEY, provider TEXT, accountKey TEXT, resourceKind TEXT, reason TEXT, isMine BOOLEAN, requiresMyApproval BOOLEAN, payloadJson TEXT, createdAt DATETIME, updatedAt DATETIME)`,
    );
    getPrismaClient.mockResolvedValue(prisma);
    for (const provider of ["GITHUB", "GITLAB"]) {
      await prisma.actionCenterRequest.createMany({
        data: [
          {
            id: `${provider}:mine-approved`,
            isMine: true,
            requiresMyApproval: false,
            age: 1,
          },
          {
            id: `${provider}:review`,
            isMine: false,
            requiresMyApproval: true,
            age: 2,
          },
          {
            id: `${provider}:overlap`,
            isMine: true,
            requiresMyApproval: true,
            age: 3,
          },
          {
            id: `${provider}:already-approved`,
            isMine: false,
            requiresMyApproval: false,
            age: 1,
          },
          {
            id: `${provider}:boundary`,
            isMine: true,
            requiresMyApproval: false,
            age: 30,
          },
          {
            id: `${provider}:old`,
            isMine: true,
            requiresMyApproval: false,
            age: 31,
          },
        ].map(({ age, ...row }) => ({
          ...row,
          provider,
          accountKey: "viewer",
          resourceKind:
            provider === "GITHUB" ? "PULL_REQUEST" : "MERGE_REQUEST",
          reason: "ACTIVE",
          payloadJson: "{}",
          createdAt: new Date(Date.now() - age * 86_400_000),
          updatedAt: new Date(),
        })),
      });
    }
  });
  afterEach(async () => {
    await prisma.$disconnect();
    vi.useRealTimers();
  });

  test("deduplicates Mine/review, excludes personally approved review-only rows, and includes the age boundary", async () => {
    const { service, github, gitlab } = dependencies();
    expect(await service.counts()).toEqual({
      pullRequests: 4,
      mergeRequests: 4,
      actions: null,
      pipelines: null,
    });
    // Reading status never scans providers.
    await service.counts();
    expect(github.activeActionsCount).not.toHaveBeenCalled();
    expect(gitlab.activePipelinesCount).not.toHaveBeenCalled();
    await prisma.actionCenterRequest.delete({ where: { id: "GITHUB:review" } });
    expect((await service.counts()).pullRequests).toBe(3);
  });

  test("applies changed ages immediately and ignores sidebar category switches", async () => {
    const { service } = dependencies();
    await prisma.actionCenterSettings.create({
      data: {
        id: "default",
        maximumRequestAgeDays: 2,
        showMyRequestsInSidebar: false,
        showReviewRequestsInSidebar: false,
      },
    });
    expect((await service.counts()).pullRequests).toBe(2);
    await prisma.actionCenterSettings.update({
      where: { id: "default" },
      data: { maximumRequestAgeDays: 0 },
    });
    expect((await service.counts()).mergeRequests).toBe(5);
  });

  test("returns null for disconnected providers and zero for configured empty providers", async () => {
    const { service, github } = dependencies();
    github.getSettings.mockResolvedValue({
      tokenConfigured: false,
      updatedAt: "github-2",
    });
    await prisma.actionCenterRequest.deleteMany({
      where: { provider: "GITLAB" },
    });
    expect(await service.counts()).toEqual({
      pullRequests: null,
      actions: null,
      mergeRequests: 0,
      pipelines: null,
    });
  });

  test("disabled counters skip provider configuration and request aggregation", async () => {
    const { service, github, gitlab } = dependencies();
    await prisma.actionCenterSettings.create({
      data: { id: "default", showIntegrationCountsInSidebar: false },
    });
    expect(await service.counts()).toEqual({
      pullRequests: null,
      actions: null,
      mergeRequests: null,
      pipelines: null,
    });
    expect(github.getSettings).not.toHaveBeenCalled();
    expect(gitlab.getSettings).not.toHaveBeenCalled();
  });

  test("never counts rows from a previous account or an unresolved new account", async () => {
    const { service, requests } = dependencies();
    requests.currentAccountKey.mockReturnValue(undefined);
    expect((await service.counts()).pullRequests).toBeNull();
    requests.currentAccountKey.mockReturnValue("new-viewer");
    expect((await service.counts()).pullRequests).toBe(0);
    await prisma.actionCenterRequest.update({
      where: { id: "GITHUB:review" },
      data: { accountKey: "new-viewer" },
    });
    expect((await service.counts()).pullRequests).toBe(1);
  });
});

describe("sidebar CI refresh lifecycle", () => {
  let current: ReturnType<typeof dependencies>;
  beforeEach(() => {
    vi.useFakeTimers();
    current = dependencies();
    getPrismaClient.mockResolvedValue({
      actionCenterSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      actionCenterRequest: { groupBy: vi.fn().mockResolvedValue([]) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    current.service.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("does not scan providers when the saved preference is off at startup", async () => {
    getPrismaClient.mockResolvedValue({
      actionCenterSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ showIntegrationCountsInSidebar: false }),
      },
    });
    current.service.start();
    await current.service.refresh();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(current.github.activeActionsCount).not.toHaveBeenCalled();
    expect(current.gitlab.activePipelinesCount).not.toHaveBeenCalled();
    expect(current.polling.configure).toHaveBeenCalledWith(
      "sidebar-integrations",
      { enabled: false },
    );
  });

  test("stops scans on disable and resumes when re-enabled", async () => {
    const { service, github, gitlab } = current;
    service.start();
    await service.refresh();
    agentEventBus.publish(ACTION_CENTER_SETTINGS_CHANGED_TOPIC, {
      actionCenterSettingsChanged: { showIntegrationCountsInSidebar: false },
    });
    await vi.advanceTimersByTimeAsync(0);
    agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "ALL",
    });
    agentEventBus.publish(GITLAB_PIPELINE_STATUS_CHANGED_TOPIC, {});
    await vi.advanceTimersByTimeAsync(180_000);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    expect(gitlab.activePipelinesCount).toHaveBeenCalledOnce();
    agentEventBus.publish(ACTION_CENTER_SETTINGS_CHANGED_TOPIC, {
      actionCenterSettingsChanged: { showIntegrationCountsInSidebar: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(github.activeActionsCount).toHaveBeenCalledTimes(2);
    expect(gitlab.activePipelinesCount).toHaveBeenCalledTimes(2);
  });

  test("disabling during a scan discards its result and skips the next provider", async () => {
    const { service, github, gitlab } = current;
    let finish: (count: number) => void = () => undefined;
    github.activeActionsCount.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    getPrismaClient.mockResolvedValue({
      actionCenterSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ showIntegrationCountsInSidebar: false }),
      },
    });
    agentEventBus.publish(ACTION_CENTER_SETTINGS_CHANGED_TOPIC, {
      actionCenterSettingsChanged: { showIntegrationCountsInSidebar: false },
    });
    await vi.advanceTimersByTimeAsync(0);
    finish(99);
    await service.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gitlab.activePipelinesCount).not.toHaveBeenCalled();
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    expect(await service.counts()).toEqual({
      pullRequests: null,
      actions: null,
      mergeRequests: null,
      pipelines: null,
    });
  });

  test("refreshes at startup and every minute; provider errors preserve the last successful total", async () => {
    const { service, github, gitlab } = current;
    service.start();
    await service.refresh();
    expect(await service.counts()).toMatchObject({ actions: 4, pipelines: 5 });
    github.activeActionsCount.mockRejectedValueOnce(new Error("rate limited"));
    gitlab.activePipelinesCount.mockResolvedValue(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await service.counts()).toMatchObject({ actions: 4, pipelines: 7 });
    expect(github.activeActionsCount).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      "Sidebar integration refresh failed:",
      expect.stringContaining("rate limited"),
    );
  });

  test("pipeline observations never scan CI and request invalidations only publish local counts", async () => {
    const { service, github } = current;
    service.start();
    await service.refresh();
    for (let i = 0; i < 5; ++i)
      agentEventBus.publish(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC, {});
    await vi.advanceTimersByTimeAsync(29_000);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    const stream = agentEventBus.iterate(SIDEBAR_STATUS_CHANGED_TOPIC);
    agentEventBus.publish(ACTION_CENTER_CHANGED_TOPIC, {
      actionCenterChanged: true,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { sidebarStatusChanged: true },
    });
    await stream.return?.();
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
  });

  test("inventory count events update the sidebar without scanning either provider", async () => {
    const { service, github, gitlab } = current;
    service.start();
    await service.refresh();
    github.cachedActiveActionsCount.mockResolvedValue(9);
    agentEventBus.publish(GITHUB_ACTIONS_COUNT_CHANGED_TOPIC, {
      githubActionsCountChanged: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.counts()).actions).toBe(9);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
    expect(gitlab.activePipelinesCount).toHaveBeenCalledOnce();
  });

  test("GitHub configuration refreshes never initiate GitLab scans", async () => {
    const { service, github, gitlab } = current;
    service.start();
    await service.refresh();
    agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "github",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(github.activeActionsCount).toHaveBeenCalledTimes(2);
    expect(gitlab.activePipelinesCount).toHaveBeenCalledOnce();
  });

  test.each(["github", "gitlab"] as const)(
    "frequent %s events preserve the other provider's periodic refresh",
    async (provider) => {
      const { service, github, gitlab } = current;
      service.start();
      await service.refresh();
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        if (provider === "gitlab")
          agentEventBus.publish(GITLAB_PIPELINE_STATUS_CHANGED_TOPIC, {});
        else
          agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
            integrationConfigurationChanged: "github",
          });
        await vi.advanceTimersByTimeAsync(0);
      }
      const other =
        provider === "gitlab"
          ? github.activeActionsCount
          : gitlab.activePipelinesCount;
      expect(other).toHaveBeenCalledTimes(21);
    },
  );

  test("coalesces simultaneous configuration changes for both providers", async () => {
    const { service, github, gitlab } = current;
    service.start();
    await service.refresh();
    for (const provider of ["github", "gitlab"])
      agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
        integrationConfigurationChanged: provider,
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(github.activeActionsCount).toHaveBeenCalledTimes(2);
    expect(gitlab.activePipelinesCount).toHaveBeenCalledTimes(2);
  });

  test("ordinary provider mutations preserve totals when the same connection's refresh fails", async () => {
    const { service, github, requests } = current;
    service.start();
    await service.refresh();
    github.activeActionsCount.mockRejectedValueOnce(
      new Error("temporarily unavailable"),
    );
    agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "github",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.counts()).actions).toBe(4);
    expect(requests.invalidateAccount).not.toHaveBeenCalled();
  });

  test("clears totals on account changes and discards an old account's in-flight result", async () => {
    const { service, github } = current;
    let finish: (value: number) => void = () => undefined;
    github.activeActionsCount.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    github.getSettings.mockResolvedValue({
      tokenConfigured: true,
      updatedAt: "github-2",
    });
    agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "github",
    });
    await vi.advanceTimersByTimeAsync(0);
    finish(99);
    await service.refresh();
    expect((await service.counts()).actions).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await service.counts()).actions).toBe(4);
    github.getSettings.mockResolvedValue({
      tokenConfigured: false,
      updatedAt: "github-3",
    });
    agentEventBus.publish(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, {
      integrationConfigurationChanged: "github",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.counts()).actions).toBeNull();
  });

  test("stops polling and removes listeners", async () => {
    const { service, github } = current;
    service.start();
    await service.refresh();
    service.stop();
    agentEventBus.publish(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC, {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(github.activeActionsCount).toHaveBeenCalledOnce();
  });
});
