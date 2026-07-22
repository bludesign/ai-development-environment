import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { formatDateValue } from "@/lib/date-format";
import { NotificationsSidebar } from "./notifications-sidebar";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const nativeNotification = vi.fn(function () {
  return { close: vi.fn(), onclick: null };
});
const oscillatorStart = vi.fn();
let nextChange: ((change: Record<string, unknown>) => void) | null = null;

const existing = {
  id: "notification-1",
  typeKey: "IOS_BUILD_SUCCEEDED",
  title: "iOS build succeeded",
  body: "Example · Debug · main",
  href: "/builds/build-1",
  resourceKind: "BUILD",
  resourceId: "build-1",
  worktreeId: "worktree-1",
  highlightColor: "blue",
  sidebarRequested: true,
  browserRequested: true,
  webPushRequested: false,
  sidebarDismissedAt: null,
  createdAt: "2026-07-22T02:00:00.000Z",
  updatedAt: "2026-07-22T02:00:00.000Z",
};

beforeEach(() => {
  window.localStorage.clear();
  Object.assign(nativeNotification, {
    permission: "granted",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: nativeNotification,
  });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: class {
      currentTime = 0;
      destination = {};
      createGain() {
        return {
          connect: vi.fn(),
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
        };
      }
      createOscillator() {
        return {
          type: "sine",
          connect: vi.fn(),
          frequency: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          start: oscillatorStart,
          stop: vi.fn(),
          addEventListener: vi.fn(),
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  subscriptions.mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      nextChange = (change) =>
        sink.next({ data: { notificationsChanged: change } } as never);
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query SidebarNotifications")) {
      return { sidebarNotifications: [existing] } as never;
    }
    if (operation.includes("mutation DismissNotification")) {
      return { dismissNotification: true } as never;
    }
    if (operation.includes("mutation DismissAllSidebarNotifications")) {
      return { dismissAllSidebarNotifications: 1 } as never;
    }
    if (operation.includes("mutation DeleteSidebarNotification")) {
      return { deleteNotifications: 1 } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

function renderSidebar() {
  return render(
    <SidebarProvider defaultOpen>
      <NotificationsSidebar />
    </SidebarProvider>,
  );
}

describe("NotificationsSidebar", () => {
  test("shows live relative times with the full date on hover", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    const timestamp = document.querySelector("time");
    expect(timestamp?.textContent).not.toContain("2026");
    // The full date moved from a native title tooltip into a hover card.
    expect(timestamp?.getAttribute("title")).toBeNull();
    expect(timestamp?.getAttribute("data-slot")).toBe("hover-card-trigger");
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    setInterval.mockRestore();
  });

  test("formats relative notification ages", () => {
    expect(
      formatDateValue(existing.createdAt, "relative", {
        locale: "en",
        now: Date.parse(existing.createdAt) + 2 * 60 * 1_000,
      }),
    ).toBe("2 minutes ago");
  });

  test("prepends and highlights live notifications while showing browser alerts", async () => {
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    await act(async () =>
      nextChange?.({
        kind: "CREATED",
        notificationId: "notification-2",
        notification: {
          ...existing,
          id: "notification-2",
          title: "iOS build failed",
          createdAt: "2026-07-22T03:00:00.000Z",
        },
      }),
    );

    const articles = screen.getAllByRole("article");
    expect(articles[0]?.textContent).toContain("iOS build failed");
    expect(articles[0]?.className).toContain("w-full");
    expect(articles[0]?.className).toContain("rounded-none");
    expect(articles[0]?.parentElement?.className).toContain("gap-0");
    expect(articles[0]?.className).toContain("bg-primary/20");
    expect(articles[0]?.className).toContain("border-l-blue-500");
    expect(nativeNotification).toHaveBeenCalledWith(
      "iOS build failed",
      expect.objectContaining({ body: "Example · Debug · main" }),
    );
  });

  test("dismisses one item without deleting notification history", async () => {
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss iOS build succeeded from the sidebar",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DismissNotification"),
        { id: "notification-1" },
      ),
    );
  });

  test("offers navigation, dismiss, and confirmed delete in a context menu", async () => {
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.contextMenu(screen.getByRole("article"));

    expect(
      await screen.findByText(
        formatDateValue(existing.createdAt, "long", { locale: "en" }),
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Open build" }).getAttribute("href"),
    ).toBe("/builds/build-1");
    expect(
      screen
        .getByRole("menuitem", { name: "Open worktree" })
        .getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(screen.getByRole("menuitem", { name: "Dismiss" })).toBeDefined();

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("mutation DeleteSidebarNotification"),
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: "Confirm delete" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteSidebarNotification"),
        { selection: { ids: ["notification-1"] } },
      ),
    );
  });

  test("persists sound and confirms clearing from the toolbar menu", async () => {
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn on notification sounds" }),
    );
    expect(window.localStorage.getItem("notification-sound-enabled")).toBe(
      "true",
    );
    expect(oscillatorStart).toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Clear all" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Clear sidebar" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DismissAllSidebarNotifications"),
      ),
    );
  });
});
