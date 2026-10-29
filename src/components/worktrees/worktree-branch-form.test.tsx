import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { WorktreeBranchForm } from "./worktree-branch-form";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const target = {
  codebaseId: "codebase-1",
  defaultBranch: "main",
  currentBranch: null,
  currentBaseBranch: null,
  localBranches: ["main", "feature/local"],
  remoteBranches: ["main", "feature/remote"],
  unavailableBranches: [],
};

afterEach(() => {
  cleanup();
  request.mockReset();
  document.cookie = "worktree-branch-mode=; Max-Age=0; Path=/";
});

describe("WorktreeBranchForm", () => {
  test("remembers the selected tab in a shared cookie", () => {
    render(
      <WorktreeBranchForm
        busy={false}
        onSubmit={vi.fn()}
        submitLabel="Create worktree"
        target={target}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
    expect(document.cookie).toContain("worktree-branch-mode=TICKET");
  });

  test("fetches and displays a ticket branch preview", async () => {
    request.mockResolvedValue({
      worktreeTicketBranchContext: {
        ticketKey: "APP-123",
        ticketTitle: "Add search",
        ticketType: "Story",
        projectKey: "APP",
        branchNamingMode: "JAVASCRIPT",
        branchName: "feature/APP-123-add-search",
      },
    } as never);
    render(
      <WorktreeBranchForm
        busy={false}
        onSubmit={vi.fn()}
        submitLabel="Create worktree"
        target={target}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
    fireEvent.change(screen.getByLabelText("Ticket key"), {
      target: { value: "app-123" },
    });
    const previewTitle = await screen.findByText(
      "Add search",
      {},
      { timeout: 2_000 },
    );
    expect(previewTitle.closest('[data-slot="item"]')).not.toBeNull();
    expect(screen.getByText("feature/APP-123-add-search")).toBeDefined();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("WorktreeTicketBranchContext"),
      {
        input: {
          codebaseId: "codebase-1",
          worktreeId: null,
          ticketKey: "APP-123",
        },
      },
    );
  });

  test("parses a Jira URL for the ticket branch preview and submission", async () => {
    request.mockResolvedValue({
      worktreeTicketBranchContext: {
        ticketKey: "APP-123",
        ticketTitle: "Add search",
        ticketType: "Story",
        projectKey: "APP",
        branchNamingMode: "JAVASCRIPT",
        branchName: "feature/APP-123-add-search",
      },
    } as never);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WorktreeBranchForm
        busy={false}
        onSubmit={onSubmit}
        submitLabel="Change branch"
        target={target}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
    fireEvent.change(screen.getByLabelText("Ticket key"), {
      target: {
        value: "https://example.atlassian.net/browse/app-123?atlOrigin=abc",
      },
    });

    await screen.findByText("Add search", {}, { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Change branch" }));

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("WorktreeTicketBranchContext"),
      {
        input: {
          codebaseId: "codebase-1",
          worktreeId: null,
          ticketKey: "APP-123",
        },
      },
    );
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "TICKET",
      baseBranch: "main",
      ticketKey: "APP-123",
    });
  });
});

const aiPreview = {
  ticketKey: "APP-123",
  ticketTitle: "Add search",
  ticketType: "Story",
  projectKey: "APP",
  branchNamingMode: "AI",
  branchName: null,
};

test("AI ticket lookup does not generate and supports submitting without a preview", async () => {
  request.mockResolvedValue({
    worktreeTicketBranchContext: aiPreview,
  } as never);
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <WorktreeBranchForm
      target={target}
      busy={false}
      fixedTicketKey="APP-123"
      submitLabel="Create worktree"
      onSubmit={onSubmit}
    />,
  );
  await screen.findByText("Add search");
  expect(request).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Generate branch name" }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  expect(onSubmit).toHaveBeenCalledWith({
    mode: "TICKET",
    ticketKey: "APP-123",
    baseBranch: "main",
  });
});

test("generates once, accepts an edit, and reuses it on submit", async () => {
  request.mockImplementation(async (query) => {
    if (query.includes("mutation GenerateWorktreeTicketBranch"))
      return { generateWorktreeTicketBranch: { id: "job-1" } } as never;
    if (query.includes("query TicketBranchJob"))
      return {
        agentJob: {
          status: "SUCCEEDED",
          worktreeTicketBranchResult: { branchName: "feature/APP-123-search" },
        },
      } as never;
    return { worktreeTicketBranchContext: aiPreview } as never;
  });
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <WorktreeBranchForm
      target={target}
      busy={false}
      fixedTicketKey="APP-123"
      submitLabel="Change branch"
      onSubmit={onSubmit}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate branch name" }),
  );
  const input = screen.getByLabelText("Branch name");
  await waitFor(() =>
    expect((input as HTMLInputElement).value).toBe("feature/APP-123-search"),
  );
  fireEvent.change(input, { target: { value: "feature/APP-123-custom" } });
  fireEvent.click(screen.getByRole("button", { name: "Change branch" }));
  expect(onSubmit).toHaveBeenCalledWith({
    mode: "TICKET",
    ticketKey: "APP-123",
    baseBranch: "main",
    branchName: "feature/APP-123-custom",
  });
  expect(
    request.mock.calls.filter(([query]) =>
      query.includes("mutation GenerateWorktreeTicketBranch"),
    ),
  ).toHaveLength(1);
});

test("keeps generation failures visible and allows retry without submitting Git changes", async () => {
  request.mockImplementation(async (query) => {
    if (query.includes("mutation GenerateWorktreeTicketBranch"))
      throw new Error("Model unavailable");
    return { worktreeTicketBranchContext: aiPreview } as never;
  });
  const onSubmit = vi.fn();
  render(
    <WorktreeBranchForm
      target={target}
      busy={false}
      fixedTicketKey="APP-123"
      submitLabel="Create worktree"
      onSubmit={onSubmit}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate branch name" }),
  );
  expect(await screen.findByText("Model unavailable")).toBeDefined();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("button", { name: "Generate branch name" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("ignores an old ticket response after changing the target", async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  request.mockImplementation(async (_query, variables) => {
    if (
      (variables as { input: { codebaseId: string } }).input.codebaseId ===
      "codebase-1"
    )
      return (await new Promise<unknown>((resolve) => {
        resolveOld = resolve;
      })) as never;
    return {
      worktreeTicketBranchContext: {
        ...aiPreview,
        ticketTitle: "Current target ticket",
      },
    } as never;
  });
  const { rerender } = render(
    <WorktreeBranchForm
      target={target}
      busy={false}
      fixedTicketKey="APP-123"
      submitLabel="Create worktree"
      onSubmit={vi.fn()}
    />,
  );
  await waitFor(() => expect(resolveOld).toBeDefined());
  rerender(
    <WorktreeBranchForm
      target={{ ...target, codebaseId: "codebase-2" }}
      busy={false}
      fixedTicketKey="APP-123"
      submitLabel="Create worktree"
      onSubmit={vi.fn()}
    />,
  );
  await screen.findByText("Current target ticket");
  resolveOld!({ worktreeTicketBranchContext: aiPreview });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Add search")).toBeNull();
});
