import { beforeEach, describe, expect, test, vi } from "vitest";

import { CLI_HEALTH_JOB_KIND } from "@ai-development-environment/agent-contract/cli-health";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import { CliHealthService } from "./cli-health.service";

function agent(
  id: string,
  {
    online = true,
    supported = true,
  }: { online?: boolean; supported?: boolean } = {},
) {
  return {
    id,
    name: id,
    hostname: `${id}.local`,
    version: "2.4.0",
    capabilitiesJson: JSON.stringify(supported ? [CLI_HEALTH_JOB_KIND] : []),
    lastSeenAt: new Date(online ? Date.now() : 0),
    disconnectedAt: online ? null : new Date(0),
    heartbeatIntervalSeconds: 15,
  };
}

function dependencies(agents: ReturnType<typeof agent>[] = []) {
  const control = {
    listAgents: vi.fn().mockResolvedValue(agents),
    getAgent: vi.fn(
      async (id: string) => agents.find((item) => item.id === id) ?? null,
    ),
    createJob: vi.fn().mockResolvedValue({ id: "job-new" }),
    registerCompletionObserver: vi.fn(),
  } as unknown as AgentControlService;
  const github = {
    getSettings: vi.fn().mockResolvedValue({ tokenConfigured: false }),
  } as unknown as GitHubService;
  const gitlab = {
    getSettings: vi.fn().mockResolvedValue({ configured: false }),
  } as unknown as GitLabService;
  return { control, github, gitlab };
}

function prismaWithJobs(active: unknown = null, completed: unknown = null) {
  return {
    cliHealthSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    agentJob: {
      findFirst: vi.fn(async ({ where }: { where: { status: unknown } }) =>
        where.status === "SUCCEEDED" ? completed : active,
      ),
    },
  };
}

describe("CliHealthService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("builds ordered provider-conditional definitions and omits disabled custom checks", async () => {
    const prisma = prismaWithJobs();
    prisma.cliHealthSettings.findUnique.mockResolvedValue({
      checksJson: JSON.stringify([
        {
          id: "node",
          name: "Node.js",
          command: "node --version",
          enabled: true,
        },
        { id: "off", name: "Disabled", command: "false", enabled: false },
      ]),
    });
    getPrismaClient.mockResolvedValue(prisma);
    const { control, github, gitlab } = dependencies();
    vi.mocked(github.getSettings).mockResolvedValue({
      tokenConfigured: true,
    } as never);

    const result = await new CliHealthService(
      control,
      github,
      gitlab,
    ).definitions();

    expect(result.checks.map((check) => check.command)).toEqual([
      "acli jira auth status",
      "acli auth status",
      "claude auth status",
      "codex login status",
      "opencode auth list",
      "gh auth status",
      "node --version",
    ]);
    expect(result.customChecks).toHaveLength(2);
  });

  test("validates global custom-check limits, names, commands, and identifiers", async () => {
    getPrismaClient.mockResolvedValue(prismaWithJobs());
    const { control, github, gitlab } = dependencies();
    const service = new CliHealthService(control, github, gitlab);

    await expect(
      service.saveSettings(
        Array.from({ length: 21 }, (_, index) => ({
          name: `Check ${index}`,
          command: "true",
          enabled: true,
        })),
      ),
    ).rejects.toThrow("At most 20");
    await expect(
      service.saveSettings([
        { name: "Node", command: "true" },
        { name: "node", command: "true" },
      ]),
    ).rejects.toThrow("names must be unique");
    await expect(
      service.saveSettings([{ name: "Unsafe", command: "echo\0secret" }]),
    ).rejects.toThrow("cannot contain NUL");
    await expect(
      service.saveSettings([
        { id: "builtin-fake", name: "Fake", command: "true" },
      ]),
    ).rejects.toThrow("identifiers must be unique and valid");
  });

  test("merges the latest completed result with current definitions for offline agents", async () => {
    const completed = {
      finishedAt: new Date("2026-08-09T12:00:00.000Z"),
      resultJson: JSON.stringify({
        checks: [
          {
            id: "builtin-acli-jira",
            name: "Atlassian Jira",
            command: "acli jira auth status",
            builtIn: true,
            exitCode: 0,
            stdout: "Authenticated",
            stderr: "",
            durationMs: 20,
            checkedAt: "2026-08-09T11:59:59.000Z",
            timedOut: false,
            launchError: null,
            outputTruncated: false,
          },
        ],
      }),
    };
    getPrismaClient.mockResolvedValue(prismaWithJobs(null, completed));
    const offline = agent("offline", { online: false });
    const { control, github, gitlab } = dependencies([offline]);
    const status = await new CliHealthService(
      control,
      github,
      gitlab,
    ).statusForAgent(offline.id);

    expect(status).toMatchObject({
      connectionStatus: "OFFLINE",
      supported: true,
      overall: "ISSUES",
      lastCheckedAt: "2026-08-09T12:00:00.000Z",
    });
    expect(status.results[0]).toMatchObject({ state: "HEALTHY", exitCode: 0 });
    expect(
      status.results.slice(1).every((result) => result.state === "NOT_RUN"),
    ).toBe(true);
  });

  test("run all dispatches only online capable agents and skips an active sweep", async () => {
    const eligible = agent("eligible");
    const offline = agent("offline", { online: false });
    const old = agent("old", { supported: false });
    const prisma = prismaWithJobs();
    getPrismaClient.mockResolvedValue(prisma);
    const { control, github, gitlab } = dependencies([eligible, offline, old]);
    const service = new CliHealthService(control, github, gitlab);

    await service.run();
    expect(control.createJob).toHaveBeenCalledTimes(1);
    expect(control.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "eligible",
        kind: CLI_HEALTH_JOB_KIND,
        timeoutSeconds: 600,
        visibility: "SYSTEM",
      }),
    );

    vi.mocked(control.createJob).mockClear();
    prisma.agentJob.findFirst.mockImplementation(
      async ({ where }: { where: { status: unknown } }) =>
        where.status === "SUCCEEDED" ? null : { id: "active" },
    );
    await service.run("eligible");
    expect(control.createJob).not.toHaveBeenCalled();
  });

  test("reports the installed server and bundled dependency versions", async () => {
    getPrismaClient.mockResolvedValue(prismaWithJobs());
    const { control, github, gitlab } = dependencies();
    const previous = process.env.AIDE_VERSION;
    process.env.AIDE_VERSION = "9.8.7";
    try {
      const status = await new CliHealthService(
        control,
        github,
        gitlab,
      ).installationStatus();
      expect(status.version).toBe("9.8.7");
      expect(status.dependencies.map((dependency) => dependency.name)).toEqual([
        "Next.js",
        "Claude SDK",
        "Codex SDK",
        "OpenCode SDK",
      ]);
    } finally {
      if (previous === undefined) delete process.env.AIDE_VERSION;
      else process.env.AIDE_VERSION = previous;
    }
  });
});
