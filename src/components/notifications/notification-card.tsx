"use client";

import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  worktreeHighlightAccentClasses,
  worktreeHighlightBackgroundClasses,
} from "@/lib/worktree-highlight";

import type { AppNotificationView } from "./types";

export function NotificationCard({
  notification,
  arriving = false,
  onDismiss,
}: {
  notification: AppNotificationView;
  arriving?: boolean;
  onDismiss?: (id: string) => void;
}) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const color = notification.highlightColor;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-lg border border-l-4 bg-sidebar-accent/30 transition-all duration-[1400ms] hover:bg-sidebar-accent/60",
        color && worktreeHighlightBackgroundClasses[color],
        color && worktreeHighlightAccentClasses[color],
        arriving &&
          "motion-safe:animate-in motion-safe:slide-in-from-top-2 bg-primary/20 ring-1 ring-primary/30",
      )}
    >
      <Link
        className="block min-w-0 px-3 py-2.5 pr-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        href={notification.href}
      >
        <p className="truncate text-sm font-medium">{notification.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {notification.body}
        </p>
        <time
          className="mt-1.5 block text-[11px] text-muted-foreground"
          dateTime={notification.createdAt}
          title={new Date(notification.createdAt).toLocaleString(locale)}
        >
          {new Date(notification.createdAt).toLocaleString(locale, {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </time>
      </Link>
      {onDismiss && (
        <Button
          aria-label={t("dismissOne", { title: notification.title })}
          className="absolute top-1.5 right-1.5 size-7 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          onClick={() => onDismiss(notification.id)}
          size="icon-sm"
          title={t("dismiss")}
          type="button"
          variant="ghost"
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </article>
  );
}
