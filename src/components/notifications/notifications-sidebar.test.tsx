import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

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

  test("persists sound and confirms clearing the sidebar", async () => {
    renderSidebar();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn on notification sounds" }),
    );
    expect(window.localStorage.getItem("notification-sound-enabled")).toBe(
      "true",
    );
    expect(oscillatorStart).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear sidebar" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DismissAllSidebarNotifications"),
      ),
    );
  });
});
