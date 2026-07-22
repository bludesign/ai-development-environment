"use client";

import {
  Apple,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Save,
  Settings,
  Trash2,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

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
import { DateTime } from "@/components/common/date-time";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { copyText } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { IosDeviceStatusBadge } from "./status-badge";
import type {
  IosDeviceFirmware,
  IosDeviceRecord,
  IosDeviceSettings,
} from "./types";
import {
  IOS_DEVICE_FIELDS,
  IOS_DEVICE_FIRMWARE_FIELDS,
  IOS_DEVICE_SETTINGS_FIELDS,
} from "./types";

function formatBytes(value: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value / 1024 ** unitIndex,
  )} ${units[unitIndex]}`;
}

export function DeviceDetailPage({ id }: { id: string }) {
  const t = useTranslations("devices");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [device, setDevice] = useState<IosDeviceRecord | null>(null);
  const [settings, setSettings] = useState<IosDeviceSettings | null>(null);
  const [firmware, setFirmware] = useState<IosDeviceFirmware | null>(null);
  const [firmwareLoading, setFirmwareLoading] = useState(false);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedFirmwareUrl, setCopiedFirmwareUrl] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        iosDevice: IosDeviceRecord | null;
        iosDeviceSettings: IosDeviceSettings;
      }>(
        `query IosDeviceDetail($id: ID!) {
        iosDevice(id: $id) { ${IOS_DEVICE_FIELDS} }
        iosDeviceSettings { ${IOS_DEVICE_SETTINGS_FIELDS} }
      }`,
        { id },
      );
      setDevice(data.iosDevice);
      setSettings(data.iosDeviceSettings);
      setDisplayName(data.iosDevice?.displayName ?? "");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(
    () =>
      controlPlaneSubscriptions().subscribe<{
        iosDevicesChanged: { id: string | null };
      }>(
        { query: "subscription IosDeviceChanged { iosDevicesChanged { id } }" },
        {
          next: ({ data }) => {
            if (
              !data?.iosDevicesChanged.id ||
              data.iosDevicesChanged.id === id
            ) {
              void load();
            }
          },
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    [id, load],
  );

  const firmwareDeviceId = device?.id ?? null;
  const firmwareProduct = device?.product ?? null;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!firmwareDeviceId || !firmwareProduct) {
        setFirmware(null);
        setFirmwareError(null);
        setFirmwareLoading(false);
        return;
      }
      setFirmware(null);
      setFirmwareError(null);
      setFirmwareLoading(true);
      void controlPlaneRequest<{
        iosDeviceFirmware: IosDeviceFirmware | null;
      }>(
        `query IosDeviceFirmware($id: ID!) {
          iosDeviceFirmware(id: $id) { ${IOS_DEVICE_FIRMWARE_FIELDS} }
        }`,
        { id: firmwareDeviceId },
      )
        .then((data) => {
          if (!cancelled) setFirmware(data.iosDeviceFirmware);
        })
        .catch((value) => {
          if (!cancelled) {
            setFirmwareError(
              value instanceof Error ? value.message : String(value),
            );
          }
        })
        .finally(() => {
          if (!cancelled) setFirmwareLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [firmwareDeviceId, firmwareProduct]);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation RenameIosDevice($id: ID!, $displayName: String!) {
          renameIosDevice(id: $id, displayName: $displayName) { id }
        }`,
        { id, displayName },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation RegisterIosDevice($id: ID!) { registerIosDevice(id: $id) { id } }",
        { id },
      );
      setRegisterOpen(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setRegisterOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation RejectIosDevice($id: ID!) { rejectIosDevice(id: $id) { id } }",
        { id },
      );
      setRejectOpen(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation DeleteIosDevice($id: ID!) { deleteIosDevice(id: $id) }",
        { id },
      );
      router.push("/devices");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const copyUdid = async () => {
    if (!device) return;
    await copyText(device.udid);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  const copyFirmwareUrl = async (url: string) => {
    await copyText(url);
    setCopiedFirmwareUrl(url);
    window.setTimeout(() => setCopiedFirmwareUrl(null), 2_000);
  };

  if (loading) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }

  if (!device) {
    return (
      <Empty className="mx-auto max-w-6xl border py-12">
        <EmptyHeader>
          <EmptyTitle>{t("notFound")}</EmptyTitle>
          {error && <EmptyDescription>{error}</EmptyDescription>}
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/devices">
            <ArrowLeft /> {t("back")}
          </Link>
        </Button>
      </Empty>
    );
  }

  const canRegister =
    settings?.appStoreConnectConfigured &&
    ["PENDING", "REGISTRATION_FAILED"].includes(device.status);
  const installedFirmwareCandidates = device.osVersion
    ? firmware?.firmwares.filter(
        (entry) =>
          entry.version === device.osVersion ||
          entry.buildId.toUpperCase() === device.osVersion?.toUpperCase(),
      )
    : null;
  const installedFirmware =
    installedFirmwareCandidates?.find((entry) => entry.signed) ??
    installedFirmwareCandidates?.[0] ??
    null;
  const installedVersion = device.osVersion
    ? installedFirmware
      ? `${installedFirmware.version} (${installedFirmware.buildId})`
      : device.osVersion
    : t("unavailable");

  return (
    <section className="mx-auto flex min-w-0 w-full max-w-6xl flex-col gap-5">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href="/devices">
            <ArrowLeft /> {t("back")}
          </Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {device.registrationError && (
        <Alert variant="destructive">
          <AlertDescription>{device.registrationError}</AlertDescription>
        </Alert>
      )}
      {device.status === "REGISTERED" && (
        <Alert>
          <Check />
          <AlertDescription>
            {t("rebuildWarning")}{" "}
            <Link className="text-primary hover:underline" href="/builds">
              {t("openBuilds")}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {!settings?.appStoreConnectConfigured && (
        <Alert>
          <Settings />
          <AlertDescription>
            {t("configureAppleFirst")}{" "}
            <Link className="text-primary hover:underline" href="/settings">
              {t("openSettings")}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {firmware?.name ?? device.product ?? t("unavailable")}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{device.displayName}</h1>
            <IosDeviceStatusBadge
              label={t(`status.${device.status}`)}
              status={device.status}
            />
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {device.maskedUdid}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canRegister || busy}
            onClick={() => setRegisterOpen(true)}
          >
            {busy && device.status === "REGISTERING" ? <Spinner /> : <Apple />}{" "}
            {device.status === "REGISTRATION_FAILED"
              ? t("retryRegistration")
              : t("registerWithApple")}
          </Button>
          <Button
            disabled={
              busy ||
              !["PENDING", "REGISTRATION_FAILED"].includes(device.status)
            }
            onClick={() => setRejectOpen(true)}
            variant="outline"
          >
            <XCircle /> {t("reject")}
          </Button>
          <Button
            disabled={busy || device.status === "REGISTERING"}
            onClick={() => setDeleteOpen(true)}
            variant="destructive"
          >
            <Trash2 /> {t("delete")}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("generalInformation")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={rename}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="device-display-name">{t("deviceLabel")}</Label>
              <Input
                id="device-display-name"
                maxLength={100}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </div>
            <Button
              disabled={busy || displayName.trim() === device.displayName}
              type="submit"
              variant="outline"
            >
              {busy ? <Spinner /> : <Save />} {t("saveName")}
            </Button>
          </form>

          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("udid")}</dt>
              <dd className="mt-1 flex items-center gap-2 font-mono text-sm">
                <span className="break-all">
                  {revealed ? device.udid : device.maskedUdid}
                </span>
                <Button
                  aria-label={revealed ? t("hideUdid") : t("revealUdid")}
                  onClick={() => setRevealed((value) => !value)}
                  size="icon-sm"
                  variant="ghost"
                >
                  {revealed ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  aria-label={t("copyUdid")}
                  onClick={() => void copyUdid()}
                  size="icon-sm"
                  variant="ghost"
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("deviceModel")}
              </dt>
              <dd className="mt-1">
                {firmware?.name ?? device.product ?? t("unavailable")}
                {firmware && (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {firmware.identifier}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("osVersion")}
              </dt>
              <dd className="mt-1">{installedVersion}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("lastIp")}</dt>
              <dd className="mt-1 font-mono text-sm">
                {device.lastIpAddress ?? t("unavailable")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("lastSeen")}</dt>
              <dd className="mt-1">
                <DateTime value={device.lastSeenAt} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("appleDeviceId")}
              </dt>
              <dd className="mt-1 font-mono text-sm">
                {device.appleDeviceId ?? t("unavailable")}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{t("ipHistory")}</CardTitle>
        </CardHeader>
        {device.ipObservations.length ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("ipAddress")}</TableHead>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("forwardedBy")}</TableHead>
                <TableHead>{t("observed")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {device.ipObservations.map((observation) => (
                <TableRow key={observation.id}>
                  <TableCell className="font-mono text-xs">
                    {observation.ipAddress}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`ipSource.${observation.source}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {t(`ipHeaderSource.${observation.headerSource}`)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <DateTime value={observation.observedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("noIpHistory")}
          </CardContent>
        )}
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{t("enrollmentHistory")}</CardTitle>
        </CardHeader>
        {device.enrollments.length ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("statusLabel")}</TableHead>
                <TableHead>{t("created")}</TableHead>
                <TableHead>{t("completed")}</TableHead>
                <TableHead>{t("failure")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {device.enrollments.map((enrollment) => (
                <TableRow key={enrollment.id}>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`enrollmentStatus.${enrollment.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <DateTime value={enrollment.createdAt} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <DateTime value={enrollment.consumedAt} />
                  </TableCell>
                  <TableCell>
                    {enrollment.failureCode ?? t("unavailable")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("noEnrollmentHistory")}
          </CardContent>
        )}
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{t("firmwareTitle")}</CardTitle>
          <CardDescription>{t("firmwareDescription")}</CardDescription>
        </CardHeader>
        {firmwareLoading ? (
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> {t("firmwareLoading")}
          </CardContent>
        ) : firmwareError ? (
          <CardContent className="py-4">
            <Alert variant="destructive">
              <AlertDescription>
                {t("firmwareLoadFailed", { error: firmwareError })}
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : firmware?.firmwares.length ? (
          <Table className="min-w-[52rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t("signingStatus")}</TableHead>
                <TableHead>{t("firmwareVersion")}</TableHead>
                <TableHead>{t("releaseDate")}</TableHead>
                <TableHead>{t("fileSize")}</TableHead>
                <TableHead className="text-right">
                  {t("firmwareDownload")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {firmware.firmwares.map((version) => {
                const versionLabel = `${version.version} (${version.buildId})`;
                return (
                  <TableRow key={`${version.buildId}:${version.url}`}>
                    <TableCell>
                      <Badge
                        variant={version.signed ? "success" : "destructive"}
                      >
                        {t(version.signed ? "signed" : "unsigned")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {versionLabel}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <DateTime showTime={false} value={version.releaseDate} />
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {formatBytes(version.fileSize, locale)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={version.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <Download /> {t("downloadFirmware")}
                          </a>
                        </Button>
                        <Button
                          aria-label={t("copyFirmwareUrl", {
                            version: versionLabel,
                          })}
                          onClick={() => void copyFirmwareUrl(version.url)}
                          size="icon-sm"
                          title={t("copyFirmwareUrl", {
                            version: versionLabel,
                          })}
                          variant="ghost"
                        >
                          {copiedFirmwareUrl === version.url ? (
                            <Check />
                          ) : (
                            <Copy />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("noFirmware")}
          </CardContent>
        )}
      </Card>

      <ConfirmationDialog
        actionLabel={t("confirmRegister")}
        cancelLabel={tc("cancel")}
        description={t("registerDescription")}
        onConfirm={register}
        onOpenChange={setRegisterOpen}
        open={registerOpen}
        title={t("registerTitle")}
      />
      <ConfirmationDialog
        actionLabel={t("confirmReject")}
        cancelLabel={tc("cancel")}
        description={t("rejectDescription")}
        onConfirm={reject}
        onOpenChange={setRejectOpen}
        open={rejectOpen}
        title={t("rejectTitle")}
      />
      <ConfirmationDialog
        actionLabel={t("confirmDelete")}
        cancelLabel={tc("cancel")}
        description={t("deleteDescription")}
        onConfirm={remove}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("deleteTitle")}
      />
    </section>
  );
}
