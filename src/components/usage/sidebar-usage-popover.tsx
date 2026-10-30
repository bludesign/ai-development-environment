"use client";

import { CircleDollarSign, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

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
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await controlPlaneRequest<{
          sidebarUsageHistory: History;
        }>(
          `query SidebarUsageHistory { sidebarUsageHistory { days { period totalCost } hasUsage collectedAt } }`,
          undefined,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setHistory(data.sidebarUsageHistory);
      } catch (value) {
        if (!controller.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const sub = controlPlaneSubscriptions().subscribe<{
      sidebarStatusChanged: boolean;
    }>(
      { query: "subscription SidebarUsageChanged { sidebarStatusChanged }" },
      {
        next: () => setRevision((value) => value + 1),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      controller.abort();
      sub();
    };
  }, [open, revision]);
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
        side="right"
        align="end"
        className="w-[min(24rem,calc(100vw-2rem))] gap-3"
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
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("sidebarRetry")}
            </Button>
          </div>
        )}
        {history &&
          (history.hasUsage ? (
            <ChartContainer
              className="h-36 w-full"
              config={{
                totalCost: {
                  label: disk("usageToday"),
                  color: "var(--chart-1)",
                },
              }}
            >
              <BarChart accessibilityLayer data={history.days}>
                <XAxis
                  dataKey="period"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    new Intl.DateTimeFormat(locale, {
                      month: "short",
                      day: "numeric",
                    }).format(new Date(`${value}T12:00:00`))
                  }
                  fontSize={10}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
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
