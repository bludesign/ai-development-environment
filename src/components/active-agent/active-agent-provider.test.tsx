import {
  act,
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
import {
  ActiveAgentProvider,
  activeAgentStorageKey,
  parseActiveAgentPreferences,
  useActiveAgent,
  usePageAgentFilter,
} from "./active-agent-provider";
import { ActiveAgentSelector } from "./active-agent-selector";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const agents = [
  { id: "a", name: "Agent A", hostname: "a.local", connectionStatus: "ONLINE" },
  {
    id: "b",
    name: "Agent B",
    hostname: "b.local",
    connectionStatus: "OFFLINE",
  },
];

function Page({ page = "usage" }: { page?: string }) {
  const focus = useActiveAgent();
  const [baseline, setBaseline] = usePageAgentFilter(page, "all");
  return (
    <>
      <output aria-label="effective">
        {focus.ready ? (focus.activeAgentId ?? baseline) : "loading"}
      </output>
      <output aria-label="baseline">{baseline}</output>
      <output aria-label="catalog-size">{focus.agents.length}</output>
      <button onClick={() => setBaseline("a")}>Local A</button>
      <button onClick={() => focus.selectAgent("a")}>Focus A</button>
      <button onClick={() => focus.selectAgent("b")}>Focus B</button>
      <button onClick={() => focus.selectAgent(null)}>Clear focus</button>
      <button onClick={focus.refresh}>Refresh catalog</button>
      {focus.error && <p role="alert">{focus.error}</p>}
      <ActiveAgentSelector />
    </>
  );
}

const surface = (userId = "user", page = "usage") => (
  <ActiveAgentProvider userId={userId}>
    <Page page={page} />
  </ActiveAgentProvider>
);

describe("active agent", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(controlPlaneRequest).mockReset().mockResolvedValue({ agents });
    Element.prototype.scrollIntoView = vi.fn();
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("overrides without overwriting separate page baselines and restores after remount", async () => {
    const view = render(surface());
    await screen.findByRole("combobox", { name: "Active agent: None" });
    fireEvent.click(screen.getByText("Local A"));
    fireEvent.click(screen.getByText("Focus B"));
    expect(screen.getByLabelText("effective").textContent).toBe("b");
    expect(screen.getByLabelText("baseline").textContent).toBe("a");
    view.rerender(surface("user", "worktrees:app"));
    expect(screen.getByLabelText("effective").textContent).toBe("b");
    expect(screen.getByLabelText("baseline").textContent).toBe("all");
    view.unmount();
    render(surface());
    expect(screen.getByLabelText("effective").textContent).toBe("b");
    fireEvent.click(screen.getByText("Focus A"));
    fireEvent.click(screen.getByText("Clear focus"));
    expect(screen.getByLabelText("effective").textContent).toBe("a");
  });

  test("shows the selector only when multiple agents are available", async () => {
    vi.mocked(controlPlaneRequest).mockResolvedValue({ agents: [agents[0]] });
    render(surface());
    await waitFor(() =>
      expect(screen.getByLabelText("catalog-size").textContent).toBe("1"),
    );
    expect(screen.queryByRole("combobox", { name: /Active agent/ })).toBeNull();
  });

  test("isolates accounts and synchronizes storage events only for the current user", async () => {
    const view = render(surface());
    await waitFor(() =>
      expect(vi.mocked(controlPlaneRequest)).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByText("Focus B"));
    view.rerender(surface("another"));
    expect(screen.getByLabelText("effective").textContent).toBe("all");
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: activeAgentStorageKey("user"),
          newValue: JSON.stringify({ activeAgentId: "a" }),
        }),
      ),
    );
    expect(screen.getByLabelText("effective").textContent).toBe("all");
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: activeAgentStorageKey("another"),
          newValue: JSON.stringify({
            activeAgentId: "b",
            pageAgents: { usage: "a" },
          }),
        }),
      ),
    );
    expect(screen.getByLabelText("effective").textContent).toBe("b");
    fireEvent.click(screen.getByText("Clear focus"));
    expect(screen.getByLabelText("effective").textContent).toBe("a");
  });

  test("retains offline agents and failed reads, clearing only after confirmed deletion", async () => {
    render(surface());
    await screen.findByRole("combobox", { name: "Active agent: None" });
    fireEvent.click(screen.getByText("Focus B"));
    await screen.findByRole("combobox", { name: "Active agent: Agent B" });
    vi.mocked(controlPlaneRequest).mockRejectedValueOnce(
      new Error("Disconnected"),
    );
    fireEvent.click(screen.getByText("Refresh catalog"));
    await screen.findByText("Disconnected");
    expect(screen.getByLabelText("effective").textContent).toBe("b");
    vi.mocked(controlPlaneRequest).mockResolvedValue({ agents: [] });
    fireEvent.click(screen.getByText("Refresh catalog"));
    await waitFor(() =>
      expect(screen.getByLabelText("effective").textContent).toBe("all"),
    );
  });

  test("works in memory with blocked storage and tolerates corrupt saved values", async () => {
    expect(parseActiveAgentPreferences("{broken").activeAgentId).toBeNull();
    expect(
      parseActiveAgentPreferences(
        '{"activeAgentId":17,"pageAgents":{"usage":false}}',
      ).pageAgents,
    ).toEqual({});
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    render(surface());
    await screen.findByRole("combobox", { name: "Active agent: None" });
    fireEvent.click(screen.getByText("Local A"));
    fireEvent.click(screen.getByText("Focus B"));
    fireEvent.click(screen.getByText("Clear focus"));
    expect(screen.getByLabelText("effective").textContent).toBe("a");
  });

  test("refreshes on agent events and foreground recovery", async () => {
    const view = render(surface());
    await waitFor(() => expect(controlPlaneRequest).toHaveBeenCalledTimes(1));
    const client = vi
      .mocked(controlPlaneSubscriptions)
      .mock.results.at(-1)!.value;
    const sink = vi.mocked(client.subscribe).mock.calls[0]![1];
    await act(async () => sink.next({ data: { agentChanged: { id: "a" } } }));
    await waitFor(() => expect(controlPlaneRequest).toHaveBeenCalledTimes(2));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(controlPlaneRequest).toHaveBeenCalledTimes(3));
    view.unmount();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(controlPlaneRequest).toHaveBeenCalledTimes(3);
  });
});
