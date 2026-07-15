import { createClient, type Client } from "graphql-ws";

import type { AgentConfig } from "./config.js";
import type { AgentInventory } from "./inventory.js";
import type { ProcessLog } from "./process-runner.js";

export type AgentJob = {
  id: string;
  agentId: string;
  kind: string;
  payload: unknown;
  status:
    "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  timeoutSeconds: number;
};

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export class AgentGraphQLClient {
  private readonly server: string;
  private readonly credential: string | null;
  private readonly requestTimeoutMs: number;

  constructor(
    server: string,
    credential: string | null = null,
    requestTimeoutMs = 10_000,
  ) {
    this.server = server.replace(/\/$/, "");
    this.credential = credential;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.server}/api/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.credential
          ? { authorization: `Bearer ${this.credential}` }
          : {}),
      },
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
    const { version, osVersion, architecture, capabilities } = inventory;
    return this.request<{ heartbeatAgent: { id: string } }>(
      `mutation Heartbeat($input: AgentHeartbeatInput!) {
        heartbeatAgent(input: $input) { id }
      }`,
      { input: { version, osVersion, architecture, capabilities } },
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

  async claimJob(jobId: string): Promise<AgentJob> {
    const data = await this.request<{ claimAgentJob: AgentJob }>(
      `mutation ClaimJob($jobId: ID!) {
        claimAgentJob(jobId: $jobId) { id agentId kind payload status timeoutSeconds }
      }`,
      { jobId },
    );
    return data.claimAgentJob;
  }

  appendLog(jobId: string, log: ProcessLog) {
    return this.request<{ appendAgentJobLogs: Array<{ id: string }> }>(
      `mutation AppendLog($jobId: ID!, $logs: [AgentJobLogInput!]!) {
        appendAgentJobLogs(jobId: $jobId, logs: $logs) { id }
      }`,
      { jobId, logs: [log] },
    );
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

  self() {
    return this.request<{ agentSelf: Record<string, unknown> | null }>(
      `query AgentSelf { agentSelf { id name hostname version connectionStatus lastSeenAt } }`,
    );
  }

  health() {
    return this.request<{ health: string }>(`query Health { health }`);
  }
}

export function createAgentSubscriptionClient(config: AgentConfig): Client {
  return createClient({
    url: config.websocketServer,
    connectionParams: { authorization: `Bearer ${config.credential}` },
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
  onEvent: (event: {
    type: "JOB_AVAILABLE" | "JOB_CANCEL_REQUESTED";
    job: AgentJob;
  }) => void,
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
      agentEvents: {
        type: "JOB_AVAILABLE" | "JOB_CANCEL_REQUESTED";
        job: AgentJob;
      };
    }>(
      {
        query: `subscription AgentEvents($agentId: ID!) {
          agentEvents(agentId: $agentId) {
            type
            job { id agentId kind payload status timeoutSeconds }
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
