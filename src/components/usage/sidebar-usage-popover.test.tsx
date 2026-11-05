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
import { SidebarUsagePopover } from "./sidebar-usage-popover";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
let changed: (() => void) | undefined;
const unsubscribe = vi.fn();

beforeEach(() => {
  request.mockReset();
  changed = undefined;
  unsubscribe.mockReset();
  vi.mocked(controlPlaneSubscriptions).mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      changed = () =>
        sink.next({ data: { sidebarStatusChanged: true } } as never);
      return unsubscribe;
    }),
  } as never);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: { width: 360, height: 144 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

function history(costs: number[], hasUsage = true) {
  return {
    sidebarUsageHistory: {
      days: costs.map((totalCost, index) => ({
        period: `2026-10-${String(11 + index).padStart(2, "0")}`,
        totalCost,
      })),
      hasUsage,
      collectedAt: null,
    },
  };
}

describe("SidebarUsagePopover", () => {
  test("shows the seven-day sum after Today and formats calendar dates with the year", async () => {
    request.mockResolvedValue(history([1, 2, 3, 4, 5, 6, 7]) as never);
    render(<SidebarUsagePopover totalCost={7} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Usage today/ }));
    expect(await screen.findByText("Last 7 days:")).toBeDefined();
    await waitFor(() => expect(screen.getByText("$28.00")).toBeDefined());
    expect(screen.getByText("Today:").parentElement?.textContent).toContain(
      "Today: $7.00Last 7 days: $28.00",
    );
    expect(
      await screen.findByText("Oct 11, 2026", { selector: "tspan" }),
    ).toBeDefined();
    expect(
      request.mock.calls.every(([query]) =>
        String(query).includes("query SidebarUsageHistory"),
      ),
    ).toBe(true);
  });

  test("keeps the previous total after refresh failure and supports Retry", async () => {
    request
      .mockResolvedValueOnce(history([2, 3, 0, 0, 0, 0, 0]) as never)
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValueOnce(history([2, 4, 0, 0, 0, 0, 0]) as never);
    render(<SidebarUsagePopover totalCost={0} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Usage today/ }));
    await screen.findByText("$5.00");
    act(() => changed?.());
    await screen.findByRole("alert");
    expect(screen.getByText("$5.00")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("$6.00");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("renders zero spend for empty history and stops observing on dismissal", async () => {
    request.mockResolvedValue(history([0, 0, 0, 0, 0, 0, 0], false) as never);
    const navigate = vi.fn();
    render(<SidebarUsagePopover totalCost={null} onNavigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Usage today/ }));
    await screen.findByText("$0.00");
    expect(
      screen.getByText("No usage recorded in the last seven days."),
    ).toBeDefined();
    const link = screen.getByRole("link", { name: "View full usage" });
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
