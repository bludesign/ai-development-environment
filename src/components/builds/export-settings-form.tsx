"use client";

import {
  BUILD_EXPORT_METHODS,
  EXPORT_METHOD_PROFILE_TYPES,
  profileCoversBundle,
  type BuildSigningRequirement,
} from "@ai-development-environment/agent-contract/builds";
import { Plus, ScanSearch, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

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

function profileSupportsPlatform(
  profilePlatforms: string[],
  requirementPlatform: string | null,
): boolean {
  if (!requirementPlatform || profilePlatforms.length === 0) return true;
  const aliases =
    requirementPlatform === "watchOS"
      ? ["watchOS", "iOS"]
      : requirementPlatform === "visionOS"
        ? ["visionOS", "xrOS"]
        : [requirementPlatform];
  return aliases.some((platform) => profilePlatforms.includes(platform));
}

export function ExportSettingsForm({
  value,
  onChange,
  onParseSigningRequirements,
  disabled = false,
}: {
  value: ExportSettingsValue;
  onChange: (value: ExportSettingsValue) => void;
  onParseSigningRequirements?: () => Promise<BuildSigningRequirement[]>;
  disabled?: boolean;
}) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [requirements, setRequirements] = useState<BuildSigningRequirement[]>(
    () =>
      Object.keys(value.provisioningProfiles).map((bundleId) => ({
        bundleId,
        name: bundleId,
        target: bundleId,
        platform: null,
        teamId: null,
        provisioningProfileSpecifier: null,
      })),
  );
  const [requirementsParsed, setRequirementsParsed] = useState(false);
  const [parsingRequirements, setParsingRequirements] = useState(false);
  const [requirementsError, setRequirementsError] = useState<string | null>(
    null,
  );
  const [manualBundleId, setManualBundleId] = useState("");
  const [manualBundleIds, setManualBundleIds] = useState<Set<string>>(
    () => new Set(Object.keys(value.provisioningProfiles)),
  );
  const manualBundleInputId = useId();
  const [inventory, setInventory] = useState<{
    agentCount: number;
    certificates: Array<{
      sha1: string;
      name: string;
      teamId: string | null;
      hasPrivateKey: boolean;
      installedAgents: Array<{ id: string }>;
    }>;
    profiles: Array<{
      uuid: string;
      name: string;
      profileType: string;
      bundleId: string;
      teamId: string | null;
      platforms: string[];
      expiresAt: string | null;
      expired: boolean;
      certificateSha1s: string[];
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
      signingProfiles: Array<{
        uuid: string;
        name: string;
        profileType: string;
        bundleId: string;
        teamId: string | null;
        platforms: string[];
        expiresAt: string | null;
        expired: boolean;
        certificateSha1s: string[];
        installedAgents: Array<{ id: string }>;
      }>;
    }>(`query ExportSigningInventory {
      signingAgents { supported }
      signingCertificates { sha1 name teamId hasPrivateKey installedAgents { id } }
      signingProfiles {
        uuid name profileType bundleId teamId platforms expiresAt expired
        certificateSha1s installedAgents { id }
      }
    }`)
      .then((data) => {
        if (!disposed) {
          setInventory({
            agentCount: data.signingAgents.filter((agent) => agent.supported)
              .length,
            certificates: data.signingCertificates,
            profiles: data.signingProfiles,
          });
        }
      })
      .catch(() => {
        if (!disposed) {
          setInventory({ agentCount: 0, certificates: [], profiles: [] });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);
  const teams = useMemo(
    () => [
      ...new Set(
        [
          ...(inventory?.certificates ?? []),
          ...(inventory?.profiles ?? []),
        ].flatMap((item) => item.teamId ?? []),
      ),
    ],
    [inventory],
  );
  const selectedCertificate = inventory?.certificates.find(
    (certificate) => certificate.sha1 === value.signingCertificate,
  );
  const selectedProfileIds = Object.values(value.provisioningProfiles);
  const selectedProfiles = selectedProfileIds.flatMap((uuid) => {
    const profile = inventory?.profiles.find((entry) => entry.uuid === uuid);
    return profile ? [profile] : [];
  });
  const knowsAcceptedCertificates =
    selectedProfileIds.length > 0 &&
    selectedProfiles.length === selectedProfileIds.length &&
    selectedProfiles.every((profile) => profile.certificateSha1s.length > 0);
  const certificateIsRecommended = (
    certificate: NonNullable<typeof inventory>["certificates"][number],
  ) =>
    knowsAcceptedCertificates
      ? selectedProfiles.every((profile) =>
          profile.certificateSha1s
            .map((sha1) => sha1.toUpperCase())
            .includes(certificate.sha1.toUpperCase()),
        )
      : !value.teamId || certificate.teamId === value.teamId;
  const availableCertificates = (inventory?.certificates ?? [])
    .filter((certificate) => certificate.hasPrivateKey)
    .sort((left, right) => {
      const recommendationOrder =
        Number(certificateIsRecommended(right)) -
        Number(certificateIsRecommended(left));
      return recommendationOrder || left.name.localeCompare(right.name);
    });
  const selectedCertificateAvailable = availableCertificates.some(
    (certificate) => certificate.sha1 === value.signingCertificate,
  );
  const update = <K extends keyof ExportSettingsValue>(
    key: K,
    next: ExportSettingsValue[K],
  ) => onChange({ ...value, [key]: next });

  const matchingProfiles = (
    requirement: BuildSigningRequirement,
    teamId = value.teamId,
  ) =>
    (inventory?.profiles ?? [])
      .filter(
        (profile) =>
          profile.profileType === EXPORT_METHOD_PROFILE_TYPES[value.method] &&
          !profile.expired &&
          profileCoversBundle(profile.bundleId, requirement.bundleId) &&
          profileSupportsPlatform(profile.platforms, requirement.platform) &&
          (!teamId || !profile.teamId || profile.teamId === teamId),
      )
      .sort((left, right) =>
        (right.expiresAt ?? "").localeCompare(left.expiresAt ?? ""),
      );

  const selectableProfiles = (requirement: BuildSigningRequirement) => {
    const recommendedIds = new Set(
      matchingProfiles(requirement).map((profile) => profile.uuid),
    );
    return (inventory?.profiles ?? [])
      .filter((profile) => !profile.expired)
      .sort((left, right) => {
        const recommendationOrder =
          Number(recommendedIds.has(right.uuid)) -
          Number(recommendedIds.has(left.uuid));
        return (
          recommendationOrder ||
          (right.expiresAt ?? "").localeCompare(left.expiresAt ?? "") ||
          left.name.localeCompare(right.name)
        );
      });
  };

  const addManualBundleId = () => {
    const bundleId = manualBundleId.trim();
    if (
      !bundleId ||
      requirements.some((requirement) => requirement.bundleId === bundleId)
    ) {
      return;
    }
    setRequirements((current) => [
      ...current,
      {
        bundleId,
        name: bundleId,
        target: bundleId,
        platform: null,
        teamId: value.teamId,
        provisioningProfileSpecifier: null,
      },
    ]);
    setManualBundleIds((current) => new Set(current).add(bundleId));
    setManualBundleId("");
  };

  const removeManualBundleId = (bundleId: string) => {
    setRequirements((current) =>
      current.filter((requirement) => requirement.bundleId !== bundleId),
    );
    setManualBundleIds((current) => {
      const next = new Set(current);
      next.delete(bundleId);
      return next;
    });
    const provisioningProfiles = { ...value.provisioningProfiles };
    delete provisioningProfiles[bundleId];
    update("provisioningProfiles", provisioningProfiles);
  };

  const parseRequirements = async () => {
    if (!onParseSigningRequirements) return;
    setParsingRequirements(true);
    setRequirementsError(null);
    try {
      const parsed = await onParseSigningRequirements();
      const parsedBundleIds = new Set(
        parsed.map((requirement) => requirement.bundleId),
      );
      const preservedManualRequirements = requirements.filter(
        (requirement) =>
          manualBundleIds.has(requirement.bundleId) &&
          !parsedBundleIds.has(requirement.bundleId),
      );
      const mergedRequirements = [...parsed, ...preservedManualRequirements];
      setRequirements(mergedRequirements);
      setManualBundleIds(
        (current) =>
          new Set(
            [...current].filter((bundleId) => !parsedBundleIds.has(bundleId)),
          ),
      );
      setRequirementsParsed(true);
      const parsedTeams = [
        ...new Set(parsed.flatMap((requirement) => requirement.teamId ?? [])),
      ];
      const nextTeamId =
        value.teamId ?? (parsedTeams.length === 1 ? parsedTeams[0]! : null);
      const provisioningProfiles = Object.fromEntries(
        mergedRequirements.flatMap((requirement) => {
          const candidates = matchingProfiles(requirement, nextTeamId);
          const existing = value.provisioningProfiles[requirement.bundleId];
          const configured = requirement.provisioningProfileSpecifier;
          const selected =
            (existing
              ? (inventory?.profiles.find(
                  (profile) => profile.uuid === existing && !profile.expired,
                ) ?? existing)
              : null) ??
            candidates.find(
              (profile) =>
                profile.uuid === configured || profile.name === configured,
            ) ??
            candidates[0];
          return selected
            ? ([
                [
                  requirement.bundleId,
                  typeof selected === "string" ? selected : selected.uuid,
                ],
              ] as const)
            : [];
        }),
      );
      onChange({
        ...value,
        teamId: nextTeamId,
        provisioningProfiles,
      });
    } catch (error) {
      setRequirementsError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setParsingRequirements(false);
    }
  };

  const profileLabel = (
    profile: NonNullable<typeof inventory>["profiles"][number],
  ) => {
    const expiry = profile.expiresAt
      ? formatDateValue(profile.expiresAt, "short", { locale, showTime: false })
      : null;
    return expiry ? `${profile.name} — ${expiry}` : profile.name;
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-xl border p-4 sm:grid-cols-2">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:col-span-2 sm:grid-cols-3">
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
              update(
                "signingStyle",
                next as ExportSettingsValue["signingStyle"],
              )
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
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("signingCertificate")}</Label>
        {inventory?.certificates.length ? (
          <Select
            disabled={disabled}
            onValueChange={(next) =>
              update("signingCertificate", next === "AUTOMATIC" ? null : next)
            }
            value={value.signingCertificate ?? "AUTOMATIC"}
          >
            <SelectTrigger className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AUTOMATIC">
                {t("certificateAutomatic")}
              </SelectItem>
              {value.signingCertificate && !selectedCertificateAvailable && (
                <SelectItem value={value.signingCertificate}>
                  {value.signingCertificate} · {t("savedValueUnavailable")}
                </SelectItem>
              )}
              {availableCertificates.map((certificate) => (
                <SelectItem
                  className={
                    certificateIsRecommended(certificate)
                      ? undefined
                      : "text-muted-foreground"
                  }
                  key={certificate.sha1}
                  value={certificate.sha1}
                >
                  {certificate.name} · {certificate.sha1.slice(0, 10)}…
                  {!certificateIsRecommended(certificate) &&
                    ` · ${t("certificateMayNotMatch")}`}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Label>{t("provisioningProfiles")}</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("parseProvisioningProfilesHelp")}
              </p>
            </div>
            {onParseSigningRequirements && (
              <Button
                disabled={disabled || parsingRequirements || !inventory}
                onClick={() => void parseRequirements()}
                size="sm"
                type="button"
                variant="outline"
              >
                {parsingRequirements ? <Spinner /> : <ScanSearch />}
                {t(
                  requirementsParsed
                    ? "reparseProvisioningProfiles"
                    : "parseProvisioningProfiles",
                )}
              </Button>
            )}
          </div>
          <div className="grid gap-2 rounded-lg border border-dashed p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <Label htmlFor={manualBundleInputId}>
                {t("manualBundleIdentifier")}
              </Label>
              <Input
                disabled={disabled}
                id={manualBundleInputId}
                onChange={(event) => setManualBundleId(event.target.value)}
                placeholder={t("manualBundleIdentifierPlaceholder")}
                value={manualBundleId}
              />
              <p className="text-xs text-muted-foreground">
                {t("manualBundleIdentifierHelp")}
              </p>
            </div>
            <Button
              className="sm:self-end"
              disabled={
                disabled ||
                !manualBundleId.trim() ||
                requirements.some(
                  (requirement) =>
                    requirement.bundleId === manualBundleId.trim(),
                )
              }
              onClick={addManualBundleId}
              type="button"
              variant="outline"
            >
              <Plus />
              {t("addBundleIdentifier")}
            </Button>
          </div>
          {requirementsError && (
            <Alert variant="destructive">
              <AlertDescription>{requirementsError}</AlertDescription>
            </Alert>
          )}
          {!requirements.length && requirementsParsed && (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {t("noSigningRequirements")}
            </p>
          )}
          {!requirements.length && !requirementsParsed && (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {t("parseProvisioningProfilesEmpty")}
            </p>
          )}
          {requirements.map((requirement) => {
            const candidates = matchingProfiles(requirement);
            const candidateIds = new Set(
              candidates.map((profile) => profile.uuid),
            );
            const profiles = selectableProfiles(requirement);
            const selected =
              value.provisioningProfiles[requirement.bundleId] ?? "";
            const selectedAvailable = profiles.some(
              (profile) => profile.uuid === selected,
            );
            return (
              <div className="rounded-lg border p-3" key={requirement.bundleId}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{requirement.name}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {requirement.bundleId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        requirement.target,
                        requirement.platform,
                        requirement.teamId,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {manualBundleIds.has(requirement.bundleId) && (
                    <Button
                      aria-label={t("removeBundleIdentifier", {
                        bundleId: requirement.bundleId,
                      })}
                      disabled={disabled}
                      onClick={() => removeManualBundleId(requirement.bundleId)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
                <Select
                  disabled={disabled || !inventory}
                  onValueChange={(profileId) =>
                    update("provisioningProfiles", {
                      ...value.provisioningProfiles,
                      [requirement.bundleId]: profileId,
                    })
                  }
                  value={selected}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue placeholder={t("selectProfile")} />
                  </SelectTrigger>
                  <SelectContent>
                    {selected && !selectedAvailable && (
                      <SelectItem value={selected}>
                        {selected} · {t("savedValueUnavailable")}
                      </SelectItem>
                    )}
                    {profiles.map((profile) => (
                      <SelectItem
                        className={
                          candidateIds.has(profile.uuid)
                            ? undefined
                            : "text-muted-foreground"
                        }
                        key={profile.uuid}
                        value={profile.uuid}
                      >
                        {profileLabel(profile)}
                        {!candidateIds.has(profile.uuid) &&
                          ` · ${t("profileMayNotMatch")}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!candidates.length && (
                  <p className="mt-1 text-xs text-destructive">
                    {t("noMatchingProfiles")}
                  </p>
                )}
              </div>
            );
          })}
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
