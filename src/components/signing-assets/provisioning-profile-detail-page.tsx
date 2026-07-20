"use client";

import { ArrowLeft, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

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
import { controlPlaneRequest } from "@/lib/control-plane-client";

type Profile = {
  id: string;
  uuid: string;
  contentHash: string;
  name: string;
  profileType: string;
  bundleId: string;
  teamId: string | null;
  teamName: string | null;
  platforms: string[];
  deviceCount: number;
  deviceUdids: string[];
  provisionedDevices: Array<{
    udid: string;
    deviceId: string | null;
    displayName: string | null;
    product: string | null;
    osVersion: string | null;
    status: string | null;
  }>;
  certificateSha1s: string[];
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  xcodeManaged: boolean;
  installedAgents: Array<{ id: string; name: string }>;
};

export function ProvisioningProfileDetailPage({ id }: { id: string }) {
  const t = useTranslations("provisioningProfiles");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        signingProfile: Profile | null;
      }>(
        `query ProvisioningProfileDetail($id: ID!) {
          signingProfile(id: $id) {
            id uuid contentHash name profileType bundleId teamId teamName
            platforms deviceCount deviceUdids certificateSha1s createdAt expiresAt
            expired xcodeManaged installedAgents { id name }
            provisionedDevices {
              udid deviceId displayName product osVersion status
            }
          }
        }`,
        { id },
      );
      setProfile(data.signingProfile);
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

  if (loading) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> {t("loadingProfile")}
      </p>
    );
  }

  if (error) {
    return (
      <section className="mx-auto w-full max-w-[1500px] space-y-4">
        <Button asChild variant="ghost">
          <Link href="/provisioning-profiles">
            <ArrowLeft /> {t("backToProfiles")}
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="mx-auto w-full max-w-[1500px] space-y-4">
        <Button asChild variant="ghost">
          <Link href="/provisioning-profiles">
            <ArrowLeft /> {t("backToProfiles")}
          </Link>
        </Button>
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            {t("profileNotFound")}
          </CardContent>
        </Card>
      </section>
    );
  }

  const seenDeviceUdids = new Set<string>();
  const provisionedDevices = profile.provisionedDevices.filter((device) => {
    const normalized = device.udid.toUpperCase();
    if (seenDeviceUdids.has(normalized)) return false;
    seenDeviceUdids.add(normalized);
    return true;
  });

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href="/provisioning-profiles">
            <ArrowLeft /> {t("backToProfiles")}
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {profile.name}
          </h1>
          <Badge variant="outline">{profile.profileType}</Badge>
          {profile.expired && (
            <Badge variant="destructive">{t("expired")}</Badge>
          )}
          {profile.xcodeManaged && <Badge variant="secondary">Xcode</Badge>}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {profile.uuid}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("profileDetails")}</CardTitle>
          <CardDescription>{profile.bundleId}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Detail
            label={t("team")}
            value={profile.teamName ?? profile.teamId ?? "—"}
          />
          <Detail
            label={t("platforms")}
            value={profile.platforms.join(", ") || "—"}
          />
          <Detail
            label={t("created")}
            value={
              profile.createdAt
                ? new Date(profile.createdAt).toLocaleDateString()
                : "—"
            }
          />
          <Detail
            label={t("expires")}
            value={
              profile.expiresAt
                ? new Date(profile.expiresAt).toLocaleDateString()
                : "—"
            }
          />
          <Detail
            label={t("installedAgents")}
            value={
              profile.installedAgents.map((agent) => agent.name).join(", ") ||
              "—"
            }
          />
          <Detail
            className="sm:col-span-2 lg:col-span-3"
            label={t("acceptedCertificates")}
            value={profile.certificateSha1s.join(", ") || "—"}
            mono
          />
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="flex items-center gap-2">
            <Smartphone /> {t("provisionedDevices")}
          </CardTitle>
          <CardDescription>
            {t("provisionedDevicesDescription", {
              count: provisionedDevices.length,
            })}
          </CardDescription>
        </CardHeader>
        {profile.deviceUdids.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {profile.deviceCount > 0
              ? t("deviceListPendingRefresh")
              : t("noProvisionedDevices")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("device")}</TableHead>
                <TableHead>{t("udid")}</TableHead>
                <TableHead>{t("status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {provisionedDevices.map((device, index) => (
                <TableRow key={`${device.udid}:${index}`}>
                  <TableCell>
                    {device.deviceId && device.displayName ? (
                      <Link
                        className="font-medium hover:underline"
                        href={`/devices/${device.deviceId}`}
                      >
                        {device.displayName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("unknownDevice")}
                      </span>
                    )}
                    {(device.product || device.osVersion) && (
                      <p className="text-xs text-muted-foreground">
                        {[device.product, device.osVersion]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {device.udid}
                  </TableCell>
                  <TableCell>
                    {device.status ? (
                      <Badge variant="secondary">{device.status}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </section>
  );
}

function Detail({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={mono ? "break-all font-mono text-xs" : "mt-1"}>{value}</p>
    </div>
  );
}
