import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  recovery: vi.fn(),
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: mocks.request,
  controlPlaneSubscriptions: () => ({ subscribe: mocks.subscribe }),
  onControlPlaneRecovery: mocks.recovery,
}));
import {
  createCommandTargetSummaryStore,
  type CommandTarget,
} from "./command-target-summaries";

const target = (resourceId: string): CommandTarget => ({
  resourceKind: "AGENT",
  resourceId,
});
const action = {
  id: "command",
  name: "Test",
  description: "",
  targetKind: "ANY_AGENT_HOME",
  quickActionEnabled: true,
  quickActionIconKey: "terminal",
  quickActionButtonVariant: "default",
};
const response = (targets: CommandTarget[], commands = [action]) => ({
  commandTargetSummaries: targets.map((entry) => ({
    ...entry,
    commands,
    activeRuns: [],
    recentRuns: [],
  })),
});
type Sink = { next: (value: unknown) => void };
let listeners: Array<{
  query: string;
  variables?: { id: string };
  sink: Sink;
  dispose: ReturnType<typeof vi.fn>;
}>;
let recover: () => void;
let stopRecovery: ReturnType<typeof vi.fn>;
let cleanups: Array<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.request.mockReset();
  mocks.subscribe.mockReset();
  mocks.recovery.mockReset();
  listeners = [];
  cleanups = [];
  stopRecovery = vi.fn();
  mocks.subscribe.mockImplementation((operation, sink) => {
    const dispose = vi.fn();
    listeners.push({ ...operation, sink, dispose });
    return dispose;
  });
  mocks.recovery.mockImplementation((listener) => {
    recover = listener;
    return stopRecovery;
  });
  mocks.request.mockImplementation(async (_query, variables) =>
    response(variables.targets),
  );
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.useRealTimers();
});
const tick = () => vi.advanceTimersByTimeAsync(1);
const watch = (
  store: ReturnType<typeof createCommandTargetSummaryStore>,
  id: string,
  options = {},
) => {
  const unsubscribe = store.subscribe(target(id), options, vi.fn());
  cleanups.push(unsubscribe);
  return unsubscribe;
};
const event = (id: string) =>
  listeners
    .findLast(
      (listener) =>
        listener.variables?.id === id && !listener.dispose.mock.calls.length,
    )!
    .sink.next({ data: { commandRunsChanged: { id: "run" } } });

describe("command target summary ownership", () => {
  test("four rendered cards plus a same-target panel produce one compact batch", async () => {
    const store = createCommandTargetSummaryStore();
    for (const id of ["a", "b", "c", "d"]) watch(store, id);
    watch(store, "a", { includeAllCommands: true, includeRecentRuns: true });
    await tick();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][1]).toEqual({
      targets: [
        { ...target("a"), includeAllCommands: true, includeRecentRuns: true },
        ...["b", "c", "d"].map((id) => ({
          ...target(id),
          includeAllCommands: false,
          includeRecentRuns: false,
        })),
      ],
    });
    expect(mocks.request.mock.calls[0][0]).not.toMatch(
      /eligibleCommandsFor|commandRuns\(|snapshotScript|attempts/,
    );
    expect(listeners).toHaveLength(5); // one definition and four target listeners
    expect(mocks.recovery).toHaveBeenCalledTimes(1);
    expect(store.snapshot(target("a")).commands).toEqual([action]);
  });

  test("unmount before dispatch prevents work and disposes last-consumer listeners", async () => {
    const store = createCommandTargetSummaryStore();
    const unsubscribe = watch(store, "a");
    unsubscribe();
    cleanups = [];
    await tick();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(
      listeners.every((listener) => listener.dispose.mock.calls.length === 1),
    ).toBe(true);
    expect(stopRecovery).toHaveBeenCalledOnce();
  });

  test("a departed consumer cannot abort another target's shared batch or restore stale state", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const store = createCommandTargetSummaryStore();
    const stopA = watch(store, "a");
    watch(store, "b");
    await tick();
    const signal = mocks.request.mock.calls[0][2].signal;
    stopA();
    expect(signal.aborted).toBe(false);
    resolve(response([target("a"), target("b")]));
    await tick();
    expect(store.snapshot(target("a")).loaded).toBe(false);
    expect(store.snapshot(target("b")).loaded).toBe(true);
    watch(store, "a");
    await tick();
    expect(mocks.request.mock.calls[1][1].targets).toHaveLength(1);
    expect(mocks.request.mock.calls[1][1].targets[0].resourceId).toBe("a");
  });

  test("all consumers departing aborts their batch", async () => {
    mocks.request.mockImplementationOnce(() => new Promise(() => undefined));
    const store = createCommandTargetSummaryStore();
    const stop = watch(store, "a");
    await tick();
    stop();
    expect(mocks.request.mock.calls[0][2].signal.aborted).toBe(true);
  });

  test("an event burst during a request produces one trailing refresh for that target", async () => {
    const store = createCommandTargetSummaryStore();
    watch(store, "a");
    watch(store, "b");
    await tick();
    let resolve: (value: unknown) => void = () => undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    event("a");
    await tick();
    event("a");
    event("a");
    await tick();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    resolve(response([target("a")]));
    await tick();
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(
      mocks.request.mock.calls
        .slice(1)
        .every(
          (call) =>
            call[1].targets.length === 1 &&
            call[1].targets[0].resourceId === "a",
        ),
    ).toBe(true);
    expect(listeners).toHaveLength(3);
  });

  test("empty quick-action targets stop watching runs while definitions can make them eligible", async () => {
    mocks.request.mockImplementationOnce(async (_query, variables) =>
      response(variables.targets, []),
    );
    const store = createCommandTargetSummaryStore();
    watch(store, "a");
    await tick();
    expect(
      listeners.find((listener) => listener.variables?.id === "a")?.dispose,
    ).toHaveBeenCalledOnce();
    listeners[0].sink.next({ data: { commandsChanged: { id: "new" } } });
    await tick();
    expect(store.snapshot(target("a")).commands).toEqual([action]);
    expect(
      listeners.filter(
        (listener) =>
          listener.variables?.id === "a" && !listener.dispose.mock.calls.length,
      ),
    ).toHaveLength(1);
  });

  test("reconnect and subscription recovery reconcile mounted targets in one batch", async () => {
    const store = createCommandTargetSummaryStore();
    watch(store, "a");
    watch(store, "b");
    await tick();
    recover();
    await tick();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1][1].targets).toHaveLength(2);
    expect(listeners).toHaveLength(3);
  });

  test("a failed refresh retains data and recovery clears the error", async () => {
    const store = createCommandTargetSummaryStore();
    watch(store, "a");
    await tick();
    mocks.request.mockRejectedValueOnce(new Error("Unavailable"));
    event("a");
    await tick();
    expect(store.snapshot(target("a")).commands).toEqual([action]);
    expect(store.snapshot(target("a")).error).toBe("Unavailable");
    recover();
    await tick();
    expect(store.snapshot(target("a")).error).toBeNull();
  });
});
