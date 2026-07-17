import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import type { AgentJob } from "@/components/agents/types";

import { CodebaseDetailPage } from "./codebase-detail-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
let jobNext: ((job: typeof queuedJob) => void) | null = null;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const agent = {
  id: "agent-1",
  name: "Studio Mac",
  hostname: "studio.local",
  version: "0.1.0",
  osVersion: "macOS",
  architecture: "arm64",
  capabilities: [
    "codebase.refresh",
    "codebase.fetch",
    "codebase.git.inspect",
    "codebase.git.operation",
  ],
  baseRepoDirectory: null,
  connectionStatus: "ONLINE",
  ipAddress: null,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date(0).toISOString(),
};

const queuedJob: AgentJob = {
  id: "job-1",
  agentId: "agent-1",
  kind: "codebase.git.operation",
  payload: {},
  status: "QUEUED" as const,
  error: null,
  result: null,
  timeoutSeconds: 60,
  createdAt: new Date(0).toISOString(),
  startedAt: null,
  finishedAt: null,
  updatedAt: new Date(0).toISOString(),
};

const codebase = {
  id: "codebase-1",
  folder: "/Users/test/codex",
  observedOrigin: "git@github.com:openai/codex.git",
  branch: "main",
  headSha: "abc123",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "IN_SYNC",
  availability: "AVAILABLE",
  statusError: null,
  defaultBranch: "main",
  localBranches: ["feature/detail", "main"],
  remoteBranches: ["feature/detail", "main", "remote-only"],
  lastCheckedAt: new Date(0).toISOString(),
  lastFetchedAt: new Date(0).toISOString(),
  lastFetchAttemptAt: null,
  lastFetchError: null,
  agent,
  repository: {
    id: "repository-1",
    canonicalOrigin: "github.com/openai/codex",
    displayOrigin: "github.com/openai/codex",
    name: "Codex",
    description: "Developer tooling",
    jiraBranchRegex: null,
    keepBaseBranchUpToDate: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  activeJob: null,
};

const gitState = {
  dirty: false,
  branchesTruncated: false,
  stashesTruncated: false,
  branches: [
    {
      name: "feature/detail",
      local: true,
      remote: true,
      current: false,
      checkedOutPath: null,
    },
    {
      name: "main",
      local: true,
      remote: true,
      current: true,
      checkedOutPath: "/Users/test/codex",
    },
    {
      name: "remote-only",
      local: false,
      remote: true,
      current: false,
      checkedOutPath: null,
    },
  ],
  stashes: [
    {
      oid: "a".repeat(40),
      selector: "stash@{0}",
      message: "On main: saved work",
      createdAt: new Date(0).toISOString(),
    },
  ],
};

describe("CodebaseDetailPage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    jobNext = null;
    subscriptions.mockReturnValue({
      subscribe: vi.fn((operation, sink) => {
        if (String(operation.query).includes("CodebaseJobChanged")) {
          jobNext = (job) =>
            sink.next({ data: { agentJobChanged: job } } as never);
        }
        return vi.fn();
      }),
    } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query CodebaseDetail")) {
        return { codebase } as never;
      }
      if (operation.includes("mutation InspectCodebaseGitState")) {
        return { inspectCodebaseGitState: gitState } as never;
      }
      if (operation.includes("mutation RunCodebaseGitOperation")) {
        return { runCodebaseGitOperation: queuedJob } as never;
      }
      if (operation.includes("mutation InspectCodebaseStash")) {
        return {
          inspectCodebaseStash: {
            oid: "a".repeat(40),
            patch: "diff --git a/file.ts b/file.ts\n+next\n",
            truncated: false,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("shows local and remote branch actions and queues a switch", async () => {
    render(<CodebaseDetailPage codebaseId="codebase-1" />);

    expect(await screen.findByRole("heading", { name: "Codex" })).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Back to codebases" })
        .getAttribute("href"),
    ).toBe("/codebases");
    expect(screen.getByRole("table", { name: "Local branches" })).toBeDefined();
    expect(
      screen.getByRole("table", { name: "Remote origin branches" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Pull remote-only" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Switch feature/detail" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RunCodebaseGitOperation"),
        expect.objectContaining({
          input: expect.objectContaining({
            operation: "SWITCH_BRANCH",
            branch: "feature/detail",
            stashChanges: false,
          }),
        }),
      ),
    );

    act(() => {
      jobNext?.({
        ...queuedJob,
        status: "SUCCEEDED" as const,
        finishedAt: new Date().toISOString(),
      });
    });
    expect(await screen.findByText("Git operation completed.")).toBeDefined();
  });

  test("loads stash patches lazily and confirms deletion", async () => {
    render(<CodebaseDetailPage codebaseId="codebase-1" />);
    await screen.findByRole("heading", { name: "Codex" });
    fireEvent.click(screen.getByRole("tab", { name: "Stashes (1)" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview stash@{0}" }));
    expect(await screen.findByText(/diff --git a\/file.ts/)).toBeDefined();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation InspectCodebaseStash"),
      expect.objectContaining({
        input: expect.objectContaining({ stashOid: "a".repeat(40) }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete stash@{0}" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete stash?")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RunCodebaseGitOperation"),
        expect.objectContaining({
          input: expect.objectContaining({
            operation: "DELETE_STASH",
            stashOid: "a".repeat(40),
          }),
        }),
      ),
    );
  });

  test("deletes non-main remote branches with confirmation", async () => {
    render(<CodebaseDetailPage codebaseId="codebase-1" />);
    await screen.findByRole("heading", { name: "Codex" });

    expect(
      screen
        .getByRole("button", { name: "Delete remote main" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete remote feature/detail" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete remote branch?")).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete remote" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RunCodebaseGitOperation"),
        expect.objectContaining({
          input: expect.objectContaining({
            operation: "DELETE_REMOTE_BRANCH",
            branch: "feature/detail",
          }),
        }),
      ),
    );
  });

  test("shows persisted branches read-only for an older agent", async () => {
    request.mockImplementation(async (query) => {
      if (String(query).includes("query CodebaseDetail")) {
        return {
          codebase: { ...codebase, agent: { ...agent, capabilities: [] } },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<CodebaseDetailPage codebaseId="codebase-1" />);

    expect(await screen.findByText(/Update this agent/)).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Switch feature/detail" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("mutation InspectCodebaseGitState"),
      ),
    ).toBe(false);
  });
});
