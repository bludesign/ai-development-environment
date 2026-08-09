import "server-only";

import { randomUUID } from "node:crypto";

import {
  CLI_HEALTH_JOB_KIND,
  type CliHealthCheckDefinition,
  type CliHealthCheckResult,
  type CliHealthJobResult,
} from "@ai-development-environment/agent-contract/cli-health";

import rootPackage from "../../../package.json";
import controlAgentPackage from "../../../packages/control-agent/package.json";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  agentOnlineWindowMs,
  CLI_HEALTH_CHANGED_TOPIC,
  type AgentControlService,
} from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";

const SETTINGS_ID = "default";
const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "CANCELLING"];
const MAX_CUSTOM_CHECKS = 20;

const BUILT_IN_CHECKS: CliHealthCheckDefinition[] = [
  {
    id: "builtin-acli-jira",
    name: "Atlassian Jira",
    command: "acli jira auth status",
    builtIn: true,
  },
  {
    id: "builtin-acli",
    name: "Atlassian CLI",
    command: "acli auth status",
    builtIn: true,
  },
  {
    id: "builtin-claude",
    name: "Claude",
    command: "claude auth status",
    builtIn: true,
  },
  {
    id: "builtin-codex",
    name: "Codex",
    command: "codex login status",
    builtIn: true,
  },
  {
    id: "builtin-opencode",
    name: "OpenCode",
    command: "opencode auth list",
    builtIn: true,
  },
  {
    id: "builtin-xcode",
    name: "Xcode",
    command: "xcodebuild -version",
    builtIn: true,
  },
];

const GITHUB_CHECK: CliHealthCheckDefinition = {
  id: "builtin-github",
  name: "GitHub",
  command: "gh auth status",
  builtIn: true,
};
const GITLAB_CHECK: CliHealthCheckDefinition = {
  id: "builtin-gitlab",
  name: "GitLab",
  command: "glab auth status",
  builtIn: true,
};

export type CustomCliHealthCheck = {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
};

export type CliHealthResultView = CliHealthCheckDefinition & {
  state: "HEALTHY" | "UNHEALTHY" | "NOT_RUN";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  checkedAt: string | null;
  timedOut: boolean;
  launchError: string | null;
  outputTruncated: boolean;
};

type AgentRecord = Awaited<
  ReturnType<AgentControlService["listAgents"]>
>[number];

function capabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function isOnline(agent: AgentRecord): boolean {
  return Boolean(
    agent.lastSeenAt &&
    Date.now() - agent.lastSeenAt.getTime() <= agentOnlineWindowMs(agent) &&
    agent.disconnectedAt === null,
  );
}

function parseCustomChecks(
  value: string | null | undefined,
): CustomCliHealthCheck[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((check): check is CustomCliHealthCheck =>
      Boolean(
        check &&
        typeof check === "object" &&
        typeof (check as CustomCliHealthCheck).id === "string" &&
        typeof (check as CustomCliHealthCheck).name === "string" &&
        typeof (check as CustomCliHealthCheck).command === "string" &&
        typeof (check as CustomCliHealthCheck).enabled === "boolean",
      ),
    );
  } catch {
    return [];
  }
}

function parseJobResult(value: string | null): CliHealthJobResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CliHealthJobResult>;
    return Array.isArray(parsed.checks) ? (parsed as CliHealthJobResult) : null;
  } catch {
    return null;
  }
}

