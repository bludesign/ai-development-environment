import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  BUILD_ACTIONS,
  BUILD_DESTINATION_TYPES,
  BUILD_SCRIPT_FAILURE_BEHAVIORS,
  DEFAULT_BUILD_ADVANCED_SETTINGS,
  IOS_BUILD_JOB_KIND,
  IOS_DEPLOY_JOB_KIND,
  IOS_DESTINATIONS_JOB_KIND,
  IOS_EXPORT_JOB_KIND,
  IOS_RUN_DESTINATIONS_JOB_KIND,
  IOS_SOURCE_DISCOVER_JOB_KIND,
  IOS_SOURCE_PARSE_JOB_KIND,
  parseBuildAdvancedSettings,
  parseBuildDestination,
  parseBuildExportSettings,
  parseBuildSource,
  type BuildAction,
  type BuildAdvancedSettings,
  type BuildDestination,
  type BuildSourceKind,
} from "@ai-development-environment/agent-contract/builds";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  AGENT_ONLINE_WINDOW_MS,
  AgentControlService,
  BUILDS_CHANGED_TOPIC,
  agentEventBus,
  agentJobChangedTopic,
  buildLogTopic,
  buildTopic,
} from "@/services/agent-control";

const ICON_KEYS = new Set([
  "smartphone",
  "hammer",
  "play",
  "test-tube",
  "archive",
  "rocket",
]);
const FINAL_JOB_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
const ACTIVE_BUILD_STATUSES = ["QUEUED", "PREPARING", "RUNNING"];

type JsonObject = Record<string, unknown>;

