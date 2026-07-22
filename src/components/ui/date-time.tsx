"use client";

import { useLocale } from "next-intl";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useNow } from "@/hooks/use-now";
import {
  DATE_FALLBACK,
  formatDateValue,
  formatUtcMillis,
  toDate,
  type DateInput,
  type DateKind,
} from "@/lib/date-format";
import { cn } from "@/lib/utils";

export type DateTimeProps = {
  value: DateInput;
  /** Defaults to `short`. */
  kind?: DateKind;
  /** `long`/`short` only. When false the hover card is suppressed too. */
  showTime?: boolean;
  /** 12-hour clock. Defaults to true. */
  hour12?: boolean;
  /** Render in UTC rather than the viewer's zone. */
  utc?: boolean;
  /** Opt out of the hover card. */
  hover?: boolean;
  /** Shown when the value is missing or unparseable. Defaults to an em dash. */
  fallback?: string;
  className?: string;
};

/** "UTC" sits a little smaller than the time it labels. */
function Utc() {
  return <span className="text-[0.85em]">UTC</span>;
}

function DateHoverContent({
  date,
  locale,
  hour12,
  utc,
}: {
  date: Date;
  locale: string;
  hour12: boolean;
  utc: boolean;
}) {
  const timestamp = date.getTime();
  const now = useNow(timestamp);

  return (
    <>
      <p className="text-xs font-medium tabular-nums">
        {formatDateValue(date, "long", { locale, hour12, utc })}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
        {now === null
          ? null
          : `${formatDateValue(date, "relative", { locale, now })} · `}
        {formatDateValue(date, "time", { locale, hour12: true, utc: true })}{" "}
        <Utc /> · {formatUtcMillis(date, locale)} <Utc />
      </p>
    </>
  );
}

function RelativeText({
  date,
  locale,
  hour12,
  utc,
}: {
  date: Date;
  locale: string;
  hour12: boolean;
  utc: boolean;
}) {
  const now = useNow(date.getTime());
  // Before hydration there is no clock, so show an absolute value that the
  // server and client agree on, then swap to relative once mounted.
  return (
    <>
      {now === null
        ? formatDateValue(date, "short", { locale, hour12, utc })
        : formatDateValue(date, "relative", { locale, now })}
    </>
  );
}

/**
 * Renders a timestamp in one of the four app-wide formats, with a hover card
 * exposing the full date, its age, and both UTC renderings.
 *
 * The hover card is skipped for date-only values, which have no time detail to
 * reveal.
 */
export function DateTime({
  value,
  kind = "short",
  showTime = true,
  hour12 = true,
  utc = false,
  hover = true,
  fallback = DATE_FALLBACK,
  className,
}: DateTimeProps) {
  const locale = useLocale();
  const date = toDate(value);

  if (!date) {
    return <span className={className}>{fallback}</span>;
  }

  // A date without a time has nothing extra to reveal on hover.
  const dateOnly = kind !== "relative" && kind !== "time" && !showTime;
  const withHover = hover && !dateOnly;

  const element = (
    <time
      className={cn("tabular-nums", className)}
      dateTime={date.toISOString()}
      // Keeps the hover card reachable by keyboard, not mouse-only.
      tabIndex={withHover ? 0 : undefined}
    >
      {kind === "relative" ? (
        <RelativeText date={date} hour12={hour12} locale={locale} utc={utc} />
      ) : (
        formatDateValue(date, kind, { locale, hour12, utc, showTime })
      )}
    </time>
  );

  if (!withHover) return element;

  return (
    <HoverCard>
      <HoverCardTrigger asChild>{element}</HoverCardTrigger>
      <HoverCardContent className="w-auto max-w-[calc(100vw-2rem)] p-2">
        <DateHoverContent
          date={date}
          hour12={hour12}
          locale={locale}
          utc={utc}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
