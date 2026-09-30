import * as z from "zod/v4";

const SearchItemSchema = z.object({
  key: z.string(),
  kind: z.enum([
    "WORKTREE",
    "JIRA_TICKET",
    "GITHUB_PULL_REQUEST",
    "GITLAB_MERGE_REQUEST",
    "REPOSITORY",
    "CODEBASE",
    "WORKFLOW",
    "WORKFLOW_RUN",
    "GITHUB_ACTIONS_RUN",
    "GITLAB_PIPELINE",
    "BUILD",
    "AGENT",
    "AGENT_JOB",
    "PLAN",
    "SESSION",
    "COMMAND",
    "COMMAND_RUN",
    "SKILL",
    "SKILL_GROUP",
    "DEVICE",
    "PROVISIONING_PROFILE",
  ]),
  group: z.enum([
    "WORKTREES",
    "TICKETS",
    "PULL_REQUESTS",
    "REPOSITORIES",
    "CODEBASES",
    "WORKFLOWS",
    "GITHUB_ACTIONS",
    "GITLAB_PIPELINES",
    "BUILDS",
    "AGENTS_JOBS",
    "PLANS_SESSIONS",
    "COMMANDS_RUNS",
    "SKILLS",
    "DEVICES_PROFILES",
  ]),
  title: z.string(),
  subtitle: z.string().nullable(),
  href: z.string(),
  status: z.string().nullable(),
  updatedAt: z.string().nullable(),
  get children() {
    return z.array(SearchItemSchema);
  },
});

export const SearchResultsSchema = z.object({
  items: z.array(SearchItemSchema),
});

export const ActionCenterPageSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      resourceKind: z.enum(["PLAN", "SESSION", "BUILD", "WORKFLOW"]),
      reason: z.enum([
        "QUESTION",
        "BLOCKED",
        "FAILED",
        "UNRUN_BUILD",
        "ACTIVE",
      ]),
      resourceId: z.string(),
      href: z.string(),
      displayNumber: z.number().int().nullable(),
      label: z.string(),
      summary: z.string().nullable(),
      status: z.string(),
      phase: z.string().nullable(),
      error: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      worktree: z
        .object({
          id: z.string(),
          folder: z.string(),
          branch: z.string().nullable(),
          highlightColor: z.string().nullable(),
        })
        .nullable(),
      questionBatches: z.array(
        z.object({
          id: z.string(),
          sourceKind: z.string().nullable(),
          createdAt: z.string(),
          questions: z.array(
            z.object({
              id: z.string(),
              position: z.number().int(),
              header: z.string().nullable(),
              prompt: z.string(),
              multiSelect: z.boolean(),
              allowCustom: z.boolean(),
              options: z.array(
                z.object({
                  id: z.string(),
                  position: z.number().int(),
                  label: z.string(),
                  description: z.string().nullable(),
                }),
              ),
            }),
          ),
        }),
      ),
      // Destination configuration remains in the build API; discovery exposes its identity.
      buildRun: z
        .object({ buildId: z.string(), destinationType: z.string() })
        .nullable(),
      failureFingerprint: z.string().nullable(),
      dismissalFingerprint: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int(),
  needsAttentionCount: z.number().int(),
  activeCount: z.number().int(),
});

export const AgentCliHealthSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  hostname: z.string(),
  version: z.string(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  supported: z.boolean(),
  activeJobId: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  overall: z.enum([
    "HEALTHY",
    "ISSUES",
    "NOT_CHECKED",
    "RUNNING",
    "UNSUPPORTED",
  ]),
  results: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      command: z.string(),
      builtIn: z.boolean(),
      state: z.enum(["HEALTHY", "UNHEALTHY", "NOT_RUN"]),
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number().int().nullable(),
      checkedAt: z.string().nullable(),
      timedOut: z.boolean(),
      launchError: z.string().nullable(),
      outputTruncated: z.boolean(),
    }),
  ),
});

export const InstallationStatusSchema = z.object({
  version: z.string(),
  dependencies: z.array(z.object({ name: z.string(), version: z.string() })),
  customChecks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      command: z.string(),
      enabled: z.boolean(),
    }),
  ),
  agents: z.array(AgentCliHealthSchema),
});
