"use client";

import {
  BUILD_EXPORT_METHODS,
  EXPORT_METHOD_PROFILE_TYPES,
  profileCoversBundle,
  type ArchiveBundle,
  type BuildExportMethod,
  type SigningIdentity,
  type SigningProfile,
  type SigningTeam,
} from "@ai-development-environment/agent-contract/builds";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type SigningOptions = {
  teams: SigningTeam[];
  identities: SigningIdentity[];
  profiles: SigningProfile[];
  bundles: ArchiveBundle[];
};

const SIGNING_OPTIONS_QUERY = `query BuildSigningOptions($buildId: ID!) {
  buildSigningOptions(buildId: $buildId) {
    teams { id name }
    identities { sha1 name teamId }
    profiles {
      uuid name teamId teamName bundleId type platforms expiresAt expired xcodeManaged
    }
    bundles { bundleId name relativePath embeddedProfileUuid embeddedProfileName }
  }
}`;

/** The platform an iOS archive's profiles must cover. */
const ARCHIVE_PLATFORM = "iOS";

function coversPlatform(profile: SigningProfile): boolean {
  return (
    profile.platforms.length === 0 ||
    profile.platforms.includes(ARCHIVE_PLATFORM)
  );
}

/**
 * Profiles that can actually sign a bundle for the chosen distribution method.
 * Bundle identifier alone is not enough: the same identifier is commonly reused
 * across iOS, tvOS, and Catalyst, and only the platform distinguishes them.
 */
function candidatesFor(
  profiles: SigningProfile[],
  bundleId: string,
  method: BuildExportMethod,
  team: string,
): SigningProfile[] {
  const type = EXPORT_METHOD_PROFILE_TYPES[method];
  return profiles.filter(
    (profile) =>
      profile.type === type &&
      !profile.expired &&
      coversPlatform(profile) &&
      profileCoversBundle(profile.bundleId, bundleId) &&
      (!team || !profile.teamId || profile.teamId === team),
  );
}

function bestProfile(
  candidates: SigningProfile[],
  bundle: ArchiveBundle,
): SigningProfile | null {
  if (!candidates.length) return null;
  // Prefer what actually signed the archive when it still fits the method.
  const embedded = candidates.find(
    (profile) => profile.uuid === bundle.embeddedProfileUuid,
  );
  if (embedded) return embedded;
  // Otherwise the profile that stays valid longest, so a re-export does not
  // silently pick one that is about to lapse.
  return [...candidates].sort((left, right) =>
    (right.expiresAt ?? "").localeCompare(left.expiresAt ?? ""),
  )[0]!;
}

function profileLabel(profile: SigningProfile): string {
  const expiry = profile.expiresAt
    ? new Date(profile.expiresAt).toLocaleDateString()
    : null;
  return expiry ? `${profile.name} — ${expiry}` : profile.name;
}

