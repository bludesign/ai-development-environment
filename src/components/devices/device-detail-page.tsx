"use client";

import {
  Apple,
  Check,
  Copy,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { IosDeviceRecord, IosDeviceSettings } from "./types";
import { IOS_DEVICE_FIELDS, IOS_DEVICE_SETTINGS_FIELDS } from "./types";

export function DeviceDetailPage({ id }: { id: string }) {
  const t = useTranslations("devices");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [device, setDevice] = useState<IosDeviceRecord | null>(null);
  const [settings, setSettings] = useState<IosDeviceSettings | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const formatDate = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : t("unavailable");

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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loading")}
      </div>
    );
  }

  if (!device) {
    return (
      <section className="mx-auto max-w-3xl">
        <Alert variant="destructive">
          <AlertDescription>{error ?? t("notFound")}</AlertDescription>
        </Alert>
      </section>
    );
  }

  const canRegister =
    settings?.appStoreConnectConfigured &&
    ["PENDING", "REGISTRATION_FAILED"].includes(device.status);

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link className="text-sm text-primary hover:underline" href="/devices">
          {t("back")}
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {device.displayName}
          </h1>
          <IosDeviceStatusBadge
            label={t(`status.${device.status}`)}
            status={device.status}
          />
        </div>
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
              <dt className="text-xs text-muted-foreground">{t("hardware")}</dt>
              <dd className="mt-1">{device.product ?? t("unavailable")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("osVersion")}
              </dt>
              <dd className="mt-1">{device.osVersion ?? t("unavailable")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("lastIp")}</dt>
              <dd className="mt-1 font-mono text-sm">
                {device.lastIpAddress ?? t("unavailable")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("lastSeen")}</dt>
              <dd className="mt-1">{formatDate(device.lastSeenAt)}</dd>
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

          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              disabled={!canRegister || busy}
              onClick={() => setRegisterOpen(true)}
            >
              {busy && device.status === "REGISTERING" ? (
                <Spinner />
              ) : (
                <Apple />
              )}{" "}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("ipHistory")}</CardTitle>
        </CardHeader>
        <CardContent>
          {device.ipObservations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableCell>{formatDate(observation.observedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noIpHistory")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("enrollmentHistory")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
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
                  <TableCell>{formatDate(enrollment.createdAt)}</TableCell>
                  <TableCell>{formatDate(enrollment.consumedAt)}</TableCell>
                  <TableCell>
                    {enrollment.failureCode ?? t("unavailable")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
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
