"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useLocale, useTranslations } from "next-intl";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

import type { UsageDayRow } from "./aggregate-usage";

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export type UsageCostSeries = {
  key: string;
  modelName: string;
  totalCost: number;
};

export type UsageCostChartData = {
  data: Array<Record<string, number | string>>;
  series: UsageCostSeries[];
};

export function buildUsageCostChartData(
  days: UsageDayRow[],
): UsageCostChartData {
  const totals = new Map<string, number>();
  days.forEach((day) =>
    day.models.forEach((model) =>
      totals.set(
        model.modelName,
        (totals.get(model.modelName) ?? 0) + model.totalCost,
      ),
    ),
  );
  const series = [...totals.entries()]
    .sort(
      ([firstName, firstCost], [secondName, secondCost]) =>
        secondCost - firstCost || firstName.localeCompare(secondName),
    )
    .map(([modelName, totalCost], index) => ({
      key: `model${index}`,
      modelName,
      totalCost,
    }));
  const keysByModel = new Map(series.map((item) => [item.modelName, item.key]));
  const data = [...days].reverse().map((day) => {
    const row: Record<string, number | string> = { period: day.period };
    series.forEach((item) => {
      row[item.key] = 0;
    });
    day.models.forEach((model) => {
      const key = keysByModel.get(model.modelName);
      if (key) row[key] = model.totalCost;
    });
    return row;
  });
  return { data, series };
}

export function totalUsageCostForChartRow(
  row: unknown,
  series: UsageCostSeries[],
): number {
  if (!row || typeof row !== "object" || Array.isArray(row)) return 0;
  const values = row as Record<string, unknown>;
  return series.reduce((sum, model) => sum + Number(values[model.key] ?? 0), 0);
}

export function UsageCostChart({ days }: { days: UsageDayRow[] }) {
  const t = useTranslations("usage");
  const locale = useLocale();
  const { data, series } = useMemo(() => buildUsageCostChartData(days), [days]);
  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        series.map((item, index) => [
          item.key,
          {
            label: item.modelName,
            color: SERIES_COLORS[index % SERIES_COLORS.length],
          },
        ]),
      ),
    [series],
  );
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale],
  );
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );
  const formatPeriod = (period: string) =>
    date.format(new Date(`${period}T00:00:00Z`));

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{t("costChartTitle")}</CardTitle>
        <CardDescription>{t("costChartDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6">
        <ChartContainer className="h-80 w-full aspect-auto" config={config}>
          <BarChart
            accessibilityLayer
            data={data}
            margin={{ left: 4, right: 12, top: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="period"
              minTickGap={24}
              tickFormatter={(value) => formatPeriod(String(value))}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              axisLine={false}
              tickFormatter={(value) => currency.format(Number(value))}
              tickLine={false}
              tickMargin={8}
              width={72}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name, item, index, row) => {
                    const total = totalUsageCostForChartRow(row, series);
                    return (
                      <div className="grid w-full min-w-40 gap-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: item.color }}
                          />
                          <span className="flex-1 text-muted-foreground">
                            {config[String(name)]?.label ?? String(name)}
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {currency.format(Number(value))}
                          </span>
                        </div>
                        {index === series.length - 1 && (
                          <div className="flex items-center justify-between gap-4 border-t pt-1.5 font-medium">
                            <span>{t("total")}</span>
                            <span className="font-mono tabular-nums">
                              {currency.format(total)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                  labelFormatter={(value) => formatPeriod(String(value))}
                />
              }
            />
            <ChartLegend
              content={
                <ChartLegendContent className="flex-wrap gap-y-2 pb-2" />
              }
            />
            {series.map((item) => (
              <Bar
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                key={item.key}
                maxBarSize={48}
                stackId="cost"
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