export function ExportArchiveDialog({
  buildId,
  open,
  onOpenChange,
  onSaved,
}: {
  buildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("builds");
  const [method, setMethod] = useState<BuildExportMethod>("DEBUGGING");
  const [signingStyle, setSigningStyle] = useState("AUTOMATIC");
  const [teamId, setTeamId] = useState("");
  // Only what the user picked explicitly. Everything else is derived, so a
  // change of method or team can never leave a stale profile selected.
  const [certificateOverride, setCertificateOverride] = useState("");
  const [profileOverrides, setProfileOverrides] = useState<
    Record<string, string>
  >({});
  const [showAllProfiles, setShowAllProfiles] = useState(false);
  const [options, setOptions] = useState<SigningOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setOptionsError(null);
    try {
      const data = await controlPlaneRequest<{
        buildSigningOptions: SigningOptions;
      }>(SIGNING_OPTIONS_QUERY, { buildId });
      setOptions(data.buildSigningOptions);
      // Default the team to whatever signed the archive, which is the team the
      // project is already configured for.
      const embedded = data.buildSigningOptions.bundles
        .map((bundle) =>
          data.buildSigningOptions.profiles.find(
            (profile) => profile.uuid === bundle.embeddedProfileUuid,
          ),
        )
        .find((profile) => profile?.teamId);
      if (embedded?.teamId) setTeamId(embedded.teamId);
      else if (data.buildSigningOptions.teams.length === 1) {
        setTeamId(data.buildSigningOptions.teams[0]!.id);
      }
    } catch (value) {
      setOptionsError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [buildId]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);

  // Method and team constrain which profiles and certificates are valid, so an
  // explicit pick is dropped when either changes. Adjusting during render rather
  // than in an effect avoids a pass where the selection is briefly invalid.
  const selectionKey = `${method}:${teamId}`;
  const [lastSelectionKey, setLastSelectionKey] = useState(selectionKey);
  if (selectionKey !== lastSelectionKey) {
    setLastSelectionKey(selectionKey);
    setProfileOverrides({});
    setCertificateOverride("");
  }

  const manual = signingStyle === "MANUAL";
  const identities = (options?.identities ?? []).filter(
    (identity) => !teamId || !identity.teamId || identity.teamId === teamId,
  );
  const certificate = identities.some(
    (identity) => identity.sha1 === certificateOverride,
  )
    ? certificateOverride
    : "";

  const profiles = Object.fromEntries(
    (options?.bundles ?? []).flatMap((bundle) => {
      const candidates = candidatesFor(
        options?.profiles ?? [],
        bundle.bundleId,
        method,
        teamId,
      );
      const chosen =
        profileOverrides[bundle.bundleId] ??
        bestProfile(candidates, bundle)?.uuid;
      return chosen ? [[bundle.bundleId, chosen] as const] : [];
    }),
  );

  const submit = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ExportArchive($input: ExportBuildArchiveInput!) {
          exportBuildArchive(input: $input) { id status }
        }`,
        {
          input: {
            buildId,
            requestId: createClientId(),
            settings: {
              method,
              signingStyle,
              teamId: teamId || null,
              signingCertificate: certificate
                ? (identities.find((i) => i.sha1 === certificate)?.name ?? null)
                : null,
              // xcodebuild accepts a name or a UUID here; names repeat across
              // re-downloaded profiles, so the UUID is the only stable choice.
              provisioningProfiles: manual ? profiles : {},
              uploadSymbols: true,
              manageAppVersionAndBuildNumber: true,
              testFlightInternalTestingOnly: false,
            },
          },
        },
      );
      await onSaved();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const missingProfiles =
    manual &&
    (options?.bundles ?? []).some((bundle) => !profiles[bundle.bundleId]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("exportArchive")}</DialogTitle>
          <DialogDescription>{t("exportArchiveDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {optionsError && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("signingOptionsFailed")} {optionsError}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("distributionMethod")}</Label>
            <Select
              onValueChange={(value) => setMethod(value as BuildExportMethod)}
              value={method}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUILD_EXPORT_METHODS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`exportMethod.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("developmentTeam")}</Label>
            <Select
              disabled={loading || !options?.teams.length}
              onValueChange={setTeamId}
              value={teamId}
            >
              <SelectTrigger>
                {loading ? (
                  <Spinner />
                ) : (
                  <SelectValue placeholder={t("selectTeam")} />
                )}
              </SelectTrigger>
              <SelectContent>
                {(options?.teams ?? []).map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name} ({team.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!loading && options && !options.teams.length && (
              <p className="text-xs text-muted-foreground">{t("noTeams")}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>{t("signingStyle")}</Label>
            <Select onValueChange={setSigningStyle} value={signingStyle}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTOMATIC">{t("automatic")}</SelectItem>
                <SelectItem value="MANUAL">{t("manual")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {manual && (
            <>
              <div className="space-y-2">
                <Label>{t("signingCertificate")}</Label>
                <Select
                  disabled={loading || !identities.length}
                  onValueChange={setCertificateOverride}
                  value={certificate}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("certificateAutomatic")} />
                  </SelectTrigger>
                  <SelectContent>
                    {identities.map((identity) => (
                      <SelectItem key={identity.sha1} value={identity.sha1}>
                        {identity.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{t("provisioningProfiles")}</Label>
                  <Button
                    onClick={() => setShowAllProfiles((value) => !value)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {showAllProfiles ? t("showMatching") : t("showAllProfiles")}
                  </Button>
                </div>
                {loading && <Spinner />}
                {!loading && !options?.bundles.length && (
                  <p className="text-xs text-muted-foreground">
                    {t("noArchiveBundles")}
                  </p>
                )}
                {(options?.bundles ?? []).map((bundle) => {
                  const matching = candidatesFor(
                    options?.profiles ?? [],
                    bundle.bundleId,
                    method,
                    teamId,
                  );
                  const listed = showAllProfiles
                    ? (options?.profiles ?? []).filter((profile) =>
                        profileCoversBundle(profile.bundleId, bundle.bundleId),
                      )
                    : matching;
                  return (
                    <div
                      className="rounded-lg border p-2"
                      key={bundle.bundleId}
                    >
                      <p className="text-sm font-medium">{bundle.name}</p>
                      <p className="mb-2 break-all font-mono text-xs text-muted-foreground">
                        {bundle.bundleId}
                      </p>
                      <Select
                        onValueChange={(value) =>
                          setProfileOverrides((current) => ({
                            ...current,
                            [bundle.bundleId]: value,
                          }))
                        }
                        value={profiles[bundle.bundleId] ?? ""}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("selectProfile")} />
                        </SelectTrigger>
                        <SelectContent>
                          {listed.map((profile) => (
                            <SelectItem key={profile.uuid} value={profile.uuid}>
                              {profileLabel(profile)}
                              {profile.expired
                                ? ` (${t("profileExpired")})`
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!matching.length && (
                        <p className="mt-1 text-xs text-destructive">
                          {t("noMatchingProfiles")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || missingProfiles}
            onClick={() => void submit()}
          >
            {busy && <Spinner />} {t("exportArchive")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
