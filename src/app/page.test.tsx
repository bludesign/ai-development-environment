import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import Home from "@/app/[locale]/page";
import { ActionCenterProvider } from "@/components/action-center/action-center-provider";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

beforeEach(() => {
  vi.clearAllMocks();
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as never);
  request.mockResolvedValue({
    actionCenter: {
      items: [],
      nextCursor: null,
      totalCount: 0,
      needsAttentionCount: 0,
      activeCount: 0,
    },
  } as never);
});

afterEach(cleanup);

test("renders the Action Center at the root route", async () => {
  render(
    <ActionCenterProvider>
      <Home />
    </ActionCenterProvider>,
  );

  expect(
    await screen.findByRole("heading", { level: 1, name: "Action Center" }),
  ).toBeDefined();
  expect(await screen.findByText("Nothing needs action")).toBeDefined();
});
