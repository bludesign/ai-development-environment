import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { JobMonitor } from "./job-monitor";
import type { AgentJob } from "./types";
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(() => ({
    subscribe: vi.fn(() => () => undefined),
  })),
  onControlPlaneRecovery: vi.fn(() => () => undefined),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("uses parent metadata, keeps stable subscriptions and recovers missing log sequences", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  const seed = {
    id: "job-1",
    agentId: "agent-1",
    kind: "INSPECT",
    status: "RUNNING",
    error: null,
  } as AgentJob;
  const logs = (from: number, through: number) =>
    Array.from({ length: through - from + 1 }, (_, index) => ({
      id: String(from + index),
      sequence: from + index,
      message: `Log ${from + index}`,
      stream: "STDOUT",
      createdAt: new Date(0).toISOString(),
      jobId: seed.id,
    }));
  request
    .mockResolvedValueOnce({
      agentJobLogs: logs(300, 500).filter((log) => log.sequence !== 450),
    })
    .mockResolvedValueOnce({ agentJobLogs: logs(450, 450) });
  const view = render(<JobMonitor jobId={seed.id} seed={seed} />);
  await screen.findByText("Log 500");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toMatchObject({
    metadata: false,
    first: 200,
    latest: true,
  });
  const subscriptionCount = vi.mocked(controlPlaneSubscriptions).mock.calls
    .length;
  view.rerender(
    <JobMonitor jobId={seed.id} seed={{ ...seed, status: "SUCCEEDED" }} />,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(controlPlaneSubscriptions).mock.calls).toHaveLength(
    subscriptionCount,
  );
  await act(async () => {
    vi.mocked(onControlPlaneRecovery).mock.calls[0][0]();
  });
  await screen.findByText("Log 450");
  expect(request.mock.calls[1][1]).toMatchObject({
    metadata: false,
    knownRanges: [
      { fromSequence: 300, throughSequence: 449 },
      { fromSequence: 451, throughSequence: 500 },
    ],
  });
  expect(screen.getAllByText("Log 500")).toHaveLength(1);
});
