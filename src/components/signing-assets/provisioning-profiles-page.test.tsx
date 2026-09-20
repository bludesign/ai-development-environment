import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { ProvisioningProfilesPage } from "./provisioning-profiles-page";
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
  onControlPlaneRecovery: () => () => undefined,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useRouter: () => ({ refresh: vi.fn() }),
}));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const inventory = {
  signingAgents: [
    { id: "agent-a", name: "Agent A", hostname: "a.local", supported: true },
    { id: "agent-b", name: "Agent B", hostname: "b.local", supported: true },
  ],
  signingProfiles: [],
  signingCertificates: [],
  signingOperations: [],
};
test("batches active jobs and stops polling after mixed terminal outcomes", async () => {
  vi.useFakeTimers();
  let completed = false;
  request.mockImplementation(async (query) => {
    if (query.includes("query SigningInventoryJobs"))
      return {
        agentJobsByIds: [
          {
            id: "job-a",
            agentId: "agent-a",
            status: completed ? "SUCCEEDED" : "RUNNING",
            error: null,
          },
          {
            id: "job-b",
            agentId: "agent-b",
            status: completed ? "FAILED" : "RUNNING",
            error: completed ? "Fixture failure" : null,
          },
        ],
      } as never;
    if (query.includes("mutation RefreshSigningAssets"))
      return {
        refreshSigningAssets: [
          { id: "job-a", agentId: "agent-a", status: "QUEUED", error: null },
          { id: "job-b", agentId: "agent-b", status: "QUEUED", error: null },
        ],
      } as never;
    return inventory as never;
  });
  render(<ProvisioningProfilesPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const initialCalls = request.mock.calls.length;
  expect(
    request.mock.calls.some(([query]) =>
      query.includes("AppleDeveloperSigningInventory"),
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const batches = () =>
    request.mock.calls.filter(([query]) =>
      query.includes("query SigningInventoryJobs"),
    );
  expect(batches()).toHaveLength(1);
  expect(batches()[0][1]).toEqual({ ids: ["job-a", "job-b"] });
  completed = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2001);
  });
  const completedBatches = batches().length;
  expect(screen.getByText("Fixture failure")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(batches()).toHaveLength(completedBatches);
  expect(
    request.mock.calls.filter(
      ([query]) =>
        !query.includes("SigningInventoryJobs") && !query.includes("mutation"),
    ),
  ).toHaveLength(initialCalls + 1);
});
test("loads Apple portal data on tab intent and cancels an unfinished portal read on unmount", async () => {
  vi.useFakeTimers();
  let portalSignal: AbortSignal | undefined;
  request.mockImplementation((query, _variables, options) => {
    if (query.includes("AppleDeveloperSigningInventory")) {
      portalSignal = options?.signal;
      return new Promise(() => undefined);
    }
    return Promise.resolve(inventory) as never;
  });
  const view = render(<ProvisioningProfilesPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(portalSignal).toBeUndefined();
  fireEvent.click(screen.getByRole("tab", { name: "Apple portal" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(portalSignal?.aborted).toBe(false);
  view.unmount();
  expect(portalSignal?.aborted).toBe(true);
});
