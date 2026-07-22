"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, GitBranch, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { worktreeDetailHref } from "@/components/worktrees/worktree-navigation";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import type { AppNotificationView } from "./types";

export function relativeNotificationTime(
  value: string,
  locale: string,
  now: number,
): string {
  const seconds = Math.round((Date.parse(value) - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

export function NotificationCard({
  notification,
  arriving = false,
  now,
  onDelete,
  onDismiss,
}: {
  notification: AppNotificationView;
  arriving?: boolean;
  now: number | null;
  onDelete?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const color = notification.highlightColor;
  const [deleteArmed, setDeleteArmed] = useState(false);
  const deleteTimer = useRef<number | null>(null);
  const fullTime = new Date(notification.createdAt).toLocaleString(locale, {
    dateStyle: "full",
    timeStyle: "medium",
  });

  useEffect(
    () => () => {
      if (deleteTimer.current) window.clearTimeout(deleteTimer.current);
    },
    [],
  );

  const armDelete = () => {
    setDeleteArmed(true);
    if (deleteTimer.current) window.clearTimeout(deleteTimer.current);
    deleteTimer.current = window.setTimeout(() => {
      deleteTimer.current = null;
      setDeleteArmed(false);
    }, 5_000);
  };

  const confirmDelete = () => {
    if (deleteTimer.current) window.clearTimeout(deleteTimer.current);
    deleteTimer.current = null;
    setDeleteArmed(false);
    onDelete?.(notification.id);
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) setDeleteArmed(false);
      }}
    >
      <ContextMenuTrigger asChild>
        <article
          className={cn(
            "group relative w-full overflow-hidden rounded-none border border-x-0 border-t-0 border-l-4 bg-sidebar-accent/30 transition-all duration-[1400ms] hover:bg-sidebar-accent/60",
            color && worktreeHighlightBackgroundClasses[color],
            color && worktreeHighlightAccentClasses[color],
            arriving &&
              "motion-safe:animate-in motion-safe:slide-in-from-top-2 bg-primary/20 ring-1 ring-primary/30",
          )}
        >
          <Link
            className="block min-w-0 px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            href={notification.href}
          >
            <p className="truncate pr-8 text-sm font-medium">
              {notification.title}
            </p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {notification.body}
            </p>
            <time
              className="mt-1.5 block text-[11px] text-muted-foreground"
              dateTime={notification.createdAt}
              title={fullTime}
            >
              {relativeNotificationTime(
                notification.createdAt,
                locale,
                now ?? Date.parse(notification.createdAt),
              )}
            </time>
          </Link>
          {onDismiss && (
            <Button
              aria-label={t("dismissOne", { title: notification.title })}
              className="absolute top-1 right-1.5 size-7 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              onClick={() => onDismiss(notification.id)}
              size="icon-sm"
              title={t("dismiss")}
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuLabel className="font-normal whitespace-normal">
          {fullTime}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {notification.resourceKind === "BUILD" && (
          <ContextMenuItem asChild>
            <Link href={notification.href}>
              <ExternalLink /> {t("openBuild")}
            </Link>
          </ContextMenuItem>
        )}
        {notification.worktreeId && (
          <ContextMenuItem asChild>
            <Link href={worktreeDetailHref(notification.worktreeId)}>
              <GitBranch /> {t("openWorktree")}
            </Link>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!onDismiss}
          onSelect={() => onDismiss?.(notification.id)}
        >
          <X /> {t("dismiss")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!onDelete}
          onSelect={(event) => {
            if (!deleteArmed) {
              event.preventDefault();
              armDelete();
              return;
            }
            confirmDelete();
          }}
          variant={deleteArmed ? "destructive" : "default"}
        >
          {deleteArmed ? <Check /> : <Trash2 />}
          {deleteArmed ? t("confirmDelete") : t("delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
