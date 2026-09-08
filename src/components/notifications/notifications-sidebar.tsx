"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListX, Volume2, VolumeX, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

import { NotificationCard } from "./notification-card";
import { MiniActionCenter } from "@/components/action-center/mini-action-center";
import {
  APP_NOTIFICATION_FIELDS,
  type AppNotificationView,
  type NotificationChangeView,
} from "./types";

const VOLUME_STORAGE_KEY = "notification-sound-enabled";
const ARRIVAL_HIGHLIGHT_MS = 1_400;

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function playChime(): void {
  try {
    const AudioContextType =
      window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!AudioContextType) return;
    const context = new AudioContextType();
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      880,
      context.currentTime + 0.12,
    );
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.25);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Autoplay policy may suspend audio until the next user interaction.
  }
}

function showBrowserNotification(notification: AppNotificationView): void {
  if (
    !("Notification" in window) ||
    window.Notification.permission !== "granted"
  ) {
    return;
  }
  try {
    const browserNotification = new window.Notification(notification.title, {
      body: notification.body,
      icon: "/icon-192.png",
      tag: `browser:${notification.id}`,
    });
    browserNotification.onclick = () => {
      window.focus();
      window.location.assign(notification.href);
      browserNotification.close();
    };
  } catch {
    // Permission or platform state can change between the event and display.
  }
}

function MobileClose() {
  const { setOpenMobile } = useSidebar();
  const t = useTranslations("shell");
  return (
    <Button
      aria-label={t("closeNotifications")}
      className="size-9 touch-manipulation md:hidden"
      onClick={() => setOpenMobile(false)}
      size="icon"
      type="button"
      variant="ghost"
    >
      <X />
    </Button>
  );
}

