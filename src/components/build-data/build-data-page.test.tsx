import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import {
  ActiveAgentProvider,
  activeAgentStorageKey,
  useActiveAgent,
} from "@/components/active-agent/active-agent-provider";

import { BuildDataPage } from "./build-data-page";

vi.mock("@/lib/control-plane-client", () => ({
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const agent = {
  id: "agent-1",
  name: "Builder",
  hostname: "builder.local",
  version: "0.1.0",
  osVersion: "macOS",
  architecture: "arm64",
  capabilities: ["buildData.scan", "buildData.size", "buildData.delete"],
  baseRepoDirectory: "/Repos",
  derivedDataLocationMode: "DEFAULT",
  derivedDataPath: null,
  connectionStatus: "ONLINE",
  ipAddress: null,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date(0).toISOString(),
};

function collection(operation: "IDLE" | "SIZING" | "DELETING" = "IDLE") {
  return {
    id: "collection-1",
    status: "COMPLETED",
    createdAt: new Date(0).toISOString(),
    deadlineAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    progress: {
      eligibleCount: 1,
      finishedCount: 1,
      successfulCount: 1,
      agents: [
        {
          agent,
          status: "SUCCEEDED",
          jobId: "scan-1",
          error: null,
          warnings: [],
        },
      ],
    },
    entries: [
      {
        id: "entry-1",
        name: "App-hash",
        kind: "PROJECT",
        status: "READY",
        workspacePath: "/Repos/App/App.xcodeproj",
        worktreeId: "worktree-1",
        worktreePath: "App",
        sizeBytes: null,
        operation,
        error: null,
        locked: false,
        agent,
      },
      {
        id: "entry-2",
        name: "Starting-hash",
        kind: "PENDING",
        status: "PENDING",
        workspacePath: null,
        worktreeId: null,
        worktreePath: null,
        sizeBytes: null,
        operation: "IDLE",
        error: null,
        locked: true,
        agent,
      },
      {
        id: "entry-3",
        name: "iOS 26.0",
        kind: "DEVICE_SUPPORT",
        status: "READY",
        workspacePath: null,
        worktreeId: null,
        worktreePath: null,
        sizeBytes: null,
        operation: "IDLE",
        error: null,
        locked: false,
        agent,
      },
    ],
  };
}

function SelectOtherAgent() {
  const { selectAgent } = useActiveAgent();
  return (
    <button onClick={() => selectAgent("other-agent")} type="button">
      Make other agent active
    </button>
  );
}

describe("BuildDataPage", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      releasePointerCapture: { configurable: true, value: () => undefined },
      setPointerCapture: { configurable: true, value: () => undefined },
    });
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("DerivedDataDeletionHistory")) {
        return {
          derivedDataDeletionHistory: { items: [], nextCursor: null },
        } as never;
      }
      if (operation.includes("calculateDerivedDataSizes")) {
        return { calculateDerivedDataSizes: collection("SIZING") } as never;
      }
      if (operation.includes("deleteDerivedDataEntries")) {
        return { deleteDerivedDataEntries: collection("DELETING") } as never;
      }
      if (operation.includes("refreshDerivedData")) {
        return { refreshDerivedData: collection() } as never;
      }
      if (operation.includes("query DerivedDataCollection")) {
        return { derivedDataCollection: collection() } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem(activeAgentStorageKey("build-data-scope-test"));
    vi.useRealTimers();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("follows the active agent for scans, history, and operations while dropping stale results", async () => {
    const other = { ...agent, id: "other-agent", name: "Other Mac" };
    const snapshot = collection();
    const scoped = {
      ...snapshot,
      id: "other-collection",
      progress: {
        ...snapshot.progress,
        agents: [{ ...snapshot.progress.agents[0], agent: other }],
      },
      entries: [
        {
          ...snapshot.entries[2],
          id: "apple-tv-support",
          name: "Apple TV symbols",
          agent: other,
          deviceSupportPlatform: "tvOS",
        },
      ],
    };
    let finishOriginal!: (value: {
      refreshDerivedData: typeof snapshot;
    }) => void;
    const original = new Promise<{ refreshDerivedData: typeof snapshot }>(
      (resolve) => {
        finishOriginal = resolve;
      },
    );
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (query, variables, options) => {
      if (String(query).includes("query ActiveAgentOptions"))
        return { agents: [agent, other] } as never;
      if (String(query).includes("mutation RefreshDerivedData")) {
        if (variables?.agentId === other.id)
          return { refreshDerivedData: scoped } as never;
        return original as never;
      }
      if (String(query).includes("mutation ClearDerivedDataDeletionHistory"))
        return { clearDerivedDataDeletionHistory: 1 } as never;
      if (
        String(query).includes("query DerivedDataDeletionHistory") &&
        variables?.agentId === other.id
      ) {
        return {
          derivedDataDeletionHistory: {
            items: [
              {
                id: "deleted-other",
                agentId: other.id,
                agentName: other.name,
                folderName: "Other deleted folder",
                worktreeId: null,
                worktreePath: null,
                source: "USER",
                entryKind: "PROJECT",
                deletedAt: new Date(0).toISOString(),
              },
            ],
            nextCursor: null,
          },
        } as never;
      }
      if (String(query).includes("mutation BuildDataOperation"))
        return { calculateDerivedDataSizes: scoped } as never;
      return fallback(query, variables, options);
    });
    localStorage.setItem(
      activeAgentStorageKey("build-data-scope-test"),
      JSON.stringify({
        activeAgentId: null,
        pageAgents: { "build-data": agent.id },
      }),
    );
    render(
      <ActiveAgentProvider userId="build-data-scope-test">
        <SelectOtherAgent />
        <BuildDataPage />
      </ActiveAgentProvider>,
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RefreshDerivedData"),
        expect.objectContaining({ agentId: agent.id }),
        expect.anything(),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Make other agent active" }),
    );
    await screen.findByText("Apple TV symbols");
    expect(screen.getByText("tvOS")).toBeTruthy();
    await screen.findByText("Other deleted folder");
    await act(async () => finishOriginal({ refreshDerivedData: snapshot }));
    expect(screen.queryByText("App-hash")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Manage simulators" })
        .getAttribute("href"),
    ).toBe("/system/simulators");
    fireEvent.click(screen.getByRole("button", { name: "Calculate sizes" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation BuildDataOperation"),
        expect.objectContaining({
          collectionId: scoped.id,
          entryIds: ["apple-tv-support"],
        }),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Clear history",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation ClearDerivedDataDeletionHistory"),
        { agentId: other.id },
        expect.anything(),
      ),
    );
  });

  test.each(["IDLE", "SIZING", "DELETING"] as const)(
    "polls only outstanding collection work (%s) and stops after the final snapshot",
    async (operation) => {
      vi.useFakeTimers();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (query, ...args) => {
        if (String(query).includes("refreshDerivedData"))
          return { refreshDerivedData: collection(operation) } as never;
        if (String(query).includes("query DerivedDataCollection"))
          return { derivedDataCollection: collection(operation) } as never;
        return original(query, ...args);
      });
      let publish: ((value: unknown) => void) | undefined;
      subscriptions.mockReturnValue({
        subscribe: (
          payload: { query: string },
          sink: { next: (value: unknown) => void },
        ) => {
          if (
            payload.query.includes("subscription DerivedDataCollectionChanged")
          )
            publish = sink.next;
          return vi.fn();
        },
      } as never);
      render(<BuildDataPage />);
      await act(() => vi.advanceTimersByTimeAsync(10));
      request.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(6500));
      const polls = () =>
        request.mock.calls.filter(([query]) =>
          String(query).includes("query DerivedDataCollection"),
        );
      expect(polls()).toHaveLength(operation === "IDLE" ? 0 : 3);
      await act(async () =>
        publish?.({ data: { derivedDataCollectionChanged: collection() } }),
      );
      request.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(4500));
      expect(polls()).toHaveLength(0);
    },
  );

  test("a late start response cannot restart polling after a completed subscription snapshot", async () => {
    vi.useFakeTimers();
    const original = request.getMockImplementation()!;
    let finishStart: ((value: unknown) => void) | undefined;
    request.mockImplementation((query, ...args) =>
      String(query).includes("refreshDerivedData")
        ? (new Promise((resolve) => {
            finishStart = resolve;
          }) as never)
        : original(query, ...args),
    );
    let publish: ((value: unknown) => void) | undefined;
    subscriptions.mockReturnValue({
      subscribe: (
        payload: { query: string },
        sink: { next: (value: unknown) => void },
      ) => {
        if (payload.query.includes("subscription DerivedDataCollectionChanged"))
          publish = sink.next;
        return vi.fn();
      },
    } as never);
    render(<BuildDataPage />);
    await act(async () =>
      publish?.({ data: { derivedDataCollectionChanged: collection() } }),
    );
    await act(async () =>
      finishStart?.({
        refreshDerivedData: { ...collection(), status: "COLLECTING" },
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(6500));
    expect(
      request.mock.calls.filter(([query]) =>
        String(query).includes("query DerivedDataCollection"),
      ),
    ).toHaveLength(0);
    expect(screen.getByText("App-hash")).toBeTruthy();
  });

  test("scans on load, links matched worktrees, and calculates sizes on demand", async () => {
    render(<BuildDataPage />);

    expect(await screen.findByText("App-hash")).toBeDefined();
    expect(screen.getByRole("link", { name: "App" }).getAttribute("href")).toBe(
      "/dashboard/worktrees/worktree-1",
    );
    expect(screen.getByText("Build starting")).toBeDefined();
    for (const agentLink of screen.getAllByRole("link", { name: "Builder" })) {
      expect(agentLink.className).toContain("hover:bg-muted");
    }
    expect(screen.getByText("Locked").getAttribute("data-variant")).toBe(
      "success",
    );

    fireEvent.click(screen.getByRole("button", { name: "Calculate sizes" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("calculateDerivedDataSizes"),
        ),
      ).toBe(true),
    );
  });

  test("requires inline confirmation before deleting a row", async () => {
    render(<BuildDataPage />);
    await screen.findByText("App-hash");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for App-hash" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    expect(screen.getByRole("menu").className).toContain("w-48");
    expect(
      screen.getByRole("menuitem", { name: "Lock from cleanup" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = screen.getByRole("menuitem", { name: "Confirm" });
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("deleteDerivedDataEntries"),
      ),
    ).toBe(false);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Confirm" })).toBeNull(),
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for App-hash" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const reopenedConfirm = screen.getByRole("menuitem", { name: "Confirm" });

    fireEvent.click(reopenedConfirm);
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("deleteDerivedDataEntries"),
        ),
      ).toBe(true),
    );
  });

  test("uses the same inline confirmation for bulk deletion", async () => {
    render(<BuildDataPage />);
    await screen.findByText("App-hash");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select App-hash" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("deleteDerivedDataEntries"),
      ),
    ).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("deleteDerivedDataEntries"),
        ),
      ).toBe(true),
    );
  });
});
