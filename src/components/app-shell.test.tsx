import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: width < 768,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

function renderShell({
  leftDefaultOpen = true,
  rightDefaultOpen = true,
}: {
  leftDefaultOpen?: boolean;
  rightDefaultOpen?: boolean;
} = {}) {
  return render(
    <TooltipProvider>
      <AppShell
        leftDefaultOpen={leftDefaultOpen}
        rightDefaultOpen={rightDefaultOpen}
      >
        <p>Page content</p>
      </AppShell>
    </TooltipProvider>,
  );
}

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; path=/; max-age=0`;
    }
  }
}

describe("AppShell", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    clearCookies();
  });

  afterEach(() => {
    cleanup();
    clearCookies();
  });

  test("opens both sidebars on desktop by default and toggles them independently", () => {
    renderShell();

    expect(
      screen.getByRole("link", { name: "Usage" }).getAttribute("href"),
    ).toBe("/usage");
    expect(
      screen.getByRole("link", { name: "Comments" }).getAttribute("href"),
    ).toBe("/comments");
    expect(
      screen.getByRole("link", { name: "Actions" }).getAttribute("href"),
    ).toBe("/actions");
    expect(
      screen.getByRole("link", { name: "Devices" }).getAttribute("href"),
    ).toBe("/devices");

    const leftToggle = screen.getByRole("button", {
      name: "Hide navigation",
    });
    const rightToggle = screen.getByRole("button", {
      name: "Hide notifications",
    });

    fireEvent.click(leftToggle);
    expect(
      screen.getByRole("button", { name: "Show navigation" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide notifications" }),
    ).toBeDefined();
    expect(document.cookie).toContain(`${LEFT_SIDEBAR_COOKIE}=false`);
    expect(document.cookie).not.toContain(RIGHT_SIDEBAR_COOKIE);

    fireEvent.click(rightToggle);
    expect(
      screen.getByRole("button", { name: "Show notifications" }),
    ).toBeDefined();
    expect(document.cookie).toContain(`${RIGHT_SIDEBAR_COOKIE}=false`);
  });

  test("uses independently restored desktop defaults", () => {
    renderShell({ leftDefaultOpen: false, rightDefaultOpen: true });

    expect(
      screen.getByRole("button", { name: "Show navigation" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide notifications" }),
    ).toBeDefined();
  });

  test("keeps the sticky header outside the page scroll container", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(main.className).toContain("overflow-y-auto");
    expect(main.querySelector("header")).toBeNull();
    expect(main.previousElementSibling?.tagName).toBe("HEADER");
  });

  test("starts closed on mobile and opens the requested accessible sheet", async () => {
    setViewportWidth(375);
    renderShell();

    const navigationToggle = await screen.findByRole("button", {
      name: "Show navigation",
    });
    expect(
      screen.getByRole("button", { name: "Show notifications" }),
    ).toBeDefined();

    fireEvent.click(navigationToggle);
    const navigationDialog = await screen.findByRole("dialog", {
      name: "Navigation",
    });
    expect(navigationDialog).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show notifications" }));
    expect(
      await screen.findByRole("dialog", { name: "Notifications" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Close notifications" }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Close notifications" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Notifications" }),
      ).toBeNull();
    });
  });
});