function validateCustomChecks(
  input: Array<Partial<CustomCliHealthCheck>>,
): CustomCliHealthCheck[] {
  if (input.length > MAX_CUSTOM_CHECKS) {
    throw new Error(
      `At most ${MAX_CUSTOM_CHECKS} custom CLI health checks are allowed`,
    );
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  return input.map((raw) => {
    const name = raw.name?.trim() ?? "";
    const command = raw.command?.trim() ?? "";
    const id = raw.id?.trim() || randomUUID();
    if (!name || name.length > 100 || name.includes("\0"))
      throw new Error(
        "Check names must be between 1 and 100 characters and cannot contain NUL characters",
      );
    if (!command || command.length > 4_096 || command.includes("\0")) {
      throw new Error(
        "Check commands must be between 1 and 4096 characters and cannot contain NUL characters",
      );
    }
    const normalized = name.toLocaleLowerCase();
    if (names.has(normalized))
      throw new Error("Custom check names must be unique");
    if (
      id.length > 100 ||
      id.includes("\0") ||
      id.startsWith("builtin-") ||
      ids.has(id)
    ) {
      throw new Error("Custom check identifiers must be unique and valid");
    }
    names.add(normalized);
    ids.add(id);
    return {
      id,
      name,
      command,
      enabled: raw.enabled !== false,
    };
  });
}

export class CliHealthService {
  private readonly startingAgents = new Set<string>();

  constructor(
    private readonly agentControl: AgentControlService,
    private readonly gitHub: GitHubService,
    private readonly gitLab: GitLabService,
  ) {
    this.agentControl.registerCompletionObserver(async (job) => {
      if (job.kind === CLI_HEALTH_JOB_KIND) this.publish(job.agentId);
    });
  }

  private publish(agentId: string | null): void {
    agentEventBus.publish(CLI_HEALTH_CHANGED_TOPIC, {
      cliHealthStatusChanged: { agentId },
    });
  }

  private async customChecks(): Promise<CustomCliHealthCheck[]> {
    const prisma = await getPrismaClient();
    const settings = await prisma.cliHealthSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    return parseCustomChecks(settings?.checksJson);
  }

  async definitions(): Promise<{
    checks: CliHealthCheckDefinition[];
    customChecks: CustomCliHealthCheck[];
  }> {
    const [customChecks, github, gitlab] = await Promise.all([
      this.customChecks(),
      this.gitHub.getSettings(),
      this.gitLab.getSettings(),
    ]);
    return {
      checks: [
        ...BUILT_IN_CHECKS,
        ...(github.tokenConfigured ? [GITHUB_CHECK] : []),
        ...(gitlab.configured ? [GITLAB_CHECK] : []),
        ...customChecks
          .filter((check) => check.enabled)
          .map(({ enabled: _enabled, ...check }) => ({
            ...check,
            builtIn: false,
          })),
      ],
      customChecks,
    };
  }

  private resultViews(
    definitions: CliHealthCheckDefinition[],
    result: CliHealthJobResult | null,
  ): CliHealthResultView[] {
    const byId = new Map(
      (result?.checks ?? []).map((check: CliHealthCheckResult) => [
        check.id,
        check,
      ]),
    );
    return definitions.map((definition) => {
      const value = byId.get(definition.id);
      if (!value) {
        return {
          ...definition,
          state: "NOT_RUN",
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: null,
          checkedAt: null,
          timedOut: false,
          launchError: null,
          outputTruncated: false,
        };
      }
      return {
        ...value,
        ...definition,
        state:
          value.exitCode === 0 && !value.timedOut && !value.launchError
            ? "HEALTHY"
            : "UNHEALTHY",
      };
    });
  }

  async agentStatus(
    agent: AgentRecord,
    definitions?: CliHealthCheckDefinition[],
  ) {
    const prisma = await getPrismaClient();
    const checks = definitions ?? (await this.definitions()).checks;
    const [activeJob, completedJob] = await Promise.all([
      prisma.agentJob.findFirst({
        where: {
          agentId: agent.id,
          kind: CLI_HEALTH_JOB_KIND,
          status: { in: ACTIVE_STATUSES },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.agentJob.findFirst({
        where: {
          agentId: agent.id,
          kind: CLI_HEALTH_JOB_KIND,
          status: "SUCCEEDED",
        },
        orderBy: { finishedAt: "desc" },
      }),
    ]);
    const supported = capabilities(agent.capabilitiesJson).includes(
      CLI_HEALTH_JOB_KIND,
    );
    const results = this.resultViews(
      checks,
      parseJobResult(completedJob?.resultJson ?? null),
    );
    const completed = results.filter((result) => result.state !== "NOT_RUN");
    const overall = !supported
      ? "UNSUPPORTED"
      : activeJob
        ? "RUNNING"
        : completed.length === 0
          ? "NOT_CHECKED"
          : completed.length === results.length &&
              completed.every((result) => result.state === "HEALTHY")
            ? "HEALTHY"
            : "ISSUES";
    return {
      agentId: agent.id,
      name: agent.name,
      hostname: agent.hostname,
      version: agent.version,
      connectionStatus: isOnline(agent) ? "ONLINE" : "OFFLINE",
      supported,
      activeJobId: activeJob?.id ?? null,
      lastCheckedAt: completedJob?.finishedAt?.toISOString() ?? null,
      overall,
      results,
    };
  }

  async installationStatus() {
    const [{ checks, customChecks }, agents] = await Promise.all([
      this.definitions(),
      this.agentControl.listAgents(),
    ]);
    return {
      version: process.env.AIDE_VERSION || rootPackage.version,
      dependencies: [
        { name: "Next.js", version: rootPackage.dependencies.next },
        {
          name: "Claude SDK",
          version:
            controlAgentPackage.dependencies["@anthropic-ai/claude-agent-sdk"],
        },
        {
          name: "Codex SDK",
          version: controlAgentPackage.dependencies["@openai/codex-sdk"],
        },
        {
          name: "OpenCode SDK",
          version: controlAgentPackage.dependencies["@opencode-ai/sdk"],
        },
      ],
      customChecks,
      agents: await Promise.all(
        agents.map((agent) => this.agentStatus(agent, checks)),
      ),
    };
  }

  async statusForAgent(agentId: string) {
    const agent = await this.agentControl.getAgent(agentId);
    if (!agent) throw new Error("Agent not found");
    return this.agentStatus(agent);
  }

  async run(agentId?: string | null) {
    const [{ checks }, allAgents] = await Promise.all([
      this.definitions(),
      this.agentControl.listAgents(),
    ]);
    const requested = agentId
      ? allAgents.filter((agent) => agent.id === agentId)
      : allAgents;
    if (agentId && requested.length === 0) throw new Error("Agent not found");
    const eligible = requested.filter(
      (agent) =>
        isOnline(agent) &&
        capabilities(agent.capabilitiesJson).includes(CLI_HEALTH_JOB_KIND),
    );
    await Promise.all(
      eligible.map(async (agent) => {
        if (this.startingAgents.has(agent.id)) return;
        this.startingAgents.add(agent.id);
        try {
          const status = await this.agentStatus(agent, checks);
          if (status.activeJobId) return;
          await this.agentControl.createJob({
            agentId: agent.id,
            kind: CLI_HEALTH_JOB_KIND,
            payload: { checks },
            idempotencyKey: `cli-health:${randomUUID()}`,
            timeoutSeconds: 600,
            visibility: "SYSTEM",
          });
          this.publish(agent.id);
        } finally {
          this.startingAgents.delete(agent.id);
        }
      }),
    );
    return this.installationStatus();
  }

  async saveSettings(input: Array<Partial<CustomCliHealthCheck>>) {
    const checks = validateCustomChecks(input);
    const prisma = await getPrismaClient();
    await prisma.cliHealthSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, checksJson: JSON.stringify(checks) },
      update: { checksJson: JSON.stringify(checks) },
    });
    this.publish(null);
    return this.installationStatus();
  }
}
