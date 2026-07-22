"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BellRing,
  CheckCircle2,
  ListFilter,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import {
  APP_NOTIFICATION_FIELDS,
  type AppNotificationView,
  type NotificationChangeView,
  type NotificationPreferenceView,
  type WebPushStateView,
} from "./types";

const PAGE_SIZE = 100;
const PREFERENCE_FIELDS = `
  key category label description sidebarEnabled browserEnabled webPushEnabled updatedAt
`;

type TimeRange = { key: string; start: string; end: string };

function localDayKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function localDayRange(value: string): TimeRange {
  const date = new Date(value);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    key: `day:${localDayKey(value)}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = window.atob(
    (value + padding).replace(/-/g, "+").replace(/_/g, "/"),
  );
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function currentPushSupport(): boolean {
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function NotificationsPage() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const [notifications, setNotifications] = useState<AppNotificationView[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferenceView[]>(
    [],
  );
  const [webPushState, setWebPushState] = useState<WebPushStateView | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selectionRanges, setSelectionRanges] = useState<TimeRange[]>([]);
  const [excludedRanges, setExcludedRanges] = useState<TimeRange[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [savingPreference, setSavingPreference] = useState<string | null>(null);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscription, setPushSubscription] =
    useState<PushSubscription | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        notifications: {
          items: AppNotificationView[];
          nextCursor: string | null;
          totalCount: number;
        };
        notificationPreferences: NotificationPreferenceView[];
        webPushState: WebPushStateView;
      }>(`query NotificationsPage {
        notifications(first: ${PAGE_SIZE}) {
          items { ${APP_NOTIFICATION_FIELDS} }
          nextCursor totalCount
        }
        notificationPreferences { ${PREFERENCE_FIELDS} }
        webPushState { configured publicKey subscriptionCount }
      }`);
      setNotifications(data.notifications.items);
      setNextCursor(data.notifications.nextCursor);
      setTotalCount(data.notifications.totalCount);
      setPreferences(data.notificationPreferences);
      setWebPushState(data.webPushState);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await controlPlaneRequest<{
        notifications: {
          items: AppNotificationView[];
          nextCursor: string | null;
          totalCount: number;
        };
      }>(
        `query MoreNotifications($after: ID!) {
          notifications(first: ${PAGE_SIZE}, after: $after) {
            items { ${APP_NOTIFICATION_FIELDS} }
            nextCursor totalCount
          }
        }`,
        { after: nextCursor },
      );
      setNotifications((current) => {
        const known = new Set(current.map(({ id }) => id));
        return [
          ...current,
          ...data.notifications.items.filter(({ id }) => !known.has(id)),
        ];
      });
      setNextCursor(data.notifications.nextCursor);
      setTotalCount(data.notifications.totalCount);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const initializeBrowserState = window.setTimeout(() => {
      if ("Notification" in window) {
        setPermission(window.Notification.permission);
      }
      const supported = currentPushSupport();
      setPushSupported(supported);
      setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
      setIsStandalone(window.matchMedia("(display-mode: standalone)").matches);
      if (supported) {
        void navigator.serviceWorker
          .getRegistration("/")
          .then((registration) => registration?.pushManager.getSubscription())
          .then((subscription) => setPushSubscription(subscription ?? null));
      }
    }, 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query: `subscription NotificationsPageChanged {
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
          if (change.kind === "CREATED" && change.notification) {
            setNotifications((current) => [
              change.notification!,
              ...current.filter(({ id }) => id !== change.notification!.id),
            ]);
            setTotalCount((current) => current + 1);
          } else if (
            change.kind === "DELETED" ||
            change.kind === "HISTORY_CLEARED" ||
            change.kind === "PREFERENCES_UPDATED"
          ) {
            void refresh();
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearTimeout(initializeBrowserState);
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  const groupedNotifications = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
    const groups: Array<{
      key: string;
      label: string;
      range: TimeRange;
      items: AppNotificationView[];
    }> = [];
    for (const notification of notifications) {
      const range = localDayRange(notification.createdAt);
      const last = groups.at(-1);
      if (last?.key === range.key) last.items.push(notification);
      else {
        groups.push({
          key: range.key,
          label: formatter.format(new Date(notification.createdAt)),
          range,
          items: [notification],
        });
      }
    }
    return groups;
  }, [locale, notifications]);

  const preferenceGroups = useMemo(() => {
    const groups = new Map<string, NotificationPreferenceView[]>();
    for (const preference of preferences) {
      const entries = groups.get(preference.category) ?? [];
      entries.push(preference);
      groups.set(preference.category, entries);
    }
    return [...groups.entries()];
  }, [preferences]);

  const isSelected = useCallback(
    (notification: AppNotificationView) => {
      if (excluded.has(notification.id)) return false;
      const time = new Date(notification.createdAt).getTime();
      if (
        excludedRanges.some(
          (range) =>
            time >= new Date(range.start).getTime() &&
            time < new Date(range.end).getTime(),
        )
      ) {
        return false;
      }
      if (selectAll || selected.has(notification.id)) return true;
      return selectionRanges.some(
        (range) =>
          time >= new Date(range.start).getTime() &&
          time < new Date(range.end).getTime(),
      );
    },
    [excluded, excludedRanges, selectAll, selected, selectionRanges],
  );

  const toggleNotification = (
    notification: AppNotificationView,
    value: boolean,
  ) => {
    if (value) {
      setSelected((current) => new Set(current).add(notification.id));
      setExcluded((current) => {
        const next = new Set(current);
        next.delete(notification.id);
        return next;
      });
    } else {
      setSelected((current) => {
        const next = new Set(current);
        next.delete(notification.id);
        return next;
      });
      if (selectAll || selectionRanges.length) {
        setExcluded((current) => new Set(current).add(notification.id));
      }
    }
  };

  const toggleDay = (
    group: (typeof groupedNotifications)[number],
    value: boolean,
  ) => {
    if (selectAll) {
      setExcludedRanges((current) =>
        value
          ? current.filter(({ key }) => key !== group.key)
          : [...current.filter(({ key }) => key !== group.key), group.range],
      );
    } else {
      setSelectionRanges((current) =>
        value
          ? [...current.filter(({ key }) => key !== group.key), group.range]
          : current.filter(({ key }) => key !== group.key),
      );
    }
    setSelected((current) => {
      const next = new Set(current);
      group.items.forEach(({ id }) => (value ? next.add(id) : next.delete(id)));
      return next;
    });
    setExcluded((current) => {
      const next = new Set(current);
      group.items.forEach(({ id }) => next.delete(id));
      return next;
    });
  };

  const resetSelection = () => {
    setSelected(new Set());
    setExcluded(new Set());
    setSelectionRanges([]);
    setExcludedRanges([]);
    setSelectAll(false);
  };

  const deleteSelected = async () => {
    try {
      await controlPlaneRequest(
        `mutation DeleteNotifications($selection: NotificationSelectionInput!) {
          deleteNotifications(selection: $selection)
        }`,
        {
          selection: {
            all: selectAll,
            ids: [...selected],
            excludedIds: [...excluded],
            ranges: selectionRanges.map(({ start, end }) => ({ start, end })),
            excludedRanges: excludedRanges.map(({ start, end }) => ({
              start,
              end,
            })),
          },
        },
      );
      resetSelection();
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const deleteAll = async () => {
    try {
      await controlPlaneRequest(
        `mutation DeleteAllNotifications { deleteAllNotifications }`,
      );
      resetSelection();
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const updatePreference = async (
    preference: NotificationPreferenceView,
    channel: "sidebarEnabled" | "browserEnabled" | "webPushEnabled",
    enabled: boolean,
  ) => {
    const next = { ...preference, [channel]: enabled };
    setPreferences((current) =>
      current.map((entry) => (entry.key === preference.key ? next : entry)),
    );
    setSavingPreference(preference.key);
    try {
      const data = await controlPlaneRequest<{
        saveNotificationPreference: NotificationPreferenceView;
      }>(
        `mutation SaveNotificationPreference($input: SaveNotificationPreferenceInput!) {
          saveNotificationPreference(input: $input) { ${PREFERENCE_FIELDS} }
        }`,
        {
          input: {
            typeKey: preference.key,
            sidebarEnabled: next.sidebarEnabled,
            browserEnabled: next.browserEnabled,
            webPushEnabled: next.webPushEnabled,
          },
        },
      );
      setPreferences((current) =>
        current.map((entry) =>
          entry.key === preference.key
            ? data.saveNotificationPreference
            : entry,
        ),
      );
    } catch (value) {
      setPreferences((current) =>
        current.map((entry) =>
          entry.key === preference.key ? preference : entry,
        ),
      );
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSavingPreference(null);
    }
  };

  const enableBrowserAlerts = async () => {
    if (!("Notification" in window)) return;
    try {
      const next = await window.Notification.requestPermission();
      setPermission(next);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const subscribePush = async () => {
    setPushBusy(true);
    try {
      if (!currentPushSupport()) throw new Error(t("pushUnsupported"));
      let nextPermission = window.Notification.permission;
      if (nextPermission !== "granted") {
        nextPermission = await window.Notification.requestPermission();
        setPermission(nextPermission);
      }
      if (nextPermission !== "granted") {
        throw new Error(t("permissionRequired"));
      }
      const prepared = await controlPlaneRequest<{
        prepareWebPush: WebPushStateView;
      }>(`mutation PrepareWebPush {
        prepareWebPush { configured publicKey subscriptionCount }
      }`);
      if (!prepared.prepareWebPush.publicKey) {
        throw new Error(t("pushKeyUnavailable"));
      }
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      let subscription = await registration.pushManager.getSubscription();
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          prepared.prepareWebPush.publicKey,
        ),
      });
      const serialized = subscription.toJSON();
      if (
        !serialized.endpoint ||
        !serialized.keys?.p256dh ||
        !serialized.keys.auth
      ) {
        throw new Error(t("pushSubscriptionInvalid"));
      }
      const data = await controlPlaneRequest<{
        registerWebPushSubscription: WebPushStateView;
      }>(
        `mutation RegisterWebPushSubscription($input: RegisterWebPushSubscriptionInput!) {
          registerWebPushSubscription(input: $input) {
            configured publicKey subscriptionCount
          }
        }`,
        {
          input: {
            endpoint: serialized.endpoint,
            p256dh: serialized.keys.p256dh,
            auth: serialized.keys.auth,
            expirationTime: serialized.expirationTime ?? null,
            locale,
            userAgent: navigator.userAgent,
          },
        },
      );
      setPushSubscription(subscription);
      setWebPushState(data.registerWebPushSubscription);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setPushBusy(false);
    }
  };

  const unsubscribePush = async () => {
    if (!pushSubscription) return;
    setPushBusy(true);
    try {
      const endpoint = pushSubscription.endpoint;
      await pushSubscription.unsubscribe();
      await controlPlaneRequest(
        `mutation UnregisterWebPushSubscription($endpoint: String!) {
          unregisterWebPushSubscription(endpoint: $endpoint)
        }`,
        { endpoint },
      );
      setPushSubscription(null);
      const state = await controlPlaneRequest<{
        webPushState: WebPushStateView;
      }>(
        `query WebPushState {
          webPushState { configured publicKey subscriptionCount }
        }`,
      );
      setWebPushState(state.webPushState);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setPushBusy(false);
    }
  };

  const hasSelection =
    selectAll || selected.size > 0 || selectionRanges.length > 0;

  return (
    <section className="mx-auto flex w-full max-w-[1700px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("deliverySetup")}</CardTitle>
            <CardDescription>{t("deliverySetupDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="font-medium">{t("browserAlerts")}</p>
                <p className="text-xs text-muted-foreground">
                  {permission === "unsupported"
                    ? t("browserUnsupported")
                    : t(`permissions.${permission}`)}
                </p>
              </div>
              {permission === "granted" ? (
                <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 /> {t("enabled")}
                </Badge>
              ) : (
                <Button
                  disabled={
                    permission === "denied" || permission === "unsupported"
                  }
                  onClick={() => void enableBrowserAlerts()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <BellRing /> {t("enable")}
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="font-medium">{t("webPush")}</p>
                <p className="text-xs text-muted-foreground">
                  {!pushSupported
                    ? t("pushUnsupported")
                    : pushSubscription
                      ? t("pushSubscribed")
                      : t("pushNotSubscribed")}
                </p>
                {webPushState && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("subscriptionCount", {
                      count: webPushState.subscriptionCount,
                    })}
                  </p>
                )}
              </div>
              <Button
                disabled={!pushSupported || pushBusy}
                onClick={() =>
                  void (pushSubscription ? unsubscribePush() : subscribePush())
                }
                size="sm"
                type="button"
                variant={pushSubscription ? "outline" : "default"}
              >
                {pushBusy ? <Spinner /> : <Send />}
                {pushSubscription ? t("unsubscribe") : t("subscribe")}
              </Button>
            </div>

            {isIos && !isStandalone && (
              <Alert>
                <AlertDescription>{t("iosInstallHelp")}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("preferences")}</CardTitle>
            <CardDescription>{t("preferencesDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">
                    {t("notificationType")}
                  </TableHead>
                  <TableHead className="text-center">
                    {t("sidebarChannel")}
                  </TableHead>
                  <TableHead className="text-center">
                    {t("browserChannel")}
                  </TableHead>
                  <TableHead className="pr-4 text-center">
                    {t("pushChannel")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preferenceGroups.map(([category, entries]) => (
                  <Fragment key={category}>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell
                        className="py-1.5 pl-4 text-xs font-medium text-muted-foreground"
                        colSpan={4}
                      >
                        {t(`categories.${category}`)}
                      </TableCell>
                    </TableRow>
                    {entries.map((preference) => (
                      <TableRow key={preference.key}>
                        <TableCell className="pl-4">
                          <p className="font-medium">
                            {t(`types.${preference.key}.title`)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t(`types.${preference.key}.description`)}
                          </p>
                        </TableCell>
                        {(
                          [
                            "sidebarEnabled",
                            "browserEnabled",
                            "webPushEnabled",
                          ] as const
                        ).map((channel) => (
                          <TableCell className="text-center" key={channel}>
                            <Checkbox
                              aria-label={t("toggleChannel", {
                                channel: t(
                                  channel === "sidebarEnabled"
                                    ? "sidebarChannel"
                                    : channel === "browserEnabled"
                                      ? "browserChannel"
                                      : "pushChannel",
                                ),
                                type: t(`types.${preference.key}.title`),
                              })}
                              checked={preference[channel]}
                              disabled={savingPreference === preference.key}
                              onCheckedChange={(checked) =>
                                void updatePreference(
                                  preference,
                                  channel,
                                  checked === true,
                                )
                              }
                            />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
          <div>
            <h2 className="font-semibold">{t("history")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("historyCount", { count: totalCount })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setEditMode((current) => !current);
                resetSelection();
              }}
              size="sm"
              type="button"
              variant={editMode ? "default" : "outline"}
            >
              {editMode ? <X /> : <ListFilter />}
              {editMode ? t("done") : t("edit")}
            </Button>
            <ConfirmationDialog
              actionLabel={t("deleteAll")}
              cancelLabel={t("cancel")}
              description={t("deleteAllDescription")}
              onConfirm={deleteAll}
              title={t("deleteAllTitle")}
              trigger={
                <Button
                  disabled={!totalCount}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Trash2 /> {t("deleteAll")}
                </Button>
              }
            />
          </div>
        </div>

        {editMode && (
          <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 p-3">
            <span className="text-xs text-muted-foreground">
              {selectAll
                ? t("allSelected")
                : t("selectedCount", {
                    count: notifications.filter(isSelected).length,
                  })}
            </span>
            <Button
              disabled={!hasSelection}
              onClick={() => void deleteSelected()}
              size="sm"
              type="button"
              variant="destructive"
            >
              <Trash2 /> {t("deleteSelected")}
            </Button>
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {editMode && (
                  <TableHead className="w-10 pl-3">
                    <Checkbox
                      aria-label={t("selectAll")}
                      checked={
                        selectAll && excluded.size ? "indeterminate" : selectAll
                      }
                      onCheckedChange={(checked) => {
                        const value = checked === true;
                        setSelectAll(value);
                        setSelected(
                          value
                            ? new Set(notifications.map(({ id }) => id))
                            : new Set(),
                        );
                        setExcluded(new Set());
                        setSelectionRanges([]);
                        setExcludedRanges([]);
                      }}
                    />
                  </TableHead>
                )}
                <TableHead>{t("notification")}</TableHead>
                <TableHead>{t("channels")}</TableHead>
                <TableHead className="text-right">{t("received")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    className="py-12 text-center"
                    colSpan={editMode ? 4 : 3}
                  >
                    <Spinner />
                  </TableCell>
                </TableRow>
              ) : notifications.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="py-12 text-center text-muted-foreground"
                    colSpan={editMode ? 4 : 3}
                  >
                    {t("historyEmpty")}
                  </TableCell>
                </TableRow>
              ) : (
                groupedNotifications.map((group) => {
                  const groupChecked = group.items.every(isSelected);
                  const groupSome = group.items.some(isSelected);
                  return (
                    <Fragment key={group.key}>
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        {editMode && (
                          <TableCell className="pl-3">
                            <Checkbox
                              aria-label={t("selectDay", { day: group.label })}
                              checked={
                                groupChecked
                                  ? true
                                  : groupSome
                                    ? "indeterminate"
                                    : false
                              }
                              onCheckedChange={(checked) =>
                                toggleDay(group, checked === true)
                              }
                            />
                          </TableCell>
                        )}
                        <TableCell
                          className="py-1.5 text-xs text-muted-foreground"
                          colSpan={3}
                        >
                          {group.label}
                        </TableCell>
                      </TableRow>
                      {group.items.map((notification) => {
                        const color = notification.highlightColor;
                        return (
                          <TableRow
                            className={cn(
                              "transition-colors",
                              color &&
                                worktreeHighlightBackgroundClasses[color],
                            )}
                            key={notification.id}
                          >
                            {editMode && (
                              <TableCell
                                className={cn(
                                  "border-l-4 pl-3",
                                  color
                                    ? worktreeHighlightAccentClasses[color]
                                    : "border-l-transparent",
                                )}
                              >
                                <Checkbox
                                  aria-label={t("selectNotification", {
                                    title: notification.title,
                                  })}
                                  checked={isSelected(notification)}
                                  onCheckedChange={(checked) =>
                                    toggleNotification(
                                      notification,
                                      checked === true,
                                    )
                                  }
                                />
                              </TableCell>
                            )}
                            <TableCell
                              className={cn(
                                "min-w-80",
                                !editMode && "border-l-4",
                                !editMode &&
                                  (color
                                    ? worktreeHighlightAccentClasses[color]
                                    : "border-l-transparent"),
                              )}
                            >
                              <Link
                                className="font-medium hover:underline"
                                href={notification.href}
                              >
                                {notification.title}
                              </Link>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {notification.body}
                              </p>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {notification.sidebarRequested && (
                                  <Badge variant="outline">
                                    {t("sidebarChannel")}
                                  </Badge>
                                )}
                                {notification.browserRequested && (
                                  <Badge variant="outline">
                                    {t("browserChannel")}
                                  </Badge>
                                )}
                                {notification.webPushRequested && (
                                  <Badge variant="outline">
                                    {t("pushChannel")}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              <time
                                dateTime={notification.createdAt}
                                title={new Date(
                                  notification.createdAt,
                                ).toLocaleString(locale)}
                              >
                                {new Date(
                                  notification.createdAt,
                                ).toLocaleTimeString(locale, {
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                              </time>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        <div
          ref={sentinel}
          className="flex min-h-10 items-center justify-center p-2"
        >
          {loadingMore && <Spinner />}
        </div>
      </Card>
    </section>
  );
}
