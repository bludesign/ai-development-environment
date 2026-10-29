import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { CodeReviewersSettings } from "./code-reviewers-settings";
import type { RepositoryCodeReviewers } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const recovery = vi.mocked(onControlPlaneRecovery);

function repository(): RepositoryCodeReviewers {
  return {
    repositoryId: "repo-1",
    provider: "GITLAB",
    ref: "main",
    defaultRef: "main",
    refs: ["main", "release"],
    pools: [
      {
        key: "platform",
        name: "Platform owners",
        kind: "CODEOWNERS",
        candidates: ["ada", "ben"].map((id) => ({
          id,
          username: id,
          name: id.toUpperCase(),
          avatarUrl: null,
          url: null,
        })),
        selectedReviewerIds: ["ada", "removed"],
        unavailableReviewerIds: ["removed"],
      },
    ],
    issues: [],
    discoveryComplete: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  request.mockImplementation(async (query) => {
    if (query.includes("query RepositoryCodeReviewers"))
      return { repositoryCodeReviewers: repository() } as never;
    if (query.includes("mutation SaveRepositoryCodeReviewers"))
      return { saveRepositoryCodeReviewers: repository() } as never;
    throw new Error(`Unexpected query: ${query}`);
  });
});

describe("CodeReviewersSettings", () => {
  test("saves preferred people per group and allows removing unavailable saved reviewers", async () => {
    render(<CodeReviewersSettings repositoryId="repo-1" />);
    const ben = await screen.findByRole("checkbox", {
      name: "Choose ben for Platform owners",
    });
    fireEvent.click(ben);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Remove unavailable reviewer removed",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save reviewers" }));
    expect(
      await screen.findByText("Reviewer preferences saved."),
    ).toBeDefined();
    const mutation = request.mock.calls.find(([query]) =>
      query.includes("mutation SaveRepositoryCodeReviewers"),
    );
    expect(mutation?.[1]).toEqual({
      input: {
        repositoryId: "repo-1",
        ref: "main",
        pools: [{ key: "platform", reviewerIds: ["ada", "ben"] }],
      },
    });
  });

  test("filters members and preserves unsaved selections when refreshing discovery", async () => {
    render(<CodeReviewersSettings repositoryId="repo-1" />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Choose ben for Platform owners",
      }),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search people…" }),
      { target: { value: "ben" } },
    );
    const group = screen.getByRole("region", { name: "Platform owners" });
    expect(within(group).queryByText("ADA")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh groups" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "Choose ben for Platform owners" })
          .getAttribute("data-state"),
      ).toBe("checked"),
    );
    expect(request.mock.calls[1]?.[1]).toEqual({
      repositoryId: "repo-1",
      ref: null,
      refresh: true,
    });
  });

  test("retains edited pools after save fails and displays provider discovery issues", async () => {
    request.mockResolvedValueOnce({
      repositoryCodeReviewers: {
        ...repository(),
        discoveryComplete: false,
        issues: ["Team membership cannot be read"],
      },
    } as never);
    render(<CodeReviewersSettings repositoryId="repo-1" />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Choose ben for Platform owners",
      }),
    );
    expect(screen.getByText("Team membership cannot be read")).toBeDefined();
    request.mockRejectedValueOnce(new Error("Provider unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Save reviewers" }));
    expect(await screen.findByText("Provider unavailable")).toBeDefined();
    expect(
      screen
        .getByRole("checkbox", { name: "Choose ben for Platform owners" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });

  test("refreshes after recovery and repository changes while preserving only edited pools", async () => {
    let recover!: () => void;
    let notify!: (repositoryId: string) => void;
    recovery.mockImplementation((callback) => {
      recover = callback;
      return vi.fn();
    });
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (_: unknown, sink: { next: (value: unknown) => void }) => {
          notify = (repositoryId: string) =>
            sink.next({ data: { codebaseOverviewChanged: { repositoryId } } });
          return vi.fn();
        },
      ),
    } as never);
    render(<CodeReviewersSettings repositoryId="repo-1" />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Choose ben for Platform owners",
      }),
    );
    const next = repository();
    next.pools[0]!.selectedReviewerIds = [];
    next.pools.push({
      ...next.pools[0]!,
      key: "security",
      name: "Security",
      selectedReviewerIds: ["ben"],
    });
    request.mockResolvedValue({ repositoryCodeReviewers: next } as never);
    recover();
    expect(
      await screen.findByRole("checkbox", { name: "Choose ben for Security" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("checkbox", { name: "Choose ben for Platform owners" })
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen
        .getByRole("checkbox", { name: "Choose ben for Security" })
        .getAttribute("data-state"),
    ).toBe("checked");
    request.mockClear();
    notify("different-repo");
    expect(request).not.toHaveBeenCalled();
    next.pools[1]!.selectedReviewerIds = [];
    notify("repo-1");
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "Choose ben for Security" })
          .getAttribute("data-state"),
      ).toBe("unchecked"),
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Choose ben for Platform owners" })
        .getAttribute("data-state"),
    ).toBe("checked");
  });
});
