import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GlobalSearch } from "@/components/global-search";
import { controlPlaneRequest } from "@/lib/control-plane-client";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const features = { actionsCache: false, webhooks: false };

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();

function openWithShortcut(modifier: "meta" | "control" = "meta") {
  const event = new KeyboardEvent("keydown", {
    key: "k",
    metaKey: modifier === "meta",
    ctrlKey: modifier === "control",
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    requestMock.mockReset();
    requestMock.mockResolvedValue({ globalSearch: { items: [] } } as never);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  test("opens with Command-K, autofocuses, closes with Escape, and persists page selections", async () => {
    render(<GlobalSearch features={features} />);

    const trigger = screen.getByRole("button", { name: "Open global search" });
    // Container-query widths so the trigger collapses to an icon button when
    // the header is narrow, regardless of how wide the viewport is.
    expect(trigger.className).toContain("w-10");
    expect(trigger.className).toContain("@xl:w-48");
    expect(trigger.className).toContain("@3xl:w-64");

    const shortcutEvent = openWithShortcut();
    expect(shortcutEvent.defaultPrevented).toBe(true);

    const input = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.queryByText("Webhooks")).toBeNull();

    fireEvent.change(input, { target: { value: "Builds" } });
    fireEvent.click(await screen.findByText("Builds"));

    expect(navigation.push).toHaveBeenCalledWith("/builds");
    expect(
      JSON.parse(
        window.localStorage.getItem("aide:global-search:recent:v1") ?? "[]",
      ),
    ).toEqual([expect.objectContaining({ title: "Builds", href: "/builds" })]);

    expect(openWithShortcut("control").defaultPrevented).toBe(true);
    const reopenedInput = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );
    expect(screen.getAllByText("Builds")).toHaveLength(1);
    fireEvent.keyDown(reopenedInput, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText(
          "Search pages, tickets, branches, builds…",
        ),
      ).toBeNull();
    });
  });

  test("debounces dynamic search and reaches nested results with arrow keys and Enter", async () => {
    requestMock.mockResolvedValue({
      globalSearch: {
        items: [
          {
            key: "worktree:worktree-one",
            kind: "WORKTREE",
            group: "WORKTREES",
            title: "feature/AIDE-42-search",
            subtitle: "AIDE",
            href: "/worktrees/worktree-one",
            status: "AVAILABLE",
            updatedAt: "2026-06-01T00:00:00.000Z",
            children: [
              {
                key: "workflow-run:run-one",
                kind: "WORKFLOW_RUN",
                group: "WORKFLOWS",
                title: "Release #19",
                subtitle: null,
                href: "/workflows/runs/run-one",
                status: "SUCCEEDED",
                updatedAt: "2026-06-02T00:00:00.000Z",
                children: [],
              },
            ],
          },
        ],
      },
    } as never);
    render(<GlobalSearch features={features} />);
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );

    fireEvent.change(input, { target: { value: "AIDE-42" } });
    expect(requestMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Release #19")).toBeDefined();
    expect(requestMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigation.push).toHaveBeenCalledWith("/workflows/runs/run-one");
  });

  test("ignores a slower response from an older query", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    requestMock.mockImplementation((_document, variables) => {
      if (variables?.query === "first") return firstResponse as never;
      return Promise.resolve({
        globalSearch: {
          items: [
            {
              key: "agent:second",
              kind: "AGENT",
              group: "AGENTS_JOBS",
              title: "Second Agent",
              subtitle: null,
              href: "/agents/second",
              status: null,
              updatedAt: null,
              children: [],
            },
          ],
        },
      }) as never;
    });
    render(<GlobalSearch features={features} />);
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );

    fireEvent.change(input, { target: { value: "first" } });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "second" } });
    expect(await screen.findByText("Second Agent")).toBeDefined();

    resolveFirst?.({
      globalSearch: {
        items: [
          {
            key: "agent:first",
            kind: "AGENT",
            group: "AGENTS_JOBS",
            title: "First Agent",
            subtitle: null,
            href: "/agents/first",
            status: null,
            updatedAt: null,
            children: [],
          },
        ],
      },
    });
    await Promise.resolve();

    expect(screen.queryByText("First Agent")).toBeNull();
    expect(screen.getByText("Second Agent")).toBeDefined();
  });

  test("shows empty and recoverable service-error states", async () => {
    render(<GlobalSearch features={features} />);
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );

    fireEvent.change(input, { target: { value: "unfindable-resource" } });
    expect(await screen.findByText("No results found.")).toBeDefined();

    requestMock.mockRejectedValueOnce(new Error("search unavailable"));
    fireEvent.change(input, { target: { value: "server-failure" } });
    expect(
      await screen.findByText(
        "Saved resources could not be searched. Page shortcuts are still available.",
      ),
    ).toBeDefined();
  });

  test("includes gated page destinations only when their features are enabled", async () => {
    render(<GlobalSearch features={{ actionsCache: true, webhooks: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open global search" }));
    const input = await screen.findByPlaceholderText(
      "Search pages, tickets, branches, builds…",
    );

    fireEvent.change(input, { target: { value: "Webhooks" } });
    expect(await screen.findByText("Webhooks")).toBeDefined();
    fireEvent.change(input, { target: { value: "Actions Cache" } });
    expect(await screen.findByText("Actions Cache")).toBeDefined();
  });
});