export function NotificationsSidebar() {
  const t = useTranslations("notifications");
  const ts = useTranslations("shell");
  const [notifications, setNotifications] = useState<AppNotificationView[]>([]);
  const [arrivingIds, setArrivingIds] = useState<Set<string>>(new Set());
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const soundEnabledRef = useRef(false);
  const timers = useRef<Map<string, number>>(new Map());

  const snapshotRevision = useRef(0);
  const itemsRef = useRef<AppNotificationView[]>([]);
  const deliveredIds = useRef(new Set<string>());
  const ownerRef = useRef<RefreshCoalescer | null>(null);
  const load = useCallback(
    () => ownerRef.current?.refresh() ?? Promise.resolve(),
    [],
  );
  const replaceNotifications = useCallback((items: AppNotificationView[]) => {
    itemsRef.current = items;
    setNotifications(items);
  }, []);
  const fetchNotifications = useCallback(
    async (signal: AbortSignal) => {
      const revision = snapshotRevision.current;
      try {
        const data = await controlPlaneRequest<{
          sidebarNotifications: AppNotificationView[];
        }>(
          `query SidebarNotifications {
        sidebarNotifications(limit: 50) { ${APP_NOTIFICATION_FIELDS} }
      }`,
          undefined,
          { signal },
        );
        if (signal.aborted) return;
        if (revision !== snapshotRevision.current) {
          void load();
          return;
        }
        replaceNotifications(data.sidebarNotifications);
        for (const item of data.sidebarNotifications)
          deliveredIds.current.add(item.id);
      } catch {
        // The shell stays usable while the control-plane connection recovers.
      } finally {
        if (!signal.aborted) setLoaded(true);
      }
    },
    [load, replaceNotifications],
  );

  useEffect(() => {
    const owner = createRefreshCoalescer(fetchNotifications);
    ownerRef.current = owner;
    const recover = onControlPlaneRecovery((event) => {
      // Preserve the initial snapshot and reconcile when an existing stream recovers.
      if (!event?.initialConnection) void load();
    });
    const arrivalTimers = timers.current;
    const initializeSound = window.setTimeout(() => {
      const enabled =
        window.localStorage.getItem(VOLUME_STORAGE_KEY) === "true";
      setSoundEnabled(enabled);
      soundEnabledRef.current = enabled;
    }, 0);
    const initial = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query: `subscription NotificationsSidebarChanged {
          notificationsChanged {
            kind notificationId
            notification { ${APP_NOTIFICATION_FIELDS} }
          }
        }`,
      },
      {
        next: (result) => {
          const change = (
            result.data as { notificationsChanged?: NotificationChangeView }
          )?.notificationsChanged;
          if (!change) return;
          if (
            change.kind === "PREFERENCES_UPDATED" ||
            change.kind === "DEVICES_CHANGED"
          )
            return;
          ++snapshotRevision.current;
          const notification = change.notification;
          if (change.kind === "CREATED" && notification) {
            const firstDelivery = !deliveredIds.current.has(notification.id);
            deliveredIds.current.add(notification.id);
            if (deliveredIds.current.size > 1000)
              deliveredIds.current.delete(
                deliveredIds.current.values().next().value!,
              );
            if (firstDelivery && notification.browserRequested) {
              showBrowserNotification(notification);
            }
            if (notification.sidebarRequested) {
              replaceNotifications(
                [
                  notification,
                  ...itemsRef.current.filter(
                    (entry) => entry.id !== notification.id,
                  ),
                ].slice(0, 50),
              );
              setArrivingIds((current) =>
                new Set(current).add(notification.id),
              );
              window.clearTimeout(timers.current.get(notification.id));
              const timer = window.setTimeout(() => {
                timers.current.delete(notification.id);
                setArrivingIds((current) => {
                  const next = new Set(current);
                  next.delete(notification.id);
                  return next;
                });
              }, ARRIVAL_HIGHLIGHT_MS);
              timers.current.set(notification.id, timer);
              if (firstDelivery && soundEnabledRef.current) playChime();
            }
            return;
          }
          if (
            change.kind === "SIDEBAR_CLEARED" ||
            change.kind === "HISTORY_CLEARED"
          ) {
            replaceNotifications([]);
            return;
          }
          if (
            (change.kind === "DISMISSED" || change.kind === "DELETED") &&
            change.notificationId
          ) {
            const current = itemsRef.current;
            if (!current.some((item) => item.id === change.notificationId))
              return;
            replaceNotifications(
              current.filter((item) => item.id !== change.notificationId),
            );
            if (current.length === 50) void load();
            return;
          }
          void load();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearTimeout(initializeSound);
      unsubscribe();
      recover();
      owner.dispose();
      if (ownerRef.current === owner) ownerRef.current = null;
      arrivalTimers.forEach((timer) => window.clearTimeout(timer));
      arrivalTimers.clear();
    };
  }, [fetchNotifications, load, replaceNotifications]);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    soundEnabledRef.current = next;
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(next));
    if (next) playChime();
  };

  const dismiss = async (id: string) => {
    ++snapshotRevision.current;
    const backfill = itemsRef.current.length === 50;
    replaceNotifications(itemsRef.current.filter((entry) => entry.id !== id));
    try {
      await controlPlaneRequest(
        `mutation DismissNotification($id: ID!) { dismissNotification(id: $id) }`,
        { id },
      );
      if (backfill) await load();
    } catch {
      await load();
    }
  };

  const deleteNotification = async (id: string) => {
    ++snapshotRevision.current;
    const backfill = itemsRef.current.length === 50;
    replaceNotifications(itemsRef.current.filter((entry) => entry.id !== id));
    try {
      await controlPlaneRequest(
        `mutation DeleteSidebarNotification($selection: NotificationSelectionInput!) {
          deleteNotifications(selection: $selection)
        }`,
        { selection: { ids: [id] } },
      );
      if (backfill) await load();
    } catch {
      await load();
    }
  };

  const dismissAll = async () => {
    const version = snapshotRevision.current;
    try {
      await controlPlaneRequest(
        `mutation DismissAllSidebarNotifications {
          dismissAllSidebarNotifications
        }`,
      );
      if (version === snapshotRevision.current) {
        ++snapshotRevision.current;
        replaceNotifications([]);
      } else await load();
    } catch {
      await load();
    }
  };

  return (
    <Sidebar
      collapsible="offcanvas"
      mobileDescription={ts("notificationsDescription")}
      mobileTitle={ts("notifications")}
      side="right"
    >
      <SidebarHeader className="border-b border-sidebar-border pt-[max(0.5rem,env(safe-area-inset-top))] md:pt-2">
        <div className="flex min-h-10 items-center gap-1 px-2">
          <Link
            className="mr-auto text-sm font-semibold hover:underline"
            href="/notifications"
          >
            {ts("notifications")}
          </Link>
          <Button
            aria-label={soundEnabled ? t("mute") : t("unmute")}
            onClick={toggleSound}
            size="icon-sm"
            title={soundEnabled ? t("mute") : t("unmute")}
            type="button"
            variant="ghost"
          >
            {soundEnabled ? <Volume2 /> : <VolumeX />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t("clearAll")}
                disabled={!notifications.length}
                size="icon-sm"
                title={t("clearAll")}
                type="button"
                variant="ghost"
              >
                <ListX />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="font-normal whitespace-normal leading-snug">
                {t("clearSidebarDescription")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void dismissAll()}
                variant="destructive"
              >
                <ListX /> {t("clearSidebar")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <MobileClose />
        </div>
      </SidebarHeader>
      <SidebarContent className="min-h-0 overflow-hidden p-0">
        <div className="flex h-full min-h-0 flex-col">
          <div
            className="min-h-0 flex-[2_1_0%] overflow-y-auto overscroll-contain"
            data-slot="notifications-feed"
          >
            <div className="flex flex-col gap-0" aria-live="polite">
              {notifications.map((notification) => (
                <NotificationCard
                  arriving={arrivingIds.has(notification.id)}
                  key={notification.id}
                  notification={notification}
                  onDelete={(id) => void deleteNotification(id)}
                  onDismiss={(id) => void dismiss(id)}
                />
              ))}
              {loaded && notifications.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t("sidebarEmpty")}
                </p>
              )}
            </div>
          </div>
          <div
            className="min-h-0 flex-[1_1_0%] overflow-hidden border-t border-sidebar-border"
            data-slot="mini-action-center"
          >
            <MiniActionCenter />
          </div>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}
