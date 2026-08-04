import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: mocks.controlPlaneSubscriptions,
}));

import { subscribeToAppSummaryChanges } from "./app-summary-subscriptions";

describe("subscribeToAppSummaryChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribe.mockImplementation(() => vi.fn());
    mocks.controlPlaneSubscriptions.mockReturnValue({
      subscribe: mocks.subscribe,
    });
  });

  test("refreshes summaries for app, checkout, worktree, run, and build changes", () => {
    const onChange = vi.fn();
    subscribeToAppSummaryChanges(onChange);

    expect(mocks.subscribe).toHaveBeenCalledTimes(5);
    expect(
      mocks.subscribe.mock.calls.map(([request]) => request.query),
    ).toEqual([
      expect.stringContaining("appsChanged"),
      expect.stringContaining("codebaseOverviewChanged"),
      expect.stringContaining("worktreeOverviewChanged"),
      expect.stringContaining("agentRunsChanged"),
      expect.stringContaining("buildsChanged"),
    ]);

    for (const [, sink] of mocks.subscribe.mock.calls) sink.next();
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  test("unsubscribes from every summary source", () => {
    const unsubscribers = Array.from({ length: 5 }, () => vi.fn());
    mocks.subscribe.mockImplementation(() => unsubscribers.shift());
    const remaining = [...unsubscribers];

    const unsubscribe = subscribeToAppSummaryChanges(vi.fn());
    unsubscribe();

    for (const cleanup of remaining) expect(cleanup).toHaveBeenCalledOnce();
  });
});