function parseJson(value: string | null, fallback: unknown = null): unknown {
  if (value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function online(agent: {
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
}): boolean {
  return (
    agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt.getTime() <= AGENT_ONLINE_WINDOW_MS &&
    agent.disconnectedAt === null
  );
}

function capabilities(agent: { capabilitiesJson: string }): string[] {
  return stringArray(parseJson(agent.capabilitiesJson, []));
}

function cleanName(value: string, field: string, max = 80): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function sanitizePersistedLog(message: string): string {
  return message
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

function buildStatusFromJob(status: string): string {
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

function destinationSpecifier(destination: BuildDestination): string {
  if (destination.generic) return "generic/platform=iOS";
  return destination.type === "SIMULATOR"
    ? `platform=iOS Simulator,id=${destination.id}`
    : `platform=iOS,id=${destination.id}`;
}

function actionArgument(action: BuildAction): string {
  return {
    BUILD: "build",
    TEST: "test",
    ANALYZE: "analyze",
    ARCHIVE: "archive",
    BUILD_FOR_TESTING: "build-for-testing",
    TEST_WITHOUT_BUILDING: "test-without-building",
  }[action];
}

function commandPreview(input: {
  folder: string;
  source: { kind: string; relativePath: string };
  scheme: string;
  configuration: string;
  destination: BuildDestination;
  action: BuildAction;
  advancedSettings: BuildAdvancedSettings;
  artifactDirectory: string;
}): string {
  const settings = input.advancedSettings;
  const args = [
    "xcodebuild",
    ...(input.source.kind === "PACKAGE"
      ? []
      : input.source.kind === "PROJECT"
        ? ["-project", input.source.relativePath]
        : ["-workspace", input.source.relativePath]),
    "-scheme",
    input.scheme,
    "-configuration",
    input.configuration,
    "-destination",
    destinationSpecifier(input.destination),
    "-hideShellScriptEnvironment",
    "-resultBundlePath",
    join(input.artifactDirectory, "result.xcresult"),
  ];
  if (settings.packageResolution === "RESOLVED_ONLY") {
    args.push("-onlyUsePackageVersionsFromResolvedFile");
  } else if (settings.packageResolution === "SKIP_UPDATES") {
    args.push("-skipPackageUpdates");
  } else if (settings.packageResolution === "DISABLE_AUTOMATIC") {
    args.push("-disableAutomaticPackageResolution");
  }
  if (settings.disablePackageRepositoryCache) {
    args.push("-disablePackageRepositoryCache");
  }
  if (settings.signingStyle !== "PROJECT_DEFAULT") {
    args.push(
      `CODE_SIGN_STYLE=${settings.signingStyle === "AUTOMATIC" ? "Automatic" : "Manual"}`,
    );
  }
  if (settings.developmentTeam) {
    args.push(`DEVELOPMENT_TEAM=${settings.developmentTeam}`);
  }
  if (settings.codeSignIdentity) {
    args.push(`CODE_SIGN_IDENTITY=${settings.codeSignIdentity}`);
  }
  if (settings.provisioningProfileSpecifier) {
    args.push(
      `PROVISIONING_PROFILE_SPECIFIER=${settings.provisioningProfileSpecifier}`,
    );
  }
  if (settings.productBundleIdentifier) {
    args.push(`PRODUCT_BUNDLE_IDENTIFIER=${settings.productBundleIdentifier}`);
  }
  if (settings.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
  if (settings.allowProvisioningDeviceRegistration) {
    args.push("-allowProvisioningDeviceRegistration");
  }
  if (settings.testPlan) args.push("-testPlan", settings.testPlan);
  if (settings.codeCoverage) args.push("-enableCodeCoverage", "YES");
  if (settings.parallelTesting !== null) {
    args.push(
      "-parallel-testing-enabled",
      settings.parallelTesting ? "YES" : "NO",
    );
  }
  if (settings.parallelTestingWorkers !== null) {
    args.push(
      "-parallel-testing-worker-count",
      String(settings.parallelTestingWorkers),
    );
  }
  for (const test of settings.onlyTesting) args.push(`-only-testing:${test}`);
  for (const test of settings.skipTesting) args.push(`-skip-testing:${test}`);
  for (const [key, value] of Object.entries(settings.buildSettingOverrides)) {
    args.push(`${key}=${value}`);
  }
  if (input.action === "ARCHIVE") {
    args.push(
      "-archivePath",
      join(input.artifactDirectory, "archive.xcarchive"),
    );
  }
  if (input.action === "BUILD_FOR_TESTING") {
    args.push(
      "-testProductsPath",
      join(input.artifactDirectory, "test-products"),
    );
  }
  if (input.action === "TEST_WITHOUT_BUILDING" && settings.priorXctestrunPath) {
    args.push("-xctestrun", settings.priorXctestrunPath);
  }
  args.push(actionArgument(input.action));
  const display = args
    .map((value) =>
      /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : JSON.stringify(value),
    )
    .join(" ");
  return `cd ${JSON.stringify(input.folder)} && xcrun ${display}`;
}

const buildInclude = {
  agent: true,
  codebase: { include: { repository: true } },
  worktree: true,
  configuration: { include: { source: true, project: true } },
  artifacts: { orderBy: { createdAt: "asc" as const } },
  scriptExecutions: {
    orderBy: [{ phase: "asc" as const }, { position: "asc" as const }],
  },
  deployments: { orderBy: { createdAt: "desc" as const } },
  exports: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.BuildInclude;

export type SaveBuildConfigurationInput = {
  id?: string | null;
  codebaseId: string;
  name: string;
  iconKey?: string | null;
  sourceKind: BuildSourceKind;
  sourcePath: string;
  scheme: string;
  buildConfiguration: string;
  defaultAction: BuildAction;
  advancedSettings?: unknown;
};

export type SaveBuildScriptInput = {
  id?: string | null;
  name: string;
  preBuildScript?: string | null;
  postBuildScript?: string | null;
  enabledByDefault: boolean;
  timeoutSeconds?: number | null;
  failureBehavior: "FAIL_BUILD" | "CONTINUE";
};

export class BuildsService {
  constructor(private readonly agentControl: AgentControlService) {
    this.agentControl.registerCompletionHandler(IOS_BUILD_JOB_KIND, (job) =>
      this.projectBuildCompletion(job),
    );
    this.agentControl.registerCompletionHandler(IOS_DEPLOY_JOB_KIND, (job) =>
      this.projectDeploymentCompletion(job),
    );
    this.agentControl.registerCompletionHandler(IOS_EXPORT_JOB_KIND, (job) =>
      this.projectExportCompletion(job),
    );
  }

  private publish(buildId: string): void {
    const event = { buildChanged: { id: buildId } };
    agentEventBus.publish(buildTopic(buildId), event);
    agentEventBus.publish(BUILDS_CHANGED_TOPIC, event);
  }

  private async requireWorktree(worktreeId: string, capability: string) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      include: {
        codebase: { include: { agent: true, repository: true } },
      },
    });
    if (
      !worktree ||
      worktree.missingAt ||
      worktree.availability !== "AVAILABLE"
    ) {
      throw new Error("Worktree is unavailable");
    }
    if (!online(worktree.codebase.agent)) throw new Error("Agent is offline");
    if (!capabilities(worktree.codebase.agent).includes(capability)) {
      throw new Error("Agent must be updated to use iOS builds");
    }
    return worktree;
  }

  private identity(
    worktree: Awaited<ReturnType<BuildsService["requireWorktree"]>>,
  ) {
    return {
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      folder: worktree.folder,
      gitDirectory: worktree.gitDirectory,
      expectedOrigin: worktree.codebase.repository.canonicalOrigin,
      headSha: worktree.headSha,
    };
  }

  private async ensureProject(codebaseId: string) {
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: codebaseId },
      select: { repositoryId: true },
    });
    if (!codebase) throw new Error("Codebase not found");
    return prisma.codebaseProject.upsert({
      where: {
        repositoryId_type: {
          repositoryId: codebase.repositoryId,
          type: "IOS_APP",
        },
      },
      create: {
        id: randomUUID(),
        repositoryId: codebase.repositoryId,
        type: "IOS_APP",
      },
      update: {},
    });
  }

  async project(codebaseId: string) {
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: codebaseId },
      include: { repository: true },
    });
    if (!codebase) return null;
    const project = await prisma.codebaseProject.findUnique({
      where: {
        repositoryId_type: {
          repositoryId: codebase.repositoryId,
          type: "IOS_APP",
        },
      },
      include: {
        configurations: {
          orderBy: { name: "asc" },
          include: {
            source: {
              include: {
                observations: {
                  where: { codebaseId },
                  orderBy: { lastParseAttemptAt: "desc" },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    const allowed = await prisma.codebaseRepositoryBuildScript.findMany({
      where: {
        repositoryId: codebase.repositoryId,
        script: { deletedAt: null },
      },
      orderBy: [{ position: "asc" }, { script: { name: "asc" } }],
      include: { script: true },
    });
    return project
      ? { ...project, repository: codebase.repository, allowedScripts: allowed }
      : null;
  }

  async createProject(codebaseId: string) {
    await this.ensureProject(codebaseId);
    return this.project(codebaseId);
  }

  async projectForWorktree(worktreeId: string) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: { codebaseId: true },
    });
    return worktree ? this.project(worktree.codebaseId) : null;
  }

  async saveConfiguration(input: SaveBuildConfigurationInput) {
    const project = await this.ensureProject(input.codebaseId);
    const source = parseBuildSource({
      kind: input.sourceKind,
      relativePath: input.sourcePath,
    });
    const name = cleanName(input.name, "Configuration name");
    const scheme = cleanName(input.scheme, "Scheme", 256);
    const buildConfiguration = cleanName(
      input.buildConfiguration,
      "Xcode configuration",
      256,
    );
    if (!BUILD_ACTIONS.includes(input.defaultAction)) {
      throw new Error("Build action is invalid");
    }
    const iconKey = input.iconKey?.trim() || null;
    if (iconKey && !ICON_KEYS.has(iconKey)) throw new Error("Icon is invalid");
    const advanced = parseBuildAdvancedSettings(
      input.advancedSettings ?? DEFAULT_BUILD_ADVANCED_SETTINGS,
    );
    const prisma = await getPrismaClient();
    const existing = input.id
      ? await prisma.buildConfiguration.findUnique({ where: { id: input.id } })
      : null;
    if (input.id && (!existing || existing.projectId !== project.id)) {
      throw new Error("Build configuration not found");
    }
    const savedSource = await prisma.buildSource.upsert({
      where: {
        projectId_relativePath: {
          projectId: project.id,
          relativePath: source.relativePath,
        },
      },
      create: {
        id: randomUUID(),
        projectId: project.id,
        kind: source.kind,
        relativePath: source.relativePath,
      },
      update: { kind: source.kind },
    });
    const id = existing?.id ?? randomUUID();
    return prisma.buildConfiguration.upsert({
      where: { id },
      create: {
        id,
        projectId: project.id,
        sourceId: savedSource.id,
        name,
        iconKey,
        scheme,
        buildConfiguration,
        defaultAction: input.defaultAction,
        advancedSettingsJson: JSON.stringify(advanced),
      },
      update: {
        sourceId: savedSource.id,
        name,
        iconKey,
        scheme,
        buildConfiguration,
        defaultAction: input.defaultAction,
        advancedSettingsJson: JSON.stringify(advanced),
      },
      include: { source: true },
    });
  }

  async deleteConfiguration(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const active = await prisma.build.findFirst({
      where: { configurationId: id, status: { in: ACTIVE_BUILD_STATUSES } },
    });
    if (active) throw new Error("Configuration has an active build");
    const removed = await prisma.buildConfiguration.deleteMany({
      where: { id },
    });
    return removed.count === 1;
  }

  async scripts() {
    const prisma = await getPrismaClient();
    return prisma.buildScript.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });
  }

  async saveScript(input: SaveBuildScriptInput) {
    const name = cleanName(input.name, "Script name");
    const preBuildScript = input.preBuildScript?.trim() || null;
    const postBuildScript = input.postBuildScript?.trim() || null;
    if (!preBuildScript && !postBuildScript) {
      throw new Error("A pre-build or post-build script is required");
    }
    const timeoutSeconds = input.timeoutSeconds ?? 300;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 3_600
    ) {
      throw new Error("Script timeout must be between 1 and 3600 seconds");
    }
    if (!BUILD_SCRIPT_FAILURE_BEHAVIORS.includes(input.failureBehavior)) {
      throw new Error("Script failure behavior is invalid");
    }
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    return prisma.buildScript.upsert({
      where: { id },
      create: {
        id,
        name,
        preBuildScript,
        postBuildScript,
        enabledByDefault: input.enabledByDefault,
        timeoutSeconds,
        failureBehavior: input.failureBehavior,
      },
      update: {
        name,
        preBuildScript,
        postBuildScript,
        enabledByDefault: input.enabledByDefault,
        timeoutSeconds,
        failureBehavior: input.failureBehavior,
        deletedAt: null,
      },
    });
  }

  async deleteScript(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const removed = await prisma.buildScript.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await prisma.codebaseRepositoryBuildScript.deleteMany({
      where: { scriptId: id },
    });
    return removed.count === 1;
  }

  async setAllowedScripts(codebaseId: string, scriptIds: string[]) {
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id: codebaseId },
    });
    if (!codebase) throw new Error("Codebase not found");
    const unique = [...new Set(scriptIds)];
    const scripts = await prisma.buildScript.findMany({
      where: { id: { in: unique }, deletedAt: null },
    });
    if (scripts.length !== unique.length)
      throw new Error("Build script not found");
    await prisma.$transaction(async (transaction) => {
      await transaction.codebaseRepositoryBuildScript.deleteMany({
        where: { repositoryId: codebase.repositoryId },
      });
      if (unique.length) {
        await transaction.codebaseRepositoryBuildScript.createMany({
          data: unique.map((scriptId, position) => ({
            repositoryId: codebase.repositoryId,
            scriptId,
            position,
          })),
        });
      }
    });
    return this.project(codebaseId);
  }

  private async waitForJob(jobId: string, timeoutMs = 120_000) {
    const events = agentEventBus.iterate(agentJobChangedTopic(jobId));
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const job = await this.agentControl.getJob(jobId);
        if (!job) throw new Error("Agent job disappeared");
        if (FINAL_JOB_STATUSES.has(job.status)) return job;
        await Promise.race([
          events.next(),
          new Promise((resolve) =>
            setTimeout(resolve, Math.max(1, deadline - Date.now())),
          ),
        ]);
      }
      await this.agentControl.cancelJob(jobId);
      throw new Error("Agent did not respond in time");
    } finally {
      await events.return?.();
    }
  }

  private result(job: {
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    if (job.status !== "SUCCEEDED") {
      throw new Error(job.error || "Agent operation failed");
    }
    return objectValue(parseJson(job.resultJson, {}), "agent result");
  }

  async discoverSources(worktreeId: string, requestId: string) {
    const worktree = await this.requireWorktree(
      worktreeId,
      IOS_SOURCE_DISCOVER_JOB_KIND,
    );
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_SOURCE_DISCOVER_JOB_KIND,
      payload: this.identity(worktree),
      idempotencyKey: `ios:source:discover:${requestId}:${worktree.id}`,
      timeoutSeconds: 60,
      visibility: "SYSTEM",
    });
    try {
      const result = this.result(await this.waitForJob(job.id));
      return Array.isArray(result.sources) ? result.sources : [];
    } finally {
      const prisma = await getPrismaClient();
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async reparse(
    configurationId: string,
    worktreeId: string,
    requestId: string,
  ) {
    const worktree = await this.requireWorktree(
      worktreeId,
      IOS_SOURCE_PARSE_JOB_KIND,
    );
    const prisma = await getPrismaClient();
    const configuration = await prisma.buildConfiguration.findUnique({
      where: { id: configurationId },
      include: { source: { include: { project: true } } },
    });
    if (
      !configuration ||
      configuration.source.project.repositoryId !==
        worktree.codebase.repositoryId
    ) {
      throw new Error("Build configuration is not available for this worktree");
    }
    const scopeKey = `worktree:${worktree.id}`;
    const existing = await prisma.buildSourceObservation.findUnique({
      where: {
        sourceId_scopeKey: { sourceId: configuration.sourceId, scopeKey },
      },
    });
    const attempt = new Date();
    await prisma.buildSourceObservation.upsert({
      where: {
        sourceId_scopeKey: { sourceId: configuration.sourceId, scopeKey },
      },
      create: {
        id: randomUUID(),
        sourceId: configuration.sourceId,
        scopeKey,
        codebaseId: worktree.codebaseId,
        worktreeId: worktree.id,
        status: "PARSING",
        lastParseAttemptAt: attempt,
      },
      update: { status: "PARSING", error: null, lastParseAttemptAt: attempt },
    });
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_SOURCE_PARSE_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        source: {
          kind: configuration.source.kind,
          relativePath: configuration.source.relativePath,
        },
        scheme: configuration.scheme,
      },
      idempotencyKey: `ios:source:parse:${requestId}:${configuration.id}:${worktree.id}`,
      timeoutSeconds: 120,
      visibility: "SYSTEM",
    });
    try {
      const result = this.result(await this.waitForJob(job.id));
      const schemes = stringArray(result.schemes);
      const configurations = stringArray(result.configurations);
      const valid =
        schemes.includes(configuration.scheme) &&
        configurations.includes(configuration.buildConfiguration);
      return prisma.buildSourceObservation.update({
        where: {
          sourceId_scopeKey: { sourceId: configuration.sourceId, scopeKey },
        },
        data: {
          status: valid ? "VALID" : "INVALID",
          schemesJson: JSON.stringify(schemes),
          configurationsJson: JSON.stringify(configurations),
          testPlansJson: JSON.stringify(stringArray(result.testPlans)),
          error: valid
            ? null
            : "The saved scheme or configuration is no longer available",
          stale: false,
          headSha:
            typeof result.headSha === "string"
              ? result.headSha
              : worktree.headSha,
          xcodeVersion:
            typeof result.xcodeVersion === "string"
              ? result.xcodeVersion
              : null,
          lastParsedAt: new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return prisma.buildSourceObservation.update({
        where: {
          sourceId_scopeKey: { sourceId: configuration.sourceId, scopeKey },
        },
        data: {
          status: "ERROR",
          error: message,
          stale: Boolean(existing?.lastParsedAt),
        },
      });
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async inspectSource(input: {
    worktreeId: string;
    sourceKind: BuildSourceKind;
    sourcePath: string;
    scheme?: string | null;
    requestId: string;
  }) {
    const worktree = await this.requireWorktree(
      input.worktreeId,
      IOS_SOURCE_PARSE_JOB_KIND,
    );
    const source = parseBuildSource({
      kind: input.sourceKind,
      relativePath: input.sourcePath,
    });
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_SOURCE_PARSE_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        source,
        scheme: input.scheme?.trim() || null,
      },
      idempotencyKey: `ios:source:inspect:${input.requestId}:${worktree.id}:${source.relativePath}:${input.scheme ?? ""}`,
      timeoutSeconds: 120,
      visibility: "SYSTEM",
    });
    try {
      const result = this.result(await this.waitForJob(job.id));
      return {
        source,
        schemes: stringArray(result.schemes),
        configurations: stringArray(result.configurations),
        testPlans: stringArray(result.testPlans),
        headSha:
          typeof result.headSha === "string"
            ? result.headSha
            : worktree.headSha,
        xcodeVersion:
          typeof result.xcodeVersion === "string" ? result.xcodeVersion : null,
      };
    } finally {
      const prisma = await getPrismaClient();
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async destinations(input: {
    worktreeId: string;
    configurationId: string;
    action?: BuildAction | null;
    requestId: string;
  }) {
    const worktree = await this.requireWorktree(
      input.worktreeId,
      IOS_DESTINATIONS_JOB_KIND,
    );
    const prisma = await getPrismaClient();
    const configuration = await prisma.buildConfiguration.findUnique({
      where: { id: input.configurationId },
      include: { source: { include: { project: true } } },
    });
    if (
      !configuration ||
      configuration.source.project.repositoryId !==
        worktree.codebase.repositoryId
    ) {
      throw new Error("Build configuration is not available for this worktree");
    }
    const action = input.action ?? (configuration.defaultAction as BuildAction);
    if (!BUILD_ACTIONS.includes(action))
      throw new Error("Build action is invalid");
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_DESTINATIONS_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        source: {
          kind: configuration.source.kind,
          relativePath: configuration.source.relativePath,
        },
        scheme: configuration.scheme,
        configuration: configuration.buildConfiguration,
        action,
      },
      idempotencyKey: `ios:destinations:${input.requestId}:${configuration.id}:${worktree.id}:${action}`,
      timeoutSeconds: 120,
      visibility: "SYSTEM",
    });
    try {
      const result = this.result(await this.waitForJob(job.id));
      return Array.isArray(result.destinations) ? result.destinations : [];
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async destinationsForBuild(buildId: string, requestId: string) {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: buildId },
      include: { artifacts: true },
    });
    if (
      !build ||
      build.status !== "SUCCEEDED" ||
      !build.worktreeId ||
      !build.artifacts.some((artifact) => artifact.kind === "RUNNABLE_APP")
    ) {
      throw new Error("A successful runnable build is required");
    }
    const worktree = await this.requireWorktree(
      build.worktreeId,
      IOS_RUN_DESTINATIONS_JOB_KIND,
    );
    if (
      build.agentId !== worktree.codebase.agentId ||
      build.codebaseId !== worktree.codebaseId
    ) {
      throw new Error("The build no longer belongs to this worktree checkout");
    }
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_RUN_DESTINATIONS_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        destinationType: build.destinationType,
      },
      idempotencyKey: `ios:build-destinations:${cleanName(requestId, "Request ID", 200)}:${build.id}`,
      timeoutSeconds: 120,
      visibility: "SYSTEM",
    });
    try {
      const result = this.result(await this.waitForJob(job.id));
      return (Array.isArray(result.destinations) ? result.destinations : [])
        .map((destination) => parseBuildDestination(destination))
        .filter(
          (destination) =>
            destination.type === build.destinationType && !destination.generic,
        );
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async startBuild(input: {
    worktreeId: string;
    configurationId: string;
    destination: unknown;
    scriptIds?: string[] | null;
    action?: BuildAction | null;
    advancedSettings?: unknown;
    requestId: string;
  }) {
    const requestId = cleanName(input.requestId, "Request ID", 200);
    const requestKey = `${input.worktreeId}:${requestId}`;
    const prisma = await getPrismaClient();
    const existing = await prisma.build.findUnique({
      where: { requestKey },
      include: buildInclude,
    });
    if (existing) return existing;
    const worktree = await this.requireWorktree(
      input.worktreeId,
      IOS_BUILD_JOB_KIND,
    );
    const configuration = await prisma.buildConfiguration.findUnique({
      where: { id: input.configurationId },
      include: { source: { include: { project: true } } },
    });
    if (
      !configuration ||
      configuration.source.project.repositoryId !==
        worktree.codebase.repositoryId
    ) {
      throw new Error("Build configuration is not available for this worktree");
    }
    const observation = await prisma.buildSourceObservation.findUnique({
      where: {
        sourceId_scopeKey: {
          sourceId: configuration.sourceId,
          scopeKey: `worktree:${worktree.id}`,
        },
      },
    });
    if (!observation || observation.status !== "VALID") {
      throw new Error(
        "Build configuration must be successfully parsed for this worktree",
      );
    }
    const action = input.action ?? (configuration.defaultAction as BuildAction);
    if (!BUILD_ACTIONS.includes(action))
      throw new Error("Build action is invalid");
    let destination = parseBuildDestination(input.destination);
    if (!BUILD_DESTINATION_TYPES.includes(destination.type)) {
      throw new Error("Destination is invalid");
    }
    if (action === "ARCHIVE" && !destination.generic) {
      throw new Error(
        "Archive builds require the generic physical iOS destination",
      );
    }
    const baseAdvanced = objectValue(
      parseJson(configuration.advancedSettingsJson, {}),
      "saved advanced settings",
    );
    const overrideAdvanced = input.advancedSettings
      ? objectValue(input.advancedSettings, "advanced settings override")
      : {};
    let advancedSettings = parseBuildAdvancedSettings({
      ...baseAdvanced,
      ...overrideAdvanced,
      buildSettingOverrides: {
        ...objectValue(
          baseAdvanced.buildSettingOverrides ?? {},
          "saved overrides",
        ),
        ...objectValue(
          overrideAdvanced.buildSettingOverrides ?? {},
          "run overrides",
        ),
      },
    });
    if (action === "TEST_WITHOUT_BUILDING") {
      if (!advancedSettings.priorBuildForTestingId) {
        throw new Error(
          "Test Without Building requires a prior Build for Testing result",
        );
      }
      const priorBuild = await prisma.build.findUnique({
        where: { id: advancedSettings.priorBuildForTestingId },
        include: {
          artifacts: {
            where: { kind: "XCTESTRUN" },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (
        !priorBuild ||
        priorBuild.status !== "SUCCEEDED" ||
        priorBuild.action !== "BUILD_FOR_TESTING"
      ) {
        throw new Error(
          "Test Without Building requires a successful Build for Testing result",
        );
      }
      if (
        priorBuild.agentId !== worktree.codebase.agentId ||
        priorBuild.worktreeId !== worktree.id ||
        priorBuild.configurationId !== configuration.id
      ) {
        throw new Error(
          "The prior Build for Testing result is not compatible with this agent, worktree, and configuration",
        );
      }
      if (priorBuild.destinationType !== destination.type) {
        throw new Error(
          "The prior Build for Testing result uses a different destination type",
        );
      }
      if (priorBuild.artifacts.length !== 1) {
        throw new Error(
          "The prior Build for Testing result must contain exactly one .xctestrun artifact",
        );
      }
      const artifact = priorBuild.artifacts[0]!;
      if (!artifact.relativePath.endsWith(".xctestrun")) {
        throw new Error("The prior Build for Testing artifact is invalid");
      }
      const artifactRoot = resolve(priorBuild.artifactDirectory);
      const artifactPath = resolve(artifactRoot, artifact.relativePath);
      const containedRelativePath = relative(artifactRoot, artifactPath);
      if (
        !containedRelativePath ||
        containedRelativePath.startsWith("..") ||
        isAbsolute(containedRelativePath)
      ) {
        throw new Error("The prior Build for Testing artifact path is invalid");
      }
      advancedSettings = {
        ...advancedSettings,
        priorXctestrunPath: artifactPath,
      };
    }
    const allowed = await prisma.codebaseRepositoryBuildScript.findMany({
      where: {
        repositoryId: worktree.codebase.repositoryId,
        script: { deletedAt: null },
      },
      orderBy: [{ position: "asc" }, { script: { name: "asc" } }],
      include: { script: true },
    });
    const selectedIds = new Set(input.scriptIds ?? []);
    if (
      [...selectedIds].some(
        (id) => !allowed.some((entry) => entry.scriptId === id),
      )
    ) {
      throw new Error(
        "A selected build script is not allowed for this codebase",
      );
    }
    const selected = allowed.filter((entry) => selectedIds.has(entry.scriptId));
    const availableDestinations = await this.destinations({
      worktreeId: worktree.id,
      configurationId: configuration.id,
      action,
      requestId: `${requestId}:preflight`,
    });
    const availableDestination = availableDestinations
      .map((value) => parseBuildDestination(value))
      .find(
        (value) =>
          value.type === destination.type &&
          value.id === destination.id &&
          Boolean(value.generic) === Boolean(destination.generic),
      );
    if (!availableDestination) {
      throw new Error("The selected destination is no longer available");
    }
    destination = availableDestination;
    const buildId = randomUUID();
    const buildRoot =
      worktree.codebase.agent.buildsDirectory ??
      worktree.codebase.agent.defaultBuildsDirectory;
    if (!buildRoot)
      throw new Error("The agent builds directory is unavailable");
    const artifactDirectory = join(buildRoot, buildId);
    const source = {
      kind: configuration.source.kind as BuildSourceKind,
      relativePath: configuration.source.relativePath,
    };
    const commandSummary = commandPreview({
      folder: worktree.folder,
      source,
      scheme: configuration.scheme,
      configuration: configuration.buildConfiguration,
      destination,
      action,
      advancedSettings,
      artifactDirectory,
    });
    const scripts = selected.map(({ script, position }) => ({
      id: script.id,
      name: script.name,
      preBuildScript: script.preBuildScript,
      postBuildScript: script.postBuildScript,
      timeoutSeconds: script.timeoutSeconds,
      failureBehavior: script.failureBehavior as "FAIL_BUILD" | "CONTINUE",
      position,
    }));
    const snapshot = {
      repository: {
        id: worktree.codebase.repository.id,
        name: worktree.codebase.repository.name,
        canonicalOrigin: worktree.codebase.repository.canonicalOrigin,
      },
      codebase: { id: worktree.codebase.id, folder: worktree.codebase.folder },
      worktree: {
        id: worktree.id,
        folder: worktree.folder,
        branch: worktree.branch,
        headSha: worktree.headSha,
      },
      agent: {
        id: worktree.codebase.agent.id,
        name: worktree.codebase.agent.name,
        hostname: worktree.codebase.agent.hostname,
      },
      configuration: {
        id: configuration.id,
        name: configuration.name,
        iconKey: configuration.iconKey,
        source,
        scheme: configuration.scheme,
        buildConfiguration: configuration.buildConfiguration,
        action,
        advancedSettings,
        parse: {
          status: observation.status,
          schemes: parseJson(observation.schemesJson, []),
          configurations: parseJson(observation.configurationsJson, []),
          testPlans: parseJson(observation.testPlansJson, []),
          headSha: observation.headSha,
          xcodeVersion: observation.xcodeVersion,
          parsedAt: observation.lastParsedAt?.toISOString() ?? null,
        },
      },
      destination,
      scripts,
    };
    await prisma.build.create({
      data: {
        id: buildId,
        requestKey,
        requestId,
        agentId: worktree.codebase.agentId,
        codebaseId: worktree.codebaseId,
        worktreeId: worktree.id,
        configurationId: configuration.id,
        status: "QUEUED",
        action,
        destinationType: destination.type,
        destinationJson: JSON.stringify(destination),
        snapshotJson: JSON.stringify(snapshot),
        commandSummary,
        artifactDirectory,
        scriptExecutions: {
          create: scripts.flatMap((script) => [
            ...(script.preBuildScript
              ? [
                  {
                    id: randomUUID(),
                    scriptId: script.id,
                    phase: "PRE_BUILD",
                    position: script.position,
                    nameSnapshot: script.name,
                    sourceSnapshot: script.preBuildScript,
                    timeoutSeconds: script.timeoutSeconds,
                    failureBehavior: script.failureBehavior,
                  },
                ]
              : []),
            ...(script.postBuildScript
              ? [
                  {
                    id: randomUUID(),
                    scriptId: script.id,
                    phase: "POST_BUILD",
                    position: script.position,
                    nameSnapshot: script.name,
                    sourceSnapshot: script.postBuildScript,
                    timeoutSeconds: script.timeoutSeconds,
                    failureBehavior: script.failureBehavior,
                  },
                ]
              : []),
          ]),
        },
      },
    });
    try {
      const job = await this.agentControl.createJob({
        agentId: worktree.codebase.agentId,
        codebaseId: worktree.codebaseId,
        worktreeId: worktree.id,
        kind: IOS_BUILD_JOB_KIND,
        payload: {
          ...this.identity(worktree),
          buildId,
          artifactDirectory,
          source,
          scheme: configuration.scheme,
          configuration: configuration.buildConfiguration,
          action,
          destination,
          advancedSettings,
          scripts,
        },
        idempotencyKey: `ios:build:${requestId}:${worktree.id}`,
        timeoutSeconds: 7 * 24 * 60 * 60,
      });
      await prisma.build.update({
        where: { id: buildId },
        data: { jobId: job.id },
      });
    } catch (error) {
      await prisma.build.update({
        where: { id: buildId },
        data: {
          status: "FAILED",
          errorCode: "QUEUE_FAILED",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        },
      });
      throw error;
    }
    this.publish(buildId);
    return prisma.build.findUniqueOrThrow({
      where: { id: buildId },
      include: buildInclude,
    });
  }

  async builds(
    input: {
      first?: number | null;
      after?: string | null;
      status?: string | null;
      codebaseId?: string | null;
      worktreeId?: string | null;
    } = {},
  ) {
    const prisma = await getPrismaClient();
    const take = Math.max(1, Math.min(input.first ?? 50, 200));
    const rows = await prisma.build.findMany({
      where: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.codebaseId ? { codebaseId: input.codebaseId } : {}),
        ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
      take: take + 1,
      include: buildInclude,
    });
    return {
      items: rows.slice(0, take),
      nextCursor: rows.length > take ? rows[take - 1]!.id : null,
    };
  }

  async getBuild(id: string) {
    const prisma = await getPrismaClient();
    return prisma.build.findUnique({ where: { id }, include: buildInclude });
  }

  async logs(buildId: string, afterSequence = -1, first = 1_000) {
    const prisma = await getPrismaClient();
    return prisma.buildLogEvent.findMany({
      where: { buildId, sequence: { gt: afterSequence } },
      orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
      take: Math.max(1, Math.min(first, 5_000)),
    });
  }

  async cancelBuild(id: string) {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({ where: { id } });
    if (!build) throw new Error("Build not found");
    if (!ACTIVE_BUILD_STATUSES.includes(build.status)) return this.getBuild(id);
    if (build.jobId) await this.agentControl.cancelJob(build.jobId);
    await prisma.build.update({
      where: { id },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        errorCode: "CANCELLED",
      },
    });
    this.publish(id);
    return this.getBuild(id);
  }

  async reportProgress(
    agentId: string,
    input: {
      buildId: string;
      status: string;
      startedAt?: string | null;
      errorCode?: string | null;
      error?: string | null;
    },
  ) {
    if (!["PREPARING", "RUNNING"].includes(input.status)) {
      throw new Error("Build progress status is invalid");
    }
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: input.buildId },
    });
    if (!build || build.agentId !== agentId)
      throw new Error("Build not found for agent");
    if (!ACTIVE_BUILD_STATUSES.includes(build.status)) return build;
    const updated = await prisma.build.update({
      where: { id: input.buildId },
      data: {
        status: input.status,
        startedAt:
          build.startedAt ??
          (input.startedAt ? new Date(input.startedAt) : new Date()),
        errorCode: input.errorCode ?? undefined,
        error: input.error ?? undefined,
      },
    });
    this.publish(input.buildId);
    return updated;
  }

  async appendLogs(
    agentId: string,
    buildId: string,
    events: Array<{
      scope: string;
      scopeId: string;
      sequence: number;
      phase: string;
      level: string;
      stream: string;
      message: string;
      createdAt: string;
    }>,
  ) {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({ where: { id: buildId } });
    if (!build || build.agentId !== agentId)
      throw new Error("Build not found for agent");
    const normalized = events.slice(0, 200).map((event) => ({
      id: randomUUID(),
      buildId,
      scope: cleanName(event.scope, "Log scope", 40),
      scopeId: cleanName(event.scopeId, "Log scope ID", 200),
      sequence: event.sequence,
      phase: cleanName(event.phase, "Log phase", 80),
      level: cleanName(event.level, "Log level", 20),
      stream: cleanName(event.stream, "Log stream", 20),
      message: sanitizePersistedLog(event.message).slice(0, 64_000),
      createdAt: new Date(event.createdAt),
    }));
    for (const event of normalized) {
      if (!Number.isInteger(event.sequence) || event.sequence < 0) {
        throw new Error("Log sequence must be a non-negative integer");
      }
      if (Number.isNaN(event.createdAt.valueOf()))
        throw new Error("Log date is invalid");
      await prisma.buildLogEvent.upsert({
        where: {
          scope_scopeId_sequence: {
            scope: event.scope,
            scopeId: event.scopeId,
            sequence: event.sequence,
          },
        },
        create: event,
        update: {},
      });
      agentEventBus.publish(buildLogTopic(buildId), { buildLogAdded: event });
    }
    return normalized;
  }

  async runBuild(input: {
    buildId: string;
    destinations: unknown[];
    requestId: string;
  }) {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: input.buildId },
      include: {
        artifacts: true,
        worktree: {
          include: { codebase: { include: { agent: true, repository: true } } },
        },
      },
    });
    if (!build || build.status !== "SUCCEEDED" || !build.worktree) {
      throw new Error("A successful build is required");
    }
    const artifact = build.artifacts.find(
      (entry) => entry.kind === "RUNNABLE_APP",
    );
    if (!artifact) throw new Error("Build does not contain a runnable app");
    const metadata = objectValue(
      parseJson(artifact.metadataJson, {}),
      "runnable metadata",
    );
    const bundleIdentifier = cleanName(
      String(metadata.bundleIdentifier ?? ""),
      "Runnable bundle identifier",
      512,
    );
    let destinations = input.destinations.map(parseBuildDestination);
    if (!destinations.length)
      throw new Error("Select at least one destination");
    if (
      new Set(
        destinations.map(
          (destination) => `${destination.type}:${destination.id}`,
        ),
      ).size !== destinations.length
    ) {
      throw new Error("Run destinations must be unique");
    }
    if (
      destinations.some(
        (destination) => destination.type !== build.destinationType,
      )
    ) {
      throw new Error("Run destinations must match the build destination type");
    }
    const availableDestinations = await this.destinationsForBuild(
      build.id,
      `${cleanName(input.requestId, "Request ID", 200)}:preflight`,
    );
    const resolvedDestinations = destinations.map((destination) =>
      availableDestinations.find(
        (available) =>
          available.type === destination.type &&
          available.id === destination.id,
      ),
    );
    if (resolvedDestinations.some((destination) => !destination)) {
      throw new Error("A selected run destination is no longer available");
    }
    destinations = resolvedDestinations as BuildDestination[];
    const worktree = await this.requireWorktree(
      build.worktree.id,
      IOS_DEPLOY_JOB_KIND,
    );
    const batchId = randomUUID();
    const rows = [];
    for (const destination of destinations) {
      const existing = await prisma.buildDeployment.findUnique({
        where: {
          buildId_requestId_destinationJson: {
            buildId: build.id,
            requestId: input.requestId,
            destinationJson: JSON.stringify(destination),
          },
        },
      });
      rows.push(
        existing ??
          (await prisma.buildDeployment.create({
            data: {
              id: randomUUID(),
              buildId: build.id,
              batchId,
              requestId: input.requestId,
              destinationJson: JSON.stringify(destination),
              commandSummary:
                destination.type === "SIMULATOR"
                  ? `xcrun simctl install/launch ${destination.id}`
                  : `xcrun devicectl device install/process launch --device ${destination.id}`,
            },
          })),
      );
    }
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_DEPLOY_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        buildId: build.id,
        artifactDirectory: build.artifactDirectory,
        artifactRelativePath: artifact.relativePath,
        bundleIdentifier,
        deployments: rows.map((row, index) => ({
          id: row.id,
          destination: destinations[index],
        })),
      },
      idempotencyKey: `ios:deploy:${build.id}:${input.requestId}`,
      timeoutSeconds: 3_600,
    });
    await prisma.buildDeployment.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { jobId: job.id },
    });
    this.publish(build.id);
    return prisma.buildDeployment.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      orderBy: { createdAt: "asc" },
    });
  }

  async exportArchive(input: {
    buildId: string;
    requestId: string;
    settings: unknown;
  }) {
    const prisma = await getPrismaClient();
    const existing = await prisma.buildExport.findUnique({
      where: {
        buildId_requestId: {
          buildId: input.buildId,
          requestId: input.requestId,
        },
      },
    });
    if (existing) return existing;
    const build = await prisma.build.findUnique({
      where: { id: input.buildId },
      include: { artifacts: true, worktree: true },
    });
    if (!build || build.status !== "SUCCEEDED" || !build.worktree) {
      throw new Error("A successful archive build is required");
    }
    const archive = build.artifacts.find((entry) => entry.kind === "ARCHIVE");
    if (!archive) throw new Error("Build does not contain an archive");
    const settings = parseBuildExportSettings(input.settings);
    const worktree = await this.requireWorktree(
      build.worktree.id,
      IOS_EXPORT_JOB_KIND,
    );
    const exportId = randomUUID();
    const row = await prisma.buildExport.create({
      data: {
        id: exportId,
        buildId: build.id,
        requestId: input.requestId,
        settingsSnapshotJson: JSON.stringify(settings),
        commandSummary: `xcrun xcodebuild -exportArchive -archivePath ${JSON.stringify(archive.relativePath)} -exportPath exports/${exportId}`,
      },
    });
    const job = await this.agentControl.createJob({
      agentId: worktree.codebase.agentId,
      codebaseId: worktree.codebaseId,
      worktreeId: worktree.id,
      kind: IOS_EXPORT_JOB_KIND,
      payload: {
        ...this.identity(worktree),
        buildId: build.id,
        exportId,
        artifactDirectory: build.artifactDirectory,
        archiveRelativePath: archive.relativePath,
        settings,
      },
      idempotencyKey: `ios:export:${build.id}:${input.requestId}`,
      timeoutSeconds: 3_600,
    });
    const updated = await prisma.buildExport.update({
      where: { id: row.id },
      data: { jobId: job.id },
    });
    this.publish(build.id);
    return updated;
  }

  private async projectBuildCompletion(job: {
    id: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findFirst({ where: { jobId: job.id } });
    if (!build) return;
    const result = objectValue(parseJson(job.resultJson, {}), "build result");
    const status =
      build.status === "CANCELLED"
        ? "CANCELLED"
        : buildStatusFromJob(job.status);
    await prisma.$transaction(async (transaction) => {
      await transaction.build.update({
        where: { id: build.id },
        data: {
          status,
          errorCode:
            typeof result.errorCode === "string"
              ? result.errorCode
              : job.status === "TIMED_OUT"
                ? "TIMEOUT"
                : status === "FAILED"
                  ? "XCODEBUILD_FAILED"
                  : build.errorCode,
          error:
            job.error ??
            (typeof result.error === "string" ? result.error : build.error),
          startedAt: build.startedAt ?? new Date(),
          finishedAt: new Date(),
        },
      });
      if (Array.isArray(result.artifacts)) {
        for (const raw of result.artifacts) {
          const artifact = objectValue(raw, "build artifact");
          if (
            typeof artifact.relativePath !== "string" ||
            typeof artifact.kind !== "string"
          )
            continue;
          await transaction.buildArtifact.upsert({
            where: {
              buildId_relativePath: {
                buildId: build.id,
                relativePath: artifact.relativePath,
              },
            },
            create: {
              id: randomUUID(),
              buildId: build.id,
              kind: artifact.kind,
              relativePath: artifact.relativePath,
              sizeBytes:
                typeof artifact.sizeBytes === "number"
                  ? artifact.sizeBytes
                  : null,
              checksum:
                typeof artifact.checksum === "string"
                  ? artifact.checksum
                  : null,
              metadataJson: JSON.stringify(
                artifact.metadata && typeof artifact.metadata === "object"
                  ? artifact.metadata
                  : {},
              ),
            },
            update: {},
          });
        }
      }
      if (Array.isArray(result.scriptExecutions)) {
        for (const raw of result.scriptExecutions) {
          const execution = objectValue(raw, "script execution");
          if (
            typeof execution.phase !== "string" ||
            typeof execution.position !== "number"
          )
            continue;
          await transaction.buildScriptExecution.updateMany({
            where: {
              buildId: build.id,
              phase: execution.phase,
              position: execution.position,
            },
            data: {
              status:
                typeof execution.status === "string"
                  ? execution.status
                  : "FAILED",
              exitCode:
                typeof execution.exitCode === "number"
                  ? execution.exitCode
                  : null,
              durationMs:
                typeof execution.durationMs === "number"
                  ? execution.durationMs
                  : null,
              causedBuildFailure: execution.causedBuildFailure === true,
              outputRelativePath:
                typeof execution.outputRelativePath === "string"
                  ? execution.outputRelativePath
                  : null,
              error:
                typeof execution.error === "string" ? execution.error : null,
            },
          });
        }
      }
    });
    this.publish(build.id);
  }

  private async projectDeploymentCompletion(job: {
    id: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    const prisma = await getPrismaClient();
    const rows = await prisma.buildDeployment.findMany({
      where: { jobId: job.id },
    });
    if (!rows.length) return;
    const result = objectValue(
      parseJson(job.resultJson, {}),
      "deployment result",
    );
    const outcomes = Array.isArray(result.deployments)
      ? result.deployments
      : [];
    for (const row of rows) {
      const outcome = outcomes
        .map((value) => objectValue(value, "deployment outcome"))
        .find((value) => value.id === row.id);
      await prisma.buildDeployment.update({
        where: { id: row.id },
        data: {
          status:
            typeof outcome?.status === "string"
              ? outcome.status
              : buildStatusFromJob(job.status),
          error: typeof outcome?.error === "string" ? outcome.error : job.error,
          outputRelativePath:
            typeof outcome?.outputRelativePath === "string"
              ? outcome.outputRelativePath
              : null,
          startedAt: row.startedAt ?? new Date(),
          finishedAt: new Date(),
        },
      });
    }
    this.publish(rows[0]!.buildId);
  }

  private async projectExportCompletion(job: {
    id: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }) {
    const prisma = await getPrismaClient();
    const row = await prisma.buildExport.findFirst({
      where: { jobId: job.id },
    });
    if (!row) return;
    const result = objectValue(parseJson(job.resultJson, {}), "export result");
    await prisma.buildExport.update({
      where: { id: row.id },
      data: {
        status: buildStatusFromJob(job.status),
        error:
          job.error ?? (typeof result.error === "string" ? result.error : null),
        outputRelativePath:
          typeof result.outputRelativePath === "string"
            ? result.outputRelativePath
            : null,
        startedAt: row.startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    });
    if (
      job.status === "SUCCEEDED" &&
      typeof result.outputRelativePath === "string"
    ) {
      await prisma.buildArtifact.upsert({
        where: {
          buildId_relativePath: {
            buildId: row.buildId,
            relativePath: result.outputRelativePath,
          },
        },
        create: {
          id: randomUUID(),
          buildId: row.buildId,
          kind: "EXPORT",
          relativePath: result.outputRelativePath,
          sizeBytes:
            typeof result.sizeBytes === "number" ? result.sizeBytes : null,
          metadataJson: JSON.stringify({ exportId: row.id }),
        },
        update: {},
      });
    }
    this.publish(row.buildId);
  }
}

export { buildInclude, parseJson };
