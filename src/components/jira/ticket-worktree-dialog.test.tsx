import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { waitForWorktreeJob } from "@/components/worktrees/worktree-jobs";

import { TicketWorktreeDialog } from "./ticket-worktree-dialog";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("@/components/worktrees/worktree-jobs", () => ({
  waitForWorktreeJob: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const waitForJob = vi.mocked(waitForWorktreeJob);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
});

const overview = {
  agents: [
    {
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        hostname: "studio.local",
        connectionStatus: "ONLINE",
        capabilities: ["worktree.branch"],
      },
      codebases: [
        {
          repository: {
            name: "Codex",
            displayOrigin: "github.com/openai/codex",
          },
          codebase: {
            id: "codebase-1",
            folder: "/repos/codex",
            availability: "AVAILABLE",
            defaultBranch: "main",
            localBranches: ["main", "develop", "feature/old"],
            remoteBranches: ["main", "develop", "feature/old"],
          },
          worktrees: [
            {
              id: "worktree-1",
              codebaseId: "codebase-1",
              folder: "/repos/codex-feature-old",
              branch: "feature/old",
              baseBranch: "develop",
              availability: "AVAILABLE",
              hasStagedChanges: true,
              hasUnstagedChanges: false,
              activeJob: null,
            },
          ],
        },
      ],
    },
    {
      agent: {
        id: "agent-offline",
        name: "Offline Mac",
        hostname: "offline.local",
        connectionStatus: "OFFLINE",
        capabilities: ["worktree.branch"],
      },
      codebases: [
        {
          repository: {
            name: "Hidden",
            displayOrigin: "github.com/example/hidden",
          },
          codebase: {
            id: "codebase-offline",
            folder: "/repos/hidden",
            availability: "AVAILABLE",
            defaultBranch: "main",
            localBranches: ["main"],
            remoteBranches: ["main"],
          },
          worktrees: [],
        },
      ],
    },
  ],
};

const preview = {
  ticketKey: "APP-123",
  ticketTitle: "Add searchable worktrees",
  ticketType: "Story",
  projectKey: "APP",
  branchName: "feature/APP-123-add-searchable-worktrees",
};

function mockRequests() {
  request.mockImplementation(async (query) => {
    if (query.includes("TicketWorktreeDestinations")) {
      return { worktreeOverview: overview } as never;
    }
    if (query.includes("PreviewWorktreeTicketBranch")) {
      return { previewWorktreeTicketBranch: preview } as never;
    }
    if (query.includes("CreateTicketWorktree")) {
      return { createWorktree: { id: "job-create" } } as never;
    }
    if (query.includes("ChangeTicketWorktree")) {
      return { changeWorktreeBranch: { id: "job-change" } } as never;
    }
    throw new Error(`Unexpected query: ${query}`);
  });
}

async function openDestinationSelect() {
  fireEvent.click(
    await screen.findByRole("combobox", { name: "Select a destination" }),
  );
  await screen.findByRole(
    "combobox",
    { name: "Search worktrees, agents, and codebases" },
    { timeout: 3_000 },
  );
}

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  request.mockReset();
  waitForJob.mockReset();
});

describe("TicketWorktreeDialog", () => {
  test("lists eligible agent/codebase destinations and creates the fixed ticket worktree", async () => {
    mockRequests();
    waitForJob.mockResolvedValue();
    render(
      <TicketWorktreeDialog issueKey="APP-123" onOpenChange={vi.fn()} open />,
    );

    await openDestinationSelect();
    const destination = await screen.findByRole("option", {
      name: /Codex · Studio Mac/,
    });
    expect(destination.getAttribute("data-slot")).toBe("command-item");
    expect(destination.querySelector('[data-slot="item"]')).not.toBeNull();
    expect(screen.queryByRole("option", { name: /Offline Mac/ })).toBeNull();
    fireEvent.click(destination);

    const ticketInput = await screen.findByDisplayValue("APP-123");
    expect((ticketInput as HTMLInputElement).readOnly).toBe(true);
    expect(await screen.findByText("Add searchable worktrees")).toBeDefined();
    expect(
      screen.getByText("feature/APP-123-add-searchable-worktrees"),
    ).toBeDefined();
    expect(screen.queryByRole("tab", { name: "From ticket" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Create ticket worktree" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("CreateTicketWorktree"),
        {
          input: {
            codebaseId: "codebase-1",
            selection: {
              mode: "TICKET",
              ticketKey: "APP-123",
              baseBranch: "main",
            },
            requestId: expect.any(String),
          },
        },
      ),
    );
    expect(waitForJob).toHaveBeenCalledWith("job-create");
  });

  test("lists existing worktrees and switches one to the ticket branch", async () => {
    mockRequests();
    waitForJob.mockResolvedValue();
    render(
      <TicketWorktreeDialog issueKey="APP-123" onOpenChange={vi.fn()} open />,
    );

    expect(screen.getByRole("dialog").className).toContain("sm:max-w-2xl");
    fireEvent.click(
      await screen.findByRole("tab", { name: "Existing worktree" }),
    );
    await openDestinationSelect();
    const worktreeOption = await screen.findByRole("option", {
      name: /feature\/old, Codex · Studio Mac, \/repos\/codex-feature-old/,
    });
    expect(worktreeOption.getAttribute("data-slot")).toBe("command-item");
    expect(worktreeOption.querySelector('[data-slot="item"]')).not.toBeNull();
    expect(
      Array.from(
        worktreeOption.querySelectorAll(
          '[data-slot="item-title"], [data-slot="item-description"]',
        ),
        (line) => line.textContent?.trim(),
      ),
    ).toEqual([
      "feature/old",
      "Codex · Studio Mac",
      "/repos/codex-feature-old",
    ]);
    fireEvent.click(worktreeOption);
    expect(
      Array.from(
        screen
          .getByRole("combobox", { name: "Select a destination" })
          .querySelectorAll("span.block"),
        (line) => line.textContent?.trim(),
      ),
    ).toEqual([
      "feature/old",
      "Codex · Studio Mac",
      "/repos/codex-feature-old",
    ]);
    expect(await screen.findByText("Add searchable worktrees")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Create and switch branch" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("ChangeTicketWorktree"),
        {
          input: {
            worktreeId: "worktree-1",
            selection: {
              mode: "TICKET",
              ticketKey: "APP-123",
              baseBranch: "develop",
            },
            requestId: expect.any(String),
            stashOnFailure: false,
          },
        },
      ),
    );
    expect(waitForJob).toHaveBeenCalledWith("job-change");
  });

  test("offers to stash and retry when a dirty worktree cannot switch", async () => {
    mockRequests();
    waitForJob
      .mockRejectedValueOnce(new Error("Git switch failed"))
      .mockResolvedValueOnce();
    render(
      <TicketWorktreeDialog issueKey="APP-123" onOpenChange={vi.fn()} open />,
    );

    fireEvent.click(
      await screen.findByRole("tab", { name: "Existing worktree" }),
    );
    expect(await screen.findByText("Add searchable worktrees")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Create and switch branch" }),
    );

    expect(await screen.findByText("Git switch failed")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stash and retry" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("ChangeTicketWorktree"),
        expect.objectContaining({
          input: expect.objectContaining({
            worktreeId: "worktree-1",
            stashOnFailure: true,
          }),
        }),
      ),
    );
    expect(waitForJob).toHaveBeenCalledTimes(2);
  });
});
