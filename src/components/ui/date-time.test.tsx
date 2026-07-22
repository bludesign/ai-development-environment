import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DateTime } from "./date-time";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SAMPLE = "2026-07-22T07:01:37.143Z";

const time = () => document.querySelector("time");

const hoverCard = () =>
  document.querySelector('[data-slot="hover-card-content"]');

/** Radix opens the card after its hover delay, so let the timers run out. */
const openHoverCard = () => {
  fireEvent.pointerEnter(time()!, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
};

describe("DateTime", () => {
  test("renders a machine-readable time element", () => {
    render(<DateTime utc value={SAMPLE} />);

    expect(time()?.getAttribute("datetime")).toBe(SAMPLE);
    expect(time()?.textContent).toBe("Jul 22, 2026, 7:01:37 AM");
  });

  test("renders each kind", () => {
    const { rerender } = render(<DateTime utc kind="long" value={SAMPLE} />);
    expect(time()?.textContent).toBe("Wednesday, July 22, 2026 at 7:01:37 AM");

    rerender(<DateTime utc kind="time" value={SAMPLE} />);
    expect(time()?.textContent).toBe("7:01:37 AM");

    rerender(<DateTime utc kind="short" showTime={false} value={SAMPLE} />);
    expect(time()?.textContent).toBe("Jul 22, 2026");
  });

  test("honours a 24-hour clock", () => {
    render(<DateTime utc hour12={false} value={SAMPLE} />);
    expect(time()?.textContent).toBe("Jul 22, 2026, 07:01:37");
  });

  test("shows the fallback instead of a time element when there is no value", () => {
    render(<DateTime fallback="Never" value={null} />);

    expect(screen.getByText("Never")).toBeTruthy();
    expect(time()).toBeNull();
  });

  test("shows the long date, relative age, and both UTC times on hover", () => {
    render(<DateTime utc value={SAMPLE} />);
    openHoverCard();

    const [summary, detail] = [...hoverCard()!.querySelectorAll("p")];
    expect(summary?.textContent).toBe("Wednesday, July 22, 2026 at 7:01:37 AM");
    expect(detail?.textContent).toContain("ago");
    expect(detail?.textContent).toContain("7:01:37 AM UTC");
    expect(detail?.textContent).toContain("07:01:37.143 UTC");
  });

  test("renders UTC labels smaller than the times they label", () => {
    render(<DateTime utc value={SAMPLE} />);
    openHoverCard();

    const labels = [...document.querySelectorAll("span")].filter(
      (node) => node.textContent === "UTC",
    );
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).toContain("text-[0.85em]");
    }
  });

  test("suppresses the hover card for a date without a time", () => {
    render(<DateTime utc showTime={false} value={SAMPLE} />);

    expect(time()?.getAttribute("tabindex")).toBeNull();
    openHoverCard();

    expect(screen.queryByText(/UTC/)).toBeNull();
  });

  test("suppresses the hover card when asked", () => {
    render(<DateTime utc hover={false} value={SAMPLE} />);

    expect(time()?.getAttribute("tabindex")).toBeNull();
    openHoverCard();

    expect(screen.queryByText(/UTC/)).toBeNull();
  });

  test("keeps the hover card reachable by keyboard", () => {
    render(<DateTime utc value={SAMPLE} />);
    expect(time()?.getAttribute("tabindex")).toBe("0");
  });

  test("swaps a relative date from absolute to relative once the clock starts", () => {
    render(<DateTime kind="relative" value={Date.now() - 9 * 3_600_000} />);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(time()?.textContent).toBe("9 hours ago");
  });
});
