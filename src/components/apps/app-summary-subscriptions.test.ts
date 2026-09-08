import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: mocks.controlPlaneSubscriptions,
  onControlPlaneRecovery: vi.fn(() => () => undefined),
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

  test("refreshes summaries for app, checkout, worktree, run, and build changes", async () => {
    const onChange = vi.fn();
    subscribeToAppSummaryChanges(onChange);

    expect(mocks.subscribe).toHaveBeenCalledTimes(5);
    expect(
      mocks.subscribe.mock.calls.map(([request]) => request.query),
    ).toEqual([
      expect.stringContaining("appsChanged"),
      expect.stringContaining("codebaseOverviewChanged"),
      expect.stringContaining("worktreeOverviewChanged"),
      expect.stringContaining("agentRunListChanged"),
      expect.stringContaining("buildsChanged"),
    ]);

    for (const [, sink] of mocks.subscribe.mock.calls) sink.next();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("unsubscribes from every summary source", () => {
    const unsubscribers = Array.from({ length: 5 }, () => vi.fn());
    mocks.subscribe.mockImplementation(() => unsubscribers.shift());
    const remaining = [...unsubscribers];

    const unsubscribe = subscribeToAppSummaryChanges(vi.fn());
    unsubscribe.dispose();

    for (const cleanup of remaining) expect(cleanup).toHaveBeenCalledOnce();
  });
});
