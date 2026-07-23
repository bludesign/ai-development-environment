import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";

import type { AgentConfig } from "./config.js";
import type { AgentInventory } from "./inventory.js";
import type { ProcessLog } from "./process-runner.js";
import type { CodebaseStatusReport } from "@ai-development-environment/agent-contract/codebases";
import type {
  CodebaseWorktreeReport,
  WorktreeActivityReport,
} from "@ai-development-environment/agent-contract/worktrees";

export type AgentJob = {
  id: string;
  agentId: string;
  kind: string;
  payload: unknown;
  status:
    "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  timeoutSeconds: number;
};

export type RunAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  downloadPath: string;
};

export type RunRecord = {
  id: string;
  kind: "PLAN" | "SESSION";
  displayNumber: number;
  status: string;
  phase: string;
  origin: "MANAGED" | "IMPORTED";
  provider: "CODEX" | "CLAUDE" | "OPENCODE";
  worktreeId: string | null;
  agentId: string | null;
  worktree: { id: string; folder: string; branch: string | null } | null;
  model: string;
  effort: string | null;
  webSearchEnabled: boolean;
  initialPrompt: string;
  finalOutput: string | null;
  inputs: Array<{
    id: string;
    sequence: number;
    kind: string;
    prompt: string;
    attachments: RunAttachment[];
  }>;
  attempts: Array<{
    id: string;
    generation: number;
    nativeId: string | null;
    status: string;
  }>;
  sourcePlan: Pick<RunRecord, "id" | "provider" | "attempts"> | null;
  parentRun: Pick<RunRecord, "id" | "provider" | "attempts"> | null;
};

export type RunCommand = {
  id: string;
  runId: string;
  agentId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  error: string | null;
  run: RunRecord;
};

export type AgentEvent =
  | {
      type: "JOB_AVAILABLE" | "JOB_CANCEL_REQUESTED";
      job: AgentJob;
    }
  | {
      type: "CODEBASE_RECONCILE_REQUESTED" | "AGENT_CONFIGURATION_CHANGED";
      job: null;
      runCommand?: null;
    }
  | {
      type: "RUN_COMMAND_AVAILABLE";
      job: null;
      runCommand: RunCommand;
    };

export type AgentCadenceSettings = {
  agentId: string;
  codebaseScanIntervalSeconds: number;
  jobReconciliationIntervalSeconds: number;
  gitFetchIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
};

export type AgentCodebaseRegistration = {
  id: string;
  folder: string;
  canonicalOrigin: string;
  defaultBranch: string | null;
  keepBaseBranchUpToDate: boolean;
  lastFetchedAt: string | null;
  lastFetchAttemptAt: string | null;
  worktrees: Array<{
    id: string;
    folder: string;
    branch: string | null;
    gitDirectory: string;
    baseBranchOverride: string | null;
  }>;
};

export type AgentCodebaseConfiguration = {
  refreshIntervalSeconds: number;
  fetchIntervalSeconds: number;
  codebases: AgentCodebaseRegistration[];
};

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

const RUN_COMMAND_FIELDS = `
  id runId agentId sequence type payload status error
  run {
    id kind displayNumber status phase origin provider worktreeId agentId
    worktree { id folder branch }
    model effort webSearchEnabled initialPrompt finalOutput
    inputs { id sequence kind prompt attachments { id filename contentType size sha256 downloadPath } }
    attempts { id generation nativeId status }
    sourcePlan { id provider attempts { id generation nativeId status } }
    parentRun { id provider attempts { id generation nativeId status } }
  }
`;

function mergeHeaders(
  custom: Record<string, string>,
  owned: Record<string, string>,
): Record<string, string> {
  const ownedNames = new Set(
    Object.keys(owned).map((name) => name.toLowerCase()),
  );
  return {
    ...Object.fromEntries(
      Object.entries(custom).filter(
        ([name]) => !ownedNames.has(name.toLowerCase()),
      ),
    ),
    ...owned,
  };
}

export class AgentGraphQLClient {
  private readonly server: string;
  private readonly credential: string | null;
  private readonly requestTimeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(
    server: string,
    credential: string | null = null,
    requestTimeoutMs = 10_000,
    headers: Record<string, string> = {},
  ) {
    this.server = server.replace(/\/$/, "");
    this.credential = credential;
    this.requestTimeoutMs = requestTimeoutMs;
    this.headers = { ...headers };
  }

