import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { CodebasesPage } from "./codebases-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const subscribe = vi.fn(() => vi.fn());

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
    "codebase.browse",
    "codebase.inspect",
    "codebase.refresh",
    "codebase.fetch",
  ],
  connectionStatus: "ONLINE",
  ipAddress: null,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date(0).toISOString(),
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
  lastCheckedAt: new Date(0).toISOString(),
  lastFetchedAt: null,
  agent,
  activeJob: null,
};

const repository = {
  id: "repository-1",
  canonicalOrigin: "github.com/openai/codex",
  displayOrigin: "github.com/openai/codex",
  name: "Codex",
  description: "Developer tooling",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  codebases: [codebase],
};

describe("CodebasesPage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    subscribe.mockReset();
    subscribe.mockImplementation(() => vi.fn());
    subscriptions.mockReturnValue({ subscribe } as never);
    request.mockImplementation(async (query) => {
      if (String(query).includes("query CodebaseOverview")) {
        return {
          codebaseOverview: { repositories: [repository] },
          agents: [agent],
        } as never;
      }
      if (String(query).includes("mutation RunCodebaseOperation")) {
        return {
          fetchCodebases: { jobs: [{ id: "job-1" }], skipped: [] },
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

  test("groups by agent and repository and exposes fetch actions", async () => {
    render(<CodebasesPage />);

    expect(await screen.findByText("Studio Mac")).toBeDefined();
    expect(screen.getByText("/Users/test/codex")).toBeDefined();
    expect(screen.getByText("In sync")).toBeDefined();
    expect(screen.getByText("Developer tooling")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));
    expect(await screen.findByText("github.com/openai/codex")).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => {
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("mutation RunCodebaseOperation"),
        ),
      ).toBe(true);
    });
  });

  test("browses, inspects, and confirms a new codebase", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query CodebaseOverview")) {
        return {
          codebaseOverview: { repositories: [] },
          agents: [agent],
        } as never;
      }
      if (operation.includes("mutation BrowseAgentDirectory")) {
        return {
          browseAgentDirectory: {
            path: "/Users/test/codex",
            parentPath: "/Users/test",
            homePath: "/Users/test",
            entries: [],
            truncated: false,
          },
        } as never;
      }
      if (operation.includes("mutation InspectAgentCodebase")) {
        return {
          inspectAgentCodebase: {
            jobId: "inspection-1",
            snapshot: {
              folder: "/Users/test/codex",
              observedOrigin: "git@github.com:openai/codex.git",
              canonicalOrigin: "github.com/openai/codex",
              displayOrigin: "github.com/openai/codex",
              branch: "main",
              syncState: "IN_SYNC",
            },
            existingRepository: null,
          },
        } as never;
      }
      if (operation.includes("mutation ConfirmCodebase")) {
        return { confirmCodebase: { id: "codebase-1" } } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<CodebasesPage />);
    await screen.findByText("No codebases yet");
    fireEvent.click(screen.getByRole("button", { name: "Add codebase" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Agent" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const agentOptions = await screen.findAllByText(
      "Studio Mac · studio.local",
    );
    fireEvent.click(
      agentOptions.find((element) => element.tagName === "SPAN") ??
        agentOptions[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse home folder" }));
    expect(await screen.findByText("Inspect this folder")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect this folder" }),
    );
    expect(await screen.findByDisplayValue("codex")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm codebase" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("mutation ConfirmCodebase"),
        ),
      ).toBe(true),
    );
  });
});
