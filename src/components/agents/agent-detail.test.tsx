import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { AgentDetail } from "./agent-detail";
import type { AgentJob } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptionsMock = vi.mocked(controlPlaneSubscriptions);

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: () => undefined,
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  subscriptionsMock.mockReset();
});

describe("AgentDetail", () => {
  test("ignores stale overlapping detail loads", async () => {
    const createdAt = new Date(0).toISOString();
    const response = (agentName: string, repositoryName: string) => ({
      agent: {
        id: "agent-1",
        name: agentName,
        hostname: "dev-mac.local",
        version: "1.0.0",
        osVersion: "macOS",
        architecture: "arm64",
        capabilities: [],
        baseRepoDirectory: null,
        connectionStatus: "ONLINE" as const,
        ipAddress: null,
        lastSeenAt: createdAt,
        disconnectedAt: null,
        createdAt,
      },
      agentJobs: [],
      codebaseOverview: {
        repositories: [
          {
            id: `repository-${repositoryName}`,
            name: repositoryName,
            description: "",
            displayOrigin: `github.com/example/${repositoryName}`,
            codebases: [
              {
                id: `codebase-${repositoryName}`,
                folder: `/Users/test/${repositoryName}`,
                branch: "main",
                headSha: "abc123",
                syncState: "IN_SYNC" as const,
                availability: "AVAILABLE" as const,
                lastCheckedAt: createdAt,
                agent: { id: "agent-1" },
              },
            ],
          },
        ],
      },
    });
    const staleResponse = response("Stale agent", "Stale repository");
    const latestResponse = response("Latest agent", "Latest repository");
    let resolveStale!: (value: typeof staleResponse) => void;
    let resolveLatest!: (value: typeof latestResponse) => void;
    const staleRequest = new Promise<typeof staleResponse>(
      (resolve) => (resolveStale = resolve),
    );
    const latestRequest = new Promise<typeof latestResponse>(
      (resolve) => (resolveLatest = resolve),
    );
    let triggerCodebaseReload!: () => void;
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(
        (
          operation: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (operation.query.includes("CodebaseOverviewChanged")) {
            triggerCodebaseReload = () =>
              sink.next({
                data: {
                  codebaseOverviewChanged: {
                    codebaseId: null,
                    repositoryId: null,
                  },
                },
              });
          }
          return vi.fn();
        },
      ),
    } as never);
    requestMock
      .mockImplementationOnce(() => staleRequest as never)
      .mockImplementationOnce(() => latestRequest as never);

    render(<AgentDetail agentId="agent-1" />);
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    act(() => triggerCodebaseReload());
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveLatest(latestResponse);
      await latestRequest;
    });
    expect(await screen.findByText("Latest agent")).toBeDefined();
    expect(screen.getByText("Latest repository")).toBeDefined();

    await act(async () => {
      resolveStale(staleResponse);
      await staleRequest;
    });
    await waitFor(() => expect(screen.queryByText("Stale agent")).toBeNull());
    expect(screen.getByText("Latest agent")).toBeDefined();
    expect(screen.getByText("Latest repository")).toBeDefined();
  });

  test("shows live system information and codebases for the agent", async () => {
    const createdAt = new Date(0).toISOString();
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockResolvedValue({
      agent: {
        id: "agent-1",
        name: "Development Mac",
        hostname: "dev-mac.local",
        version: "1.0.0",
        osVersion: "macOS",
        architecture: "arm64",
        cpuModel: "M4 Pro",
        memoryTotalBytes: 24 * 1024 ** 3,
        memoryFreeBytes: 12 * 1024 ** 3,
        diskTotalBytes: 512 * 1024 ** 3,
        diskFreeBytes: 256 * 1024 ** 3,
        capabilities: ["cloudflared.runTunnel", "ccusage.report"],
        baseRepoDirectory: null,
        connectionStatus: "ONLINE",
        ipAddress: "192.168.1.20",
        lastSeenAt: createdAt,
        disconnectedAt: null,
        createdAt,
      },
      agentJobs: [],
      codebaseOverview: {
        repositories: [
          {
            id: "repository-1",
            name: "Project Atlas",
            description: "",
            displayOrigin: "github.com/example/atlas",
            codebases: [
              {
                id: "codebase-1",
                folder: "/Users/test/atlas",
                branch: "main",
                headSha: "abc123",
                syncState: "IN_SYNC",
                availability: "AVAILABLE",
                lastCheckedAt: createdAt,
                agent: { id: "agent-1" },
              },
            ],
          },
        ],
      },
    } as never);

    render(<AgentDetail agentId="agent-1" />);

    expect(await screen.findByText("M4 Pro")).toBeDefined();
    expect(screen.getByText("Project Atlas")).toBeDefined();
    expect(screen.getByText("/Users/test/atlas")).toBeDefined();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search capabilities" }),
      { target: { value: "ccusage" } },
    );
    expect(screen.getByText("ccusage.report")).toBeDefined();
    expect(screen.queryByText("cloudflared.runTunnel")).toBeNull();
  });

  test("shows an empty sample payload before invoking a capability", async () => {
    const createdAt = new Date(0).toISOString();
    const job: AgentJob = {
      id: "job-dev-tunnel",
      agentId: "agent-1",
      kind: "cloudflared.runTunnel",
      payload: { tunnelName: "dev-tunnel" },
      status: "QUEUED",
      error: null,
      result: null,
      timeoutSeconds: 86400,
      createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
    };
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query AgentDetail")) {
        return {
          agent: {
            id: "agent-1",
            name: "Development Mac",
            hostname: "dev-mac.local",
            version: "1.0.0",
            osVersion: "macOS",
            architecture: "arm64",
            capabilities: ["cloudflared.runTunnel"],
            baseRepoDirectory: null,
            connectionStatus: "ONLINE",
            ipAddress: null,
            lastSeenAt: createdAt,
            disconnectedAt: null,
            createdAt,
          },
          agentJobs: [],
        } as never;
      }
      if (query.includes("mutation InvokeAgentCapability")) {
        return { createAgentJob: job } as never;
      }
      if (query.includes("query Job")) {
        return { agentJob: job, agentJobLogs: [] } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<AgentDetail agentId="agent-1" />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Expand cloudflared.runTunnel",
      }),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Payload (JSON object)",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('{\n  "tunnelName": ""\n}');
    fireEvent.change(
      screen.getByRole("textbox", { name: "Payload (JSON object)" }),
      { target: { value: '{"tunnelName":"dev-tunnel"}' } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Invoke capability" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("mutation InvokeAgentCapability"),
        expect.objectContaining({
          input: expect.objectContaining({
            payload: { tunnelName: "dev-tunnel" },
            idempotencyKey: expect.stringMatching(
              /^manual:cloudflared\.runTunnel:/,
            ),
          }),
        }),
      ),
    );
  });

  test("keeps job-history items keyboard-focusable and selects another job", async () => {
    const createdAt = new Date(0).toISOString();
    const jobs: AgentJob[] = [
      {
        id: "job-1",
        agentId: "agent-1",
        kind: "cloudflared.first",
        payload: {},
        status: "SUCCEEDED",
        error: null,
        result: null,
        timeoutSeconds: 60,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        updatedAt: createdAt,
      },
      {
        id: "job-2",
        agentId: "agent-1",
        kind: "cloudflared.second",
        payload: {},
        status: "SUCCEEDED",
        error: null,
        result: null,
        timeoutSeconds: 60,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        updatedAt: createdAt,
      },
    ];
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query AgentDetail")) {
        return {
          agent: {
            id: "agent-1",
            name: "Development Mac",
            hostname: "dev-mac.local",
            version: "1.0.0",
            osVersion: "macOS",
            architecture: "arm64",
            capabilities: ["cloudflared.runTunnel"],
            baseRepoDirectory: null,
            connectionStatus: "ONLINE",
            ipAddress: null,
            lastSeenAt: createdAt,
            disconnectedAt: null,
            createdAt,
          },
          agentJobs: jobs,
        } as never;
      }
      if (query.includes("query Job")) {
        const job = jobs.find((item) => item.id === variables?.id) ?? null;
        return { agentJob: job, agentJobLogs: [] } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<AgentDetail agentId="agent-1" />);
    const secondJob = await screen.findByRole("button", {
      name: /cloudflared\.second/i,
    });
    secondJob.focus();
    expect(document.activeElement).toBe(secondJob);
    fireEvent.click(secondJob);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query Job"),
        { id: "job-2" },
      ),
    );
  });

  test("browses and saves the base repository directory for this agent", async () => {
    const createdAt = new Date(0).toISOString();
    const agent = {
      id: "agent-1",
      name: "Development Mac",
      hostname: "dev-mac.local",
      version: "1.0.0",
      osVersion: "macOS",
      architecture: "arm64",
      capabilities: ["codebase.browse"],
      baseRepoDirectory: null,
      connectionStatus: "ONLINE" as const,
      ipAddress: null,
      lastSeenAt: createdAt,
      disconnectedAt: null,
      createdAt,
    };
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query AgentDetail")) {
        return { agent, agentJobs: [] } as never;
      }
      if (query.includes("mutation BrowseAgentDirectory")) {
        return {
          browseAgentDirectory: {
            path: "/Users/test/Repositories",
            parentPath: "/Users/test",
            homePath: "/Users/test",
            entries: [],
            truncated: false,
          },
        } as never;
      }
      if (query.includes("mutation UpdateAgentBaseRepoDirectory")) {
        return {
          updateAgentBaseRepoDirectory: {
            ...agent,
            baseRepoDirectory: "/Users/test/Repositories",
          },
        } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<AgentDetail agentId="agent-1" />);
    expect(await screen.findByText("Base repository directory")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Browse home folder" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Use this directory" }),
    );

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("mutation UpdateAgentBaseRepoDirectory"),
        {
          agentId: "agent-1",
          baseRepoDirectory: "/Users/test/Repositories",
        },
      ),
    );
    expect(await screen.findByText("/Users/test/Repositories")).toBeDefined();
    const clearDirectory = screen.getByRole("button", {
      name: "Clear directory",
    });
    const browseHome = screen.getByRole("button", {
      name: "Browse home folder",
    });
    expect(clearDirectory.parentElement?.className).toContain("flex");
    expect(clearDirectory.parentElement?.contains(browseHome)).toBe(true);
  });
});