  async request<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.server}/api/graphql`, {
      method: "POST",
      headers: mergeHeaders(this.headers, {
        "content-type": "application/json",
        ...(this.credential
          ? { authorization: `Bearer ${this.credential}` }
          : {}),
      }),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const body = (await response.json()) as GraphQLResponse<T>;
    if (!response.ok || body.errors?.length || !body.data) {
      throw new Error(
        body.errors?.map((error) => error.message).join("; ") ||
          `HTTP ${response.status}`,
      );
    }
    return body.data;
  }

  enroll(input: AgentInventory & { enrollmentToken: string; name: string }) {
    return this.request<{
      enrollAgent: { agent: { id: string }; credential: string };
    }>(
      `mutation Enroll($input: EnrollAgentInput!) {
        enrollAgent(input: $input) { agent { id } credential }
      }`,
      { input },
    );
  }

  createEnrollmentToken() {
    return this.request<{
      createAgentEnrollmentToken: { token: string; expiresAt: string };
    }>(
      `mutation CreateEnrollmentToken {
        createAgentEnrollmentToken { token expiresAt }
      }`,
    );
  }

  heartbeat(inventory: AgentInventory) {
    const {
      version,
      osVersion,
      architecture,
      cpuModel,
      memoryTotalBytes,
      memoryFreeBytes,
      diskTotalBytes,
      diskFreeBytes,
      capabilities,
      defaultBuildsDirectory,
    } = inventory;
    return this.request<{ heartbeatAgent: { id: string } }>(
      `mutation Heartbeat($input: AgentHeartbeatInput!) {
        heartbeatAgent(input: $input) { id }
      }`,
      {
        input: {
          version,
          osVersion,
          architecture,
          cpuModel,
          memoryTotalBytes,
          memoryFreeBytes,
          diskTotalBytes,
          diskFreeBytes,
          capabilities,
          defaultBuildsDirectory,
        },
      },
    );
  }

  async pendingJobs(agentId: string): Promise<AgentJob[]> {
    const data = await this.request<{ agentJobs: AgentJob[] }>(
      `query PendingJobs($agentId: ID!) {
        agentJobs(agentId: $agentId, limit: 200) {
          id agentId kind payload status timeoutSeconds
        }
      }`,
      { agentId },
    );
    return data.agentJobs.filter(
      (job) =>
        job.status === "QUEUED" ||
        job.status === "RUNNING" ||
        job.status === "CANCELLED",
    );
  }

  async cadenceSettings(agentId: string): Promise<AgentCadenceSettings> {
    const data = await this.request<{
      agentCadenceSettings: AgentCadenceSettings;
    }>(
      `query AgentCadenceSettings($agentId: ID!) {
        agentCadenceSettings(agentId: $agentId) {
          agentId
          codebaseScanIntervalSeconds
          jobReconciliationIntervalSeconds
          gitFetchIntervalSeconds
          heartbeatIntervalSeconds
        }
      }`,
      { agentId },
    );
    return data.agentCadenceSettings;
  }

  async claimJob(jobId: string): Promise<AgentJob> {
    const data = await this.request<{ claimAgentJob: AgentJob }>(
      `mutation ClaimJob($jobId: ID!) {
        claimAgentJob(jobId: $jobId) { id agentId kind payload status timeoutSeconds }
      }`,
      { jobId },
    );
    return data.claimAgentJob;
  }

  async claimSigningSecretTransfer(transferId: string): Promise<{
    p12Base64: string;
    passphrase: string;
  }> {
    const data = await this.request<{
      claimSigningSecretTransfer: {
        p12Base64: string;
        passphrase: string;
      };
    }>(
      `mutation ClaimSigningSecretTransfer($transferId: ID!) {
        claimSigningSecretTransfer(transferId: $transferId) {
          p12Base64
          passphrase
        }
      }`,
      { transferId },
    );
    return data.claimSigningSecretTransfer;
  }

  appendLog(jobId: string, log: ProcessLog) {
    return this.request<{ appendAgentJobLogs: Array<{ id: string }> }>(
      `mutation AppendLog($jobId: ID!, $logs: [AgentJobLogInput!]!) {
        appendAgentJobLogs(jobId: $jobId, logs: $logs) { id }
      }`,
      { jobId, logs: [log] },
    );
  }

  reportBuildProgress(input: {
    buildId: string;
    status: "PREPARING" | "RUNNING";
    startedAt?: string;
    errorCode?: string;
    error?: string;
  }) {
    return this.request<{ reportBuildProgress: { id: string } }>(
      `mutation ReportBuildProgress($input: BuildProgressInput!) {
        reportBuildProgress(input: $input) { id }
      }`,
      { input },
    );
  }

  appendBuildLogs(
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
    return this.request<{ appendBuildLogEvents: Array<{ id: string }> }>(
      `mutation AppendBuildLogs($buildId: ID!, $events: [BuildLogEventInput!]!) {
        appendBuildLogEvents(buildId: $buildId, events: $events) { id }
      }`,
      { buildId, events },
    );
  }

  async uploadBuildArtifact(input: {
    uploadId: string;
    path: string;
    filename: string;
    contentType: string;
  }) {
    const information = await stat(input.path);
    const response = await fetch(
      `${this.server}/api/build-artifact-uploads/${encodeURIComponent(input.uploadId)}`,
      {
        method: "POST",
        headers: mergeHeaders(this.headers, {
          ...(this.credential
            ? { authorization: `Bearer ${this.credential}` }
            : {}),
          "content-length": String(information.size),
          "content-type": input.contentType,
          "x-artifact-filename": encodeURIComponent(input.filename),
        }),
        body: Readable.toWeb(createReadStream(input.path)),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    if (!response.ok) {
      throw new Error(
        `Artifact upload failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
  }

  completeJob(
    jobId: string,
    status: AgentJob["status"],
    result?: unknown,
    error?: string,
  ) {
    return this.request<{ completeAgentJob: { id: string; status: string } }>(
      `mutation CompleteJob($jobId: ID!, $status: AgentJobStatus!, $result: JSON, $error: String) {
        completeAgentJob(jobId: $jobId, status: $status, result: $result, error: $error) { id status }
      }`,
      { jobId, status, result, error },
    );
  }

  async pendingRunCommands(): Promise<RunCommand[]> {
    const data = await this.request<{ pendingRunCommands: RunCommand[] }>(
      `query PendingRunCommands {
        pendingRunCommands { ${RUN_COMMAND_FIELDS} }
      }`,
    );
    return data.pendingRunCommands;
  }

  async claimRunCommand(id: string): Promise<RunCommand> {
    const data = await this.request<{ claimRunCommand: RunCommand }>(
      `mutation ClaimRunCommand($id: ID!) {
        claimRunCommand(id: $id) { ${RUN_COMMAND_FIELDS} }
      }`,
      { id },
    );
    return data.claimRunCommand;
  }

  completeRunCommand(
    id: string,
    status: "SUCCEEDED" | "FAILED",
    error?: string,
  ) {
    return this.request<{ completeRunCommand: { id: string; status: string } }>(
      `mutation CompleteRunCommand($id: ID!, $status: String!, $error: String) {
        completeRunCommand(id: $id, status: $status, error: $error) { id status }
      }`,
      { id, status, error },
    );
  }

  async beginRunAttempt(runId: string, nativeId?: string) {
    const data = await this.request<{
      beginRunAttempt: { id: string; generation: number };
    }>(
      `mutation BeginRunAttempt($runId: ID!, $nativeId: String) {
        beginRunAttempt(runId: $runId, nativeId: $nativeId) { id generation }
      }`,
      { runId, nativeId },
    );
    return data.beginRunAttempt;
  }

  updateRunAttemptNativeId(
    attemptId: string,
    nativeId: string,
    providerVersion?: string,
  ) {
    return this.request<{
      updateRunAttemptNativeId: { id: string; nativeId: string };
    }>(
      `mutation UpdateRunAttemptNativeId($attemptId: ID!, $nativeId: String!, $providerVersion: String) {
        updateRunAttemptNativeId(attemptId: $attemptId, nativeId: $nativeId, providerVersion: $providerVersion) { id nativeId }
      }`,
      { attemptId, nativeId, providerVersion },
    );
  }

  appendRunEvents(
    runId: string,
    attemptId: string | null,
    events: Array<Record<string, unknown>>,
  ) {
    return this.request<{
      appendRunEvents: Array<{ id: string; sequence: number }>;
    }>(
      `mutation AppendRunEvents($runId: ID!, $attemptId: ID, $events: [RunEventInput!]!) {
        appendRunEvents(runId: $runId, attemptId: $attemptId, events: $events) { id sequence }
      }`,
      { runId, attemptId, events },
    );
  }

  reportRunQuestion(input: {
    runId: string;
    attemptId: string | null;
    nativeRequestId: string | null;
    eventSequence: number;
    questions: Array<Record<string, unknown>>;
  }) {
    return this.request<{ reportRunQuestion: { id: string } }>(
      `mutation ReportRunQuestion($runId: ID!, $attemptId: ID, $nativeRequestId: String, $eventSequence: Int, $questions: [RunQuestionInput!]!) {
        reportRunQuestion(runId: $runId, attemptId: $attemptId, nativeRequestId: $nativeRequestId, eventSequence: $eventSequence, questions: $questions) { id }
      }`,
      input,
    ).then(({ reportRunQuestion }) => reportRunQuestion);
  }

  reportRunUsage(
    runId: string,
    attemptId: string | null,
    input: Record<string, unknown>,
  ) {
    return this.request<{ reportRunUsage: { id: string } }>(
      `mutation ReportRunUsage($runId: ID!, $attemptId: ID, $input: RunUsageInput!) {
        reportRunUsage(runId: $runId, attemptId: $attemptId, input: $input) { id }
      }`,
      { runId, attemptId, input },
    );
  }

  finishRunAttempt(
    attemptId: string,
    input: {
      status: string;
      phase?: string;
      finalOutput?: string;
      error?: string;
    },
  ) {
    return this.request<{ finishRunAttempt: { id: string; status: string } }>(
      `mutation FinishRunAttempt($attemptId: ID!, $input: FinishRunAttemptInput!) {
        finishRunAttempt(attemptId: $attemptId, input: $input) { id status }
      }`,
      { attemptId, input },
    );
  }

  reportRunCheckpoint(
    runId: string,
    attemptId: string | null,
    input: Record<string, unknown>,
  ) {
    return this.request<{ reportRunCheckpoint: { id: string } }>(
      `mutation ReportRunCheckpoint($runId: ID!, $attemptId: ID, $input: ReportRunCheckpointInput!) {
        reportRunCheckpoint(runId: $runId, attemptId: $attemptId, input: $input) { id }
      }`,
      { runId, attemptId, input },
    );
  }

  reportRunAnswerRevisionPreview(
    batchId: string,
    rollbackPatch: string,
    pushedCommitWarning?: string | null,
  ) {
    return this.request<{ reportRunAnswerRevisionPreview: { id: string } }>(
      `mutation ReportRunAnswerRevisionPreview($batchId: ID!, $rollbackPatch: String!, $pushedCommitWarning: String) {
        reportRunAnswerRevisionPreview(batchId: $batchId, rollbackPatch: $rollbackPatch, pushedCommitWarning: $pushedCommitWarning) { id }
      }`,
      { batchId, rollbackPatch, pushedCommitWarning },
    );
  }

  applyRunAnswerRevision(
    batchId: string,
    revisionId: string,
    replacementAttemptId: string,
  ) {
    return this.request<{ applyRunAnswerRevision: { id: string } }>(
      `mutation ApplyRunAnswerRevision($batchId: ID!, $revisionId: ID!, $replacementAttemptId: ID!) {
        applyRunAnswerRevision(batchId: $batchId, revisionId: $revisionId, replacementAttemptId: $replacementAttemptId) { id }
      }`,
      { batchId, revisionId, replacementAttemptId },
    );
  }

  importProviderRuns(provider: string, runs: Array<Record<string, unknown>>) {
    return this.request<{ importProviderRuns: number }>(
      `mutation ImportProviderRuns($provider: String!, $runs: [ImportedRunInput!]!) {
        importProviderRuns(provider: $provider, runs: $runs)
      }`,
      { provider, runs },
    );
  }

  reportRunProviderImportStatus(
    provider: string,
    status: "SYNCING" | "IDLE" | "FAILED",
    error?: string,
    catalog?: unknown,
  ) {
    return this.request<{ reportRunProviderImportStatus: { id: string } }>(
      `mutation ReportRunProviderImportStatus($provider: String!, $status: String!, $error: String, $catalog: JSON) {
        reportRunProviderImportStatus(provider: $provider, status: $status, error: $error, catalog: $catalog) { id }
      }`,
      { provider, status, error, catalog },
    );
  }

  async downloadRunAttachment(attachment: RunAttachment, destination: string) {
    const response = await fetch(
      `${this.server}${attachment.downloadPath.replace("/api/run-attachments/", "/api/agent/run-attachments/")}`,
      {
        headers: mergeHeaders(
          this.headers,
          this.credential ? { authorization: `Bearer ${this.credential}` } : {},
        ),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Attachment download failed: HTTP ${response.status}`);
    }
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { mode: 0o600 }),
    );
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(destination))
      digest.update(chunk);
    const information = await stat(destination);
    if (
      information.size !== attachment.size ||
      digest.digest("hex") !== attachment.sha256
    ) {
      await rm(destination, { force: true });
      throw new Error("Attachment checksum verification failed");
    }
  }

  self() {
    return this.request<{ agentSelf: Record<string, unknown> | null }>(
      `query AgentSelf { agentSelf { id name hostname version connectionStatus lastSeenAt } }`,
    );
  }

  health() {
    return this.request<{ health: string }>(`query Health { health }`);
  }

  async agentCodebases(): Promise<AgentCodebaseRegistration[]> {
    const data = await this.request<{
      agentCodebases: Array<{
        id: string;
        folder: string;
        canonicalOrigin: string;
        defaultBranch: string | null;
        keepBaseBranchUpToDate: boolean;
        lastFetchedAt: string | null;
        lastFetchAttemptAt: string | null;
        worktrees: Array<{
          id: string;
          folder: string;
          branch: string | null;
          gitDirectory: string;
          baseBranchOverride: string | null;
        }>;
      }>;
    }>(`query AgentCodebases {
      agentCodebases {
        id folder canonicalOrigin defaultBranch keepBaseBranchUpToDate lastFetchedAt lastFetchAttemptAt
        worktrees { id folder branch gitDirectory baseBranchOverride }
      }
    }`);
    return data.agentCodebases;
  }

  async agentCodebaseConfiguration(): Promise<AgentCodebaseConfiguration> {
    const data = await this.request<{
      agentCodebaseConfiguration: AgentCodebaseConfiguration;
    }>(`query AgentCodebaseConfiguration {
      agentCodebaseConfiguration {
        refreshIntervalSeconds
        fetchIntervalSeconds
        codebases {
          id folder canonicalOrigin defaultBranch keepBaseBranchUpToDate lastFetchedAt lastFetchAttemptAt
          worktrees { id folder branch gitDirectory baseBranchOverride }
        }
      }
    }`);
    return data.agentCodebaseConfiguration;
  }

  reportCodebaseStatuses(reports: CodebaseStatusReport[]) {
    return this.request<{ reportCodebaseStatuses: Array<{ id: string }> }>(
      `mutation ReportCodebaseStatuses($reports: [CodebaseStatusReportInput!]!) {
        reportCodebaseStatuses(reports: $reports) { id }
      }`,
      { reports },
    );
  }

  reportWorktrees(reports: CodebaseWorktreeReport[]) {
    return this.request<{ reportWorktrees: Array<{ id: string }> }>(
      `mutation ReportWorktrees($reports: [CodebaseWorktreeReportInput!]!) {
        reportWorktrees(reports: $reports) { id }
      }`,
      { reports },
    );
  }

  reportWorktreeActivity(input: WorktreeActivityReport) {
    return this.request<{
      reportWorktreeActivity: { worktreeId: string; observedAt: string };
    }>(
      `mutation ReportWorktreeActivity($input: WorktreeActivityReportInput!) {
        reportWorktreeActivity(input: $input) { worktreeId observedAt }
      }`,
      { input },
    );
  }
}

export function agentWebSocketHeaders(
  config: AgentConfig,
): Record<string, string> {
  return mergeHeaders(config.headers ?? {}, {
    authorization: `Bearer ${config.credential}`,
  });
}

export function createAgentSubscriptionClient(config: AgentConfig): Client {
  const headers = agentWebSocketHeaders(config);
  class AgentWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers });
    }
  }
  return createClient({
    url: config.websocketServer,
    connectionParams: { authorization: `Bearer ${config.credential}` },
    webSocketImpl: AgentWebSocket,
    lazy: false,
    retryAttempts: Infinity,
    shouldRetry: () => true,
    retryWait: async (retries) => {
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retries, 5));
      await new Promise((resolve) => setTimeout(resolve, delay));
    },
    on: {
      connected: () => console.log("Connected to control-plane WebSocket"),
      closed: () =>
        console.log("Control-plane WebSocket disconnected; retrying"),
    },
  });
}

export function subscribeToAgentEvents(
  client: Client,
  agentId: string,
  onEvent: (event: AgentEvent) => void,
): () => void {
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeSubscription: () => void = () => undefined;

  const scheduleResubscribe = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      subscribe();
    }, 1_000);
    retryTimer.unref();
  };

  const subscribe = () => {
    if (stopped) return;
    disposeSubscription = client.subscribe<{
      agentEvents: AgentEvent;
    }>(
      {
        query: `subscription AgentEvents($agentId: ID!) {
          agentEvents(agentId: $agentId) {
            type
            job { id agentId kind payload status timeoutSeconds }
            runCommand { ${RUN_COMMAND_FIELDS} }
          }
        }`,
        variables: { agentId },
      },
      {
        next: (result) => {
          if (result.data?.agentEvents) onEvent(result.data.agentEvents);
        },
        error: (error) => {
          console.error("Agent event subscription error; retrying:", error);
          scheduleResubscribe();
        },
        complete: () => {
          console.log("Agent event subscription completed; retrying");
          scheduleResubscribe();
        },
      },
    );
  };

  subscribe();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    disposeSubscription();
  };
}
