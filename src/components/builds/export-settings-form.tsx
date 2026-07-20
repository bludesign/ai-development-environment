"use client";

import { BUILD_EXPORT_METHODS } from "@ai-development-environment/agent-contract/builds";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";

export type ExportSettingsValue = {
  method: "DEBUGGING" | "RELEASE_TESTING" | "ENTERPRISE" | "APP_STORE_CONNECT";
  signingStyle: "AUTOMATIC" | "MANUAL";
  teamId: string | null;
  signingCertificate: string | null;
  provisioningProfiles: Record<string, string>;
  uploadSymbols: boolean;
  manageAppVersionAndBuildNumber: boolean;
  testFlightInternalTestingOnly: boolean;
  stripSwiftSymbols: boolean;
  thinning: string | null;
  iCloudContainerEnvironment: "Development" | "Production" | null;
  distributionBundleIdentifier: string | null;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettingsValue = {
  method: "DEBUGGING",
  signingStyle: "AUTOMATIC",
  teamId: null,
  signingCertificate: null,
  provisioningProfiles: {},
  uploadSymbols: true,
  manageAppVersionAndBuildNumber: true,
  testFlightInternalTestingOnly: false,
  stripSwiftSymbols: true,
  thinning: null,
  iCloudContainerEnvironment: null,
  distributionBundleIdentifier: null,
};

export function ExportSettingsForm({
  value,
  onChange,
  disabled = false,
}: {
  value: ExportSettingsValue;
  onChange: (value: ExportSettingsValue) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("builds");
  const [inventory, setInventory] = useState<{
    agentCount: number;
    certificates: Array<{
      sha1: string;
      name: string;
      teamId: string | null;
      hasPrivateKey: boolean;
      installedAgents: Array<{ id: string }>;
    }>;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<{
      signingAgents: Array<{ supported: boolean }>;
      signingCertificates: Array<{
        sha1: string;
        name: string;
        teamId: string | null;
        hasPrivateKey: boolean;
        installedAgents: Array<{ id: string }>;
      }>;
    }>(`query ExportSigningInventory {
      signingAgents { supported }
      signingCertificates { sha1 name teamId hasPrivateKey installedAgents { id } }
    }`)
      .then((data) => {
        if (!disposed) {
          setInventory({
            agentCount: data.signingAgents.filter((agent) => agent.supported)
              .length,
            certificates: data.signingCertificates,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);
  const teams = useMemo(
    () => [
      ...new Set(inventory?.certificates.flatMap((item) => item.teamId ?? [])),
    ],
    [inventory],
  );
  const selectedCertificate = inventory?.certificates.find(
    (certificate) => certificate.sha1 === value.signingCertificate,
  );
  const update = <K extends keyof ExportSettingsValue>(
    key: K,
    next: ExportSettingsValue[K],
  ) => onChange({ ...value, [key]: next });
  return (
    <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>{t("distributionMethod")}</Label>
        <Select
          disabled={disabled}
          onValueChange={(next) =>
            update("method", next as ExportSettingsValue["method"])
          }
          value={value.method}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUILD_EXPORT_METHODS.map((method) => (
              <SelectItem key={method} value={method}>
                {t(`exportMethod.${method}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>{t("signingStyle")}</Label>
        <Select
          disabled={disabled}
          onValueChange={(next) =>
            update("signingStyle", next as ExportSettingsValue["signingStyle"])
          }
          value={value.signingStyle}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AUTOMATIC">{t("automatic")}</SelectItem>
            <SelectItem value="MANUAL">{t("manual")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>{t("developmentTeam")}</Label>
        {teams.length ? (
          <Select
            disabled={disabled}
            onValueChange={(next) => update("teamId", next)}
            value={value.teamId ?? ""}
          >
            <SelectTrigger>
              <SelectValue placeholder="ABCDE12345" />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team} value={team}>
                  {team}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            disabled={disabled}
            onChange={(event) => update("teamId", event.target.value || null)}
            placeholder="ABCDE12345"
            value={value.teamId ?? ""}
          />
        )}
      </div>
      <div className="space-y-2">
        <Label>{t("signingCertificate")}</Label>
        {inventory?.certificates.length ? (
          <Select
            disabled={disabled}
            onValueChange={(next) =>
              update("signingCertificate", next === "AUTOMATIC" ? null : next)
            }
            value={value.signingCertificate ?? "AUTOMATIC"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AUTOMATIC">
                {t("certificateAutomatic")}
              </SelectItem>
              {inventory.certificates
                .filter(
                  (certificate) =>
                    certificate.hasPrivateKey &&
                    (!value.teamId || certificate.teamId === value.teamId),
                )
                .map((certificate) => (
                  <SelectItem key={certificate.sha1} value={certificate.sha1}>
                    {certificate.name} · {certificate.sha1.slice(0, 10)}…
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            disabled={disabled}
            onChange={(event) =>
              update("signingCertificate", event.target.value || null)
            }
            placeholder={t("certificateAutomatic")}
            value={value.signingCertificate ?? ""}
          />
        )}
      </div>
      {selectedCertificate &&
        inventory &&
        selectedCertificate.installedAgents.length < inventory.agentCount && (
          <Alert className="sm:col-span-2">
            <AlertDescription>
              {t("signingAssetCoverageWarning", {
                installed: selectedCertificate.installedAgents.length,
                total: inventory.agentCount,
              })}
            </AlertDescription>
          </Alert>
        )}
      {value.signingStyle === "MANUAL" && (
        <div className="space-y-2 sm:col-span-2">
          <Label>{t("provisioningProfiles")}</Label>
          <Textarea
            className="font-mono text-xs"
            disabled={disabled}
            onChange={(event) => {
              try {
                const parsed: unknown = JSON.parse(event.target.value);
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed)
                ) {
                  update(
                    "provisioningProfiles",
                    parsed as Record<string, string>,
                  );
                }
              } catch {
                // Keep the last valid mapping while the user is typing.
              }
            }}
            rows={4}
            value={JSON.stringify(value.provisioningProfiles, null, 2)}
          />
        </div>
      )}
      <div className="space-y-2">
        <Label>{t("thinning")}</Label>
        <Input
          disabled={disabled}
          onChange={(event) => update("thinning", event.target.value || null)}
          placeholder="<none> / <thin-for-all-variants>"
          value={value.thinning ?? ""}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("iCloudEnvironment")}</Label>
        <Select
          disabled={disabled}
          onValueChange={(next) =>
            update(
              "iCloudContainerEnvironment",
              next === "NONE" ? null : (next as "Development" | "Production"),
            )
          }
          value={value.iCloudContainerEnvironment ?? "NONE"}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">—</SelectItem>
            <SelectItem value="Development">Development</SelectItem>
            <SelectItem value="Production">Production</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("distributionBundleIdentifier")}</Label>
        <Input
          disabled={disabled}
          onChange={(event) =>
            update("distributionBundleIdentifier", event.target.value || null)
          }
          value={value.distributionBundleIdentifier ?? ""}
        />
      </div>
      {(
        [
          ["uploadSymbols", "uploadSymbols"],
          ["manageAppVersionAndBuildNumber", "manageBuildNumber"],
          ["testFlightInternalTestingOnly", "internalTestFlightOnly"],
          ["stripSwiftSymbols", "stripSwiftSymbols"],
        ] as const
      ).map(([key, label]) => (
        <label className="flex items-center gap-2 text-sm" key={key}>
          <Checkbox
            checked={value[key]}
            disabled={disabled}
            onCheckedChange={(checked) => update(key, Boolean(checked))}
          />
          {t(label)}
        </label>
      ))}
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {t("localExportOnly")}
      </p>
    </div>
  );
}
