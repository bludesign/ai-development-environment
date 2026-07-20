"use client";

import { Download, Plus, Smartphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { IosDeviceStatusBadge } from "./status-badge";
import type { IosDeviceSummary } from "./types";
import { IOS_DEVICE_LIST_FIELDS } from "./types";

const STATUSES = [
  "ALL",
  "PENDING",
  "REGISTERING",
  "REGISTERED",
  "REGISTRATION_FAILED",
  "REJECTED",
] as const;

const SORTS = ["NEWEST", "NAME", "LAST_SEEN"] as const;

export function DevicesPage() {
  const t = useTranslations("devices");
  const locale = useLocale();
  const router = useRouter();
  const [devices, setDevices] = useState<IosDeviceSummary[]>([]);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("ALL");
  const [sort, setSort] = useState<(typeof SORTS)[number]>("NEWEST");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        iosDevices: IosDeviceSummary[];
      }>(
        `query IosDevices($status: IosDeviceStatus) {
          iosDevices(status: $status) { ${IOS_DEVICE_LIST_FIELDS} }
        }`,
        { status: status === "ALL" ? null : status },
      );
      setDevices(data.iosDevices);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(
    () =>
      controlPlaneSubscriptions().subscribe<{
        iosDevicesChanged: { id: string | null };
      }>(
        {
          query: "subscription IosDevicesChanged { iosDevicesChanged { id } }",
        },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    [load],
  );

  const sorted = useMemo(
    () =>
      [...devices].sort((first, second) => {
        if (sort === "NAME") {
          return first.displayName.localeCompare(second.displayName, locale);
        }
        if (sort === "LAST_SEEN") {
          return (
            Date.parse(second.lastSeenAt ?? "1970-01-01") -
            Date.parse(first.lastSeenAt ?? "1970-01-01")
          );
        }
        return Date.parse(second.createdAt) - Date.parse(first.createdAt);
      }),
    [devices, locale, sort],
  );

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : "—";

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a href="/api/ios/devices/export.tsv">
              <Download /> {t("export")}
            </a>
          </Button>
          <Button asChild>
            <Link href="/devices/enroll">
              <Plus /> {t("addDevice")}
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        <Select
          onValueChange={(value) => setStatus(value as typeof status)}
          value={status}
        >
          <SelectTrigger aria-label={t("filterStatus")} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "ALL" ? t("allStatuses") : t(`status.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => setSort(value as typeof sort)}
          value={sort}
        >
          <SelectTrigger aria-label={t("sort")} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`sortOption.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </div>
      ) : sorted.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Smartphone />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("device")}</TableHead>
                <TableHead>{t("statusLabel")}</TableHead>
                <TableHead>{t("hardware")}</TableHead>
                <TableHead>{t("lastIp")}</TableHead>
                <TableHead>{t("enrolled")}</TableHead>
                <TableHead>{t("registered")}</TableHead>
                <TableHead>{t("lastSeen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((device) => (
                <TableRow
                  aria-label={t("viewDevice", { name: device.displayName })}
                  className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  key={device.id}
                  onClick={() => router.push(`/devices/${device.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/devices/${device.id}`);
                    }
                  }}
                  role="link"
                  tabIndex={0}
                >
                  <TableCell className="min-w-52 whitespace-normal">
                    <Link
                      className="font-medium hover:underline"
                      href={`/devices/${device.id}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {device.displayName}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {device.maskedUdid}
                    </div>
                  </TableCell>
                  <TableCell>
                    <IosDeviceStatusBadge
                      label={t(`status.${device.status}`)}
                      status={device.status}
                    />
                  </TableCell>
                  <TableCell>
                    <div>{device.product ?? t("unavailable")}</div>
                    <div className="text-xs text-muted-foreground">
                      {device.osVersion
                        ? `iOS ${device.osVersion}`
                        : t("unavailable")}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {device.lastIpAddress ?? t("unavailable")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(device.createdAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(device.registeredAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(device.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}
