import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { TransferOperationStatus } from "./operation-status";
import type { TransferOperation } from "./types";

const { subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: () => () => undefined,
  controlPlaneSubscriptions: () => ({ subscribe }),
}));
afterEach(() => {
  cleanup();
  vi.mocked(controlPlaneRequest).mockReset();
  subscribe.mockClear();
});

test("a retry follows the new operation through its subscription", async () => {
  const initial: TransferOperation = {
    id: "first",
    requestId: "first-request",
    kind: "SYNC",
    status: "FAILED",
    appId: null,
    result: null,
    items: [],
    createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z",
  };
  const retried = { ...initial, id: "retry", status: "RUNNING" };
  const callbacks = new Map<
    string,
    (data: { data: { repositoryTransferChanged: TransferOperation } }) => void
  >();
  subscribe.mockImplementation((...args: unknown[]) => {
    const operation = args[0] as { variables: { operationId: string } };
    const sink = args[1] as {
      next: NonNullable<ReturnType<typeof callbacks.get>>;
    };
    callbacks.set(operation.variables.operationId, sink.next);
    return vi.fn();
  });
  vi.mocked(controlPlaneRequest).mockImplementation(
    async (query, variables) => {
      if (query.includes("mutation RetryRepositoryTransfer"))
        return { retryRepositoryTransfer: retried } as never;
      return {
        repositoryTransferOperation:
          variables?.id === "retry" ? retried : initial,
      } as never;
    },
  );
  render(<TransferOperationStatus initial={initial} />);
  await waitFor(() => expect(callbacks.has("first")).toBe(true));
  fireEvent.click(
    screen.getByRole("button", { name: "Retry failed checkouts" }),
  );
  await waitFor(() => expect(callbacks.has("retry")).toBe(true));
  act(() => {
    callbacks.get("retry")?.({
      data: { repositoryTransferChanged: { ...retried, status: "SUCCEEDED" } },
    });
  });
  expect(screen.getByText("SUCCEEDED")).toBeDefined();
});
