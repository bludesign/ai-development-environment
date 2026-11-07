"use client";

import { CircleDollarSign, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bar, BarChart, XAxis } from "recharts";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

type History = {
  days: { period: string; totalCost: number }[];
  hasUsage: boolean;
  collectedAt: string | null;
};
export function SidebarUsagePopover({
  totalCost,
  onNavigate,
}: {
  totalCost: number | null;
  onNavigate: () => void;
}) {
  const t = useTranslations("usage");
  const disk = useTranslations("diskSpace");
  const locale = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updates = useRef<ReturnType<typeof createRefreshCoalescer> | null>(
    null,
  );
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  });
  useEffect(() => {
    if (!open) return;
    const owner = createRefreshCoalescer(async (signal) => {
      setLoading(true);
      setError(null);
      try {
        const data = await controlPlaneRequest<{
          sidebarUsageHistory: History;
        }>(
          `query SidebarUsageHistory { sidebarUsageHistory { days { period totalCost } hasUsage collectedAt } }`,
          undefined,
          { signal },
        );
        if (!signal.aborted) setHistory(data.sidebarUsageHistory);
      } catch (value) {
        if (!signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    updates.current = owner;
    const initial = window.setTimeout(() => void owner.refresh(), 0);
    const timer = window.setInterval(() => void owner.refreshIfIdle(), 60_000);
    const sub = controlPlaneSubscriptions().subscribe<{
      sidebarStatusChanged: boolean;
    }>(
      { query: "subscription SidebarUsageChanged { sidebarStatusChanged }" },
      {
        next: () => void owner.refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      owner.dispose();
      if (updates.current === owner) updates.current = null;
      sub();
    };
  }, [open]);
  const formatPeriod = (period: string) =>
    formatDateValue(`${period}T00:00:00Z`, "short", {
      locale,
      utc: true,
      showTime: false,
    });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent"
        >
          <span className="flex items-center gap-2">
            <CircleDollarSign className="size-3.5" />
            {disk("usageToday")}
          </span>
          <span className="font-medium tabular-nums">
            {totalCost == null ? "—" : currency.format(totalCost)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={isMobile ? "top" : "right"}
        align={isMobile ? "start" : "end"}
        collisionPadding={8}
        className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1rem))] gap-3 overflow-y-auto [overflow-wrap:anywhere]"
      >
        <PopoverHeader>
          <PopoverTitle>{t("sidebarTitle")}</PopoverTitle>
        </PopoverHeader>
        <p className="text-sm">
          {t("sidebarToday")}:{" "}
          <strong>
            {totalCost == null ? "—" : currency.format(totalCost)}
          </strong>
        </p>
        <p className="text-sm">
          {t("sidebarLast7Days")}:{" "}
          <strong>
            {history
              ? currency.format(
                  history.days.reduce((sum, day) => sum + day.totalCost, 0),
                )
              : "—"}
          </strong>
        </p>
        {loading && !history && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner />
            {t("sidebarLoading")}
          </p>
        )}
        {error && (
          <div role="alert" className="space-y-2 text-sm">
            <p>{error}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void updates.current?.refresh()}
            >
              {t("sidebarRetry")}
            </Button>
          </div>
        )}
        {history &&
          (history.hasUsage ? (
            <ChartContainer
              className="h-36 w-full shrink-0"
              config={{
                totalCost: {
                  label: t("cost"),
                  color: "var(--chart-1)",
                },
              }}
            >
              <BarChart accessibilityLayer data={history.days}>
                <XAxis
                  dataKey="period"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatPeriod(String(value))}
                  minTickGap={16}
                  fontSize={10}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      labelFormatter={(value) => formatPeriod(String(value))}
                      formatter={(value) => currency.format(Number(value))}
                    />
                  }
                />
                <Bar
                  dataKey="totalCost"
                  fill="var(--color-totalCost)"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="text-sm text-muted-foreground">{t("sidebarEmpty")}</p>
          ))}
        {history?.collectedAt && (
          <p className="text-xs text-muted-foreground">
            {t("sidebarCollectedAt", {
              date: formatDateValue(history.collectedAt, "short", { locale }),
            })}
          </p>
        )}
        <Button asChild size="sm" variant="outline">
          <Link
            href="/ai/usage"
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
          >
            {t("viewFullUsage")}
            <ExternalLink />
          </Link>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
