import "server-only";

import { getPrismaClient } from "@/data/prisma-client";
import {
  ACTION_CENTER_CHANGED_TOPIC,
  ACTION_CENTER_SETTINGS_CHANGED_TOPIC,
  GITHUB_ACTIONS_COUNT_CHANGED_TOPIC,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
  INTEGRATION_CONFIGURATION_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import {
  actionCenterRequestCutoff,
  actionCenterSettings,
  type ActionCenterRequests,
} from "@/services/action-center/action-center-requests";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import { GITLAB_PIPELINE_STATUS_CHANGED_TOPIC } from "@/services/gitlab/gitlab.service";
import type { PollingService } from "@/services/polling";

const POLL_ID = "sidebar-integrations";
const POLL_MS = 60_000;
const EVENT_MS = 30_000;
type Provider = "github" | "gitlab";
type Snapshot = {
  key: string | null;
  configured: boolean;
  count: number | null;
  generation: number;
};

export type SidebarIntegrationCounts = {
  pullRequests: number | null;
  actions: number | null;
  mergeRequests: number | null;
  pipelines: number | null;
  activeRunsKnown: boolean;
  githubActiveRunsKnown: boolean;
  gitlabActiveRunsKnown: boolean;
};

export const EMPTY_INTEGRATION_COUNTS: SidebarIntegrationCounts = {
  pullRequests: null,
  actions: null,
  mergeRequests: null,
  pipelines: null,
  activeRunsKnown: true,
  githubActiveRunsKnown: true,
  gitlabActiveRunsKnown: true,
};

/** Provider scans run once per server, independently of the number of connected clients. */
export class SidebarIntegrationsService {
  private readonly snapshots: Record<Provider, Snapshot> = {
    github: { key: null, configured: false, count: null, generation: 0 },
    gitlab: { key: null, configured: false, count: null, generation: 0 },
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly streams: AsyncIterableIterator<unknown>[] = [];
  private running: Promise<void> | null = null;
  private active = false;
  private enabled = true;
  private settingsRevision = 0;
  private readonly pending = new Set<Provider>();
  private readonly refreshDeadlines = new Map<Provider, number>();
  private lastStarted = -Infinity;
  private readonly demandRefreshes = new Map<
    Provider,
    { generation: number; startedAt: number; pending?: Promise<void> }
  >();

  constructor(
    private readonly github: Pick<
      GitHubService,
      "getSettings" | "activeActionsCount" | "cachedActiveActionsCount"
    >,
    private readonly gitlab: Pick<
      GitLabService,
      "getSettings" | "activePipelinesCount"
    >,
    private readonly polling: PollingService,
    private readonly requests: Pick<
      ActionCenterRequests,
      "currentAccountKey" | "invalidateAccount"
    >,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.polling.register({
      id: POLL_ID,
      kind: "SIDEBAR_INTEGRATIONS",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: POLL_MS / 1_000,
      details: {},
    });
    this.observe(INTEGRATION_CONFIGURATION_CHANGED_TOPIC, (event) => {
      const changed = (
        event as { integrationConfigurationChanged?: string }
      ).integrationConfigurationChanged?.toLowerCase();
      if (changed && !["all", "github", "gitlab"].includes(changed)) return;
      for (const provider of ["github", "gitlab"] as const) {
        if (changed && changed !== "all" && changed !== provider) continue;
        const snapshot = this.snapshots[provider];
        ++snapshot.generation;
      }
      this.publish();
      this.requestRefresh(
        true,
        changed && changed !== "all"
          ? [changed as Provider]
          : ["github", "gitlab"],
      );
    });
    this.observe(GITLAB_PIPELINE_STATUS_CHANGED_TOPIC, () =>
      this.requestRefresh(false, ["gitlab"]),
    );
    const refreshCachedActions = () => {
      if (!this.enabled && !this.demandRefreshes.has("github")) return;
      const generation = this.snapshots.github.generation;
      void this.github
        .cachedActiveActionsCount()
        .then((count) => {
          if (
            !this.active ||
            (!this.enabled && !this.demandRefreshes.has("github")) ||
            generation !== this.snapshots.github.generation
          )
            return;
          if (count !== null && this.snapshots.github.configured)
            this.snapshots.github.count = count;
          this.publish();
        })
        .catch(() => undefined);
    };
    this.observe(GITHUB_ACTIONS_COUNT_CHANGED_TOPIC, refreshCachedActions);
    this.observe(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC, refreshCachedActions);
    // Reconciliation and age-setting changes affect request totals without scanning CI again.
    this.observe(ACTION_CENTER_CHANGED_TOPIC, () => this.publish());
    this.observe(ACTION_CENTER_SETTINGS_CHANGED_TOPIC, (event) => {
      const { actionCenterSettingsChanged: settings } = event as {
        actionCenterSettingsChanged: {
          showIntegrationCountsInSidebar: boolean;
        };
      };
      ++this.settingsRevision;
      const wasEnabled = this.enabled;
      this.setEnabled(settings.showIntegrationCountsInSidebar);
      if (!wasEnabled && this.enabled) this.requestRefresh(true);
    });
    void this.refresh();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.refreshDeadlines.clear();
    this.pending.clear();
    for (const stream of this.streams.splice(0)) void stream.return?.();
    for (const snapshot of Object.values(this.snapshots)) ++snapshot.generation;
  }

  private observe(topic: string, onEvent: (event: unknown) => void): void {
    const stream = agentEventBus.iterate(topic);
    this.streams.push(stream);
    void (async () => {
      for await (const event of stream) {
        if (!this.active) return;
        onEvent(event);
      }
    })();
  }

  private setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.polling.configure(POLL_ID, { enabled });
    if (!enabled) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.refreshDeadlines.clear();
      this.pending.clear();
      for (const snapshot of Object.values(this.snapshots)) {
        ++snapshot.generation;
        snapshot.count = null;
      }
    }
  }

  private schedule(
    delay: number,
    providers: Provider[] = ["github", "gitlab"],
  ): void {
    if (!this.active || !this.enabled) return;
    const deadline = Date.now() + delay;
    for (const provider of providers)
      this.refreshDeadlines.set(
        provider,
        Math.min(this.refreshDeadlines.get(provider) ?? Infinity, deadline),
      );
    const nextDeadline = Math.min(...this.refreshDeadlines.values());
    if (this.timer) clearTimeout(this.timer);
    this.polling.schedule(POLL_ID, new Date(nextDeadline));
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const dueProviders = [...this.refreshDeadlines]
          .filter(([, refreshAt]) => refreshAt <= Date.now())
          .map(([provider]) => provider);
        void this.refresh(dueProviders);
      },
      Math.max(0, nextDeadline - Date.now()),
    );
    this.timer.unref?.();
  }

  private requestRefresh(
    immediate = false,
    providers: Provider[] = ["github", "gitlab"],
  ): void {
    if (!this.active || !this.enabled) return;
    if (this.running) {
      for (const provider of providers) this.pending.add(provider);
      return;
    }
    this.schedule(
      immediate ? 0 : Math.max(0, this.lastStarted + EVENT_MS - Date.now()),
      providers,
    );
  }

  private async configuration(provider: Provider): Promise<Snapshot> {
    const settings =
      provider === "github"
        ? await this.github.getSettings()
        : await this.gitlab.getSettings();
    const configured =
      "configured" in settings ? settings.configured : settings.tokenConfigured;
    const key = JSON.stringify([
      configured,
      settings.updatedAt,
      "baseUrl" in settings ? settings.baseUrl : null,
      "viewer" in settings ? settings.viewer?.id : null,
    ]);
    const snapshot = this.snapshots[provider];
    if (snapshot.key !== key) {
      if (snapshot.key !== null)
        this.requests.invalidateAccount(
          provider === "github" ? "GITHUB" : "GITLAB",
        );
      snapshot.key = key;
      snapshot.configured = configured;
      snapshot.count = null;
      ++snapshot.generation;
    }
    return snapshot;
  }

  async refresh(providers: Provider[] = ["github", "gitlab"]): Promise<void> {
    if (!this.active) return;
    if (this.running) {
      return this.running;
    }
    this.lastStarted = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const provider of providers) this.refreshDeadlines.delete(provider);
    this.polling.schedule(POLL_ID, null);
    this.running = this.polling
      .run(POLL_ID, async () => {
        const revision = this.settingsRevision;
        const settings = await actionCenterSettings();
        if (revision === this.settingsRevision)
          this.setEnabled(settings.showIntegrationCountsInSidebar);
        if (!this.active || !this.enabled) return;
        const failures: string[] = [];
        // Each provider bounds its scan to four requests; sequential scans preserve that global limit.
        for (const provider of providers) {
          if (!this.active || !this.enabled) return;
          const previous = this.snapshots[provider].count;
          const beforeConfiguration = this.snapshots[provider].generation;
          try {
            const snapshot = await this.configuration(provider);
            if (!this.active || !this.enabled) return;
            const generation = snapshot.generation;
            if (snapshot.configured) {
              const count =
                provider === "github"
                  ? await this.github.activeActionsCount()
                  : await this.gitlab.activePipelinesCount();
              if (!this.active || !this.enabled) return;
              if (generation !== snapshot.generation) continue;
              snapshot.count = count;
            }
          } catch (error) {
            failures.push(
              `${provider}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (
            previous !== this.snapshots[provider].count ||
            beforeConfiguration !== this.snapshots[provider].generation
          )
            this.publish();
        }
        if (failures.length) throw new Error(failures.join("; "));
      })
      .catch((error) => {
        console.error(
          "Sidebar integration refresh failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        this.running = null;
        this.schedule(POLL_MS, providers);
        if (this.pending.size) {
          const nextProviders = [...this.pending];
          this.pending.clear();
          this.schedule(
            Math.max(0, this.lastStarted + EVENT_MS - Date.now()),
            nextProviders,
          );
        }
      });
    return this.running;
  }

  async counts({
    includeHiddenActivity = false,
    selectedActivityProviders = { github: true, gitlab: true },
  }: {
    includeHiddenActivity?: boolean;
    selectedActivityProviders?: { github: boolean; gitlab: boolean };
  } = {}): Promise<SidebarIntegrationCounts> {
    const settings = await actionCenterSettings();
    if (!settings.showIntegrationCountsInSidebar && !includeHiddenActivity)
      return EMPTY_INTEGRATION_COUNTS;
    const [githubConfiguration, gitlabConfiguration, prisma] =
      await Promise.all([
        this.configuration("github").catch(() => null),
        this.configuration("gitlab").catch(() => null),
        getPrismaClient(),
      ]);
    const cutoff = actionCenterRequestCutoff(settings.maximumRequestAgeDays);
    const requests = await prisma.actionCenterRequest.groupBy({
      by: ["provider", "accountKey"],
      where: {
        OR: [{ isMine: true }, { requiresMyApproval: true }],
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
      },
      _count: { _all: true },
    });
    const total = (provider: "GITHUB" | "GITLAB") => {
      const accountKey = this.requests.currentAccountKey(provider);
      return accountKey
        ? (requests.find(
            (row) => row.provider === provider && row.accountKey === accountKey,
          )?._count._all ?? 0)
        : null;
    };
    const github = githubConfiguration ?? this.snapshots.github;
    const gitlab = gitlabConfiguration ?? this.snapshots.gitlab;
    if (includeHiddenActivity && !settings.showIntegrationCountsInSidebar) {
      // Native consumers can select CI independently of sidebar visibility. Scan on demand,
      // at most once per minute per provider, without enabling the sidebar's poll timer.
      if (githubConfiguration && selectedActivityProviders.github)
        await this.refreshOnDemand("github", github);
      if (gitlabConfiguration && selectedActivityProviders.gitlab)
        await this.refreshOnDemand("gitlab", gitlab);
    }
    const actions = github.configured ? github.count : null;
    const pipelines = gitlab.configured ? gitlab.count : null;
    const githubActiveRunsKnown =
      githubConfiguration !== null && (!github.configured || actions !== null);
    const gitlabActiveRunsKnown =
      gitlabConfiguration !== null &&
      (!gitlab.configured || pipelines !== null);
    return {
      pullRequests: github.configured ? total("GITHUB") : null,
      actions,
      mergeRequests: gitlab.configured ? total("GITLAB") : null,
      pipelines,
      activeRunsKnown: githubActiveRunsKnown && gitlabActiveRunsKnown,
      githubActiveRunsKnown,
      gitlabActiveRunsKnown,
    };
  }

  private async refreshOnDemand(
    provider: Provider,
    snapshot: Snapshot,
  ): Promise<void> {
    if (!snapshot.configured) return;
    const previous = this.demandRefreshes.get(provider);
    if (previous?.generation === snapshot.generation) {
      if (previous.pending) return previous.pending;
      if (Date.now() - previous.startedAt < POLL_MS) return;
    }
    const generation = snapshot.generation;
    const refresh: {
      generation: number;
      startedAt: number;
      pending?: Promise<void>;
    } = { generation, startedAt: Date.now() };
    refresh.pending = (async () => {
      try {
        const count =
          provider === "github"
            ? await this.github.activeActionsCount()
            : await this.gitlab.activePipelinesCount();
        if (snapshot.generation === generation) snapshot.count = count;
      } catch {
        // Preserve this connection's last successful count; an unseen provider remains unknown.
      } finally {
        refresh.pending = undefined;
      }
    })();
    this.demandRefreshes.set(provider, refresh);
    return refresh.pending;
  }

  private publish(): void {
    agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
      sidebarStatusChanged: true,
    });
  }
}
