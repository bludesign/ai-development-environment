"use client";

import {
  ANDROID_BUILD_JOB_KIND,
  AUTO_BUILD_READINESS_CAPABILITY,
  CLEAN_WORKTREE_BUILD_CAPABILITY,
  genericBuildDestinations,
  IOS_BUILD_JOB_KIND,
  XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
  type BuildPlatform,
} from "@ai-development-environment/agent-contract/builds";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Agent } from "@/components/agents/types";
import { BUILD_PLATFORMS, platformLabel } from "@/components/builds/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { WorktreeAutoBuild } from "./types";

type AutoBuildDestination = WorktreeAutoBuild["destinationType"];
type BuildAgent = Pick<Agent, "connectionStatus" | "capabilities">;

type Selection = Pick<
  WorktreeAutoBuild,
  "configurationId" | "platform" | "destinationType"
>;

type Configuration = { id: string; name: string; platforms: BuildPlatform[] };
type Options = {
  buildConfigurations: {
    id: string;
    name: string;
    platformConfigurations: { platform: BuildPlatform }[];
  }[];
  androidBuildConfigurations: { id: string; name: string }[];
};

const OPTIONS_QUERY = `query WorktreeAutoBuildOptions($repositoryId: ID!) {
  buildConfigurations(repositoryId: $repositoryId) {
    id name platformConfigurations { platform }
  }
  androidBuildConfigurations(repositoryId: $repositoryId) { id name }
}`;
const SAVE_MUTATION = `mutation ConfigureWorktreeAutoBuild($input: ConfigureWorktreeAutoBuildInput!) {
  configureWorktreeAutoBuild(input: $input) { worktreeId }
}`;
const DISABLE_MUTATION = `mutation CancelWorktreeAutoBuild($worktreeId: ID!) {
  cancelWorktreeAutoBuild(worktreeId: $worktreeId)
}`;

function configurations(options: Options): Configuration[] {
  return [
    ...options.buildConfigurations.map(
      ({ id, name, platformConfigurations }) => ({
        id,
        name,
        platforms: BUILD_PLATFORMS.filter((platform) =>
          (platformConfigurations.length
            ? platformConfigurations
            : [{ platform: "IOS" }]
          ).some((entry) => entry.platform === platform),
        ),
      }),
    ),
    ...options.androidBuildConfigurations.map(
      ({ id, name }): Configuration => ({
        id,
        name,
        platforms: ["ANDROID"],
      }),
    ),
  ].filter(({ platforms }) => platforms.length > 0);
}

function destinations(platform: BuildPlatform): AutoBuildDestination[] {
  return platform === "ANDROID"
    ? ["HOST"]
    : genericBuildDestinations("BUILD", [platform]).map(({ type }) => type);
}

function supportsPlatform(capabilities: string[], platform: BuildPlatform) {
  if (platform === "ANDROID")
    return capabilities.includes(ANDROID_BUILD_JOB_KIND);
  return (
    capabilities.includes(IOS_BUILD_JOB_KIND) &&
    (platform === "IOS" ||
      capabilities.includes(XCODE_MULTIPLATFORM_BUILD_CAPABILITY))
  );
}

function configurationUnavailableReason(
  agent: BuildAgent,
  worktreeAvailable: boolean,
  configured: Configuration[],
  available: Configuration[],
) {
  if (agent.connectionStatus !== "ONLINE") return "agentOffline";
  if (!worktreeAvailable) return "worktreeUnavailable";
  if (!configured.length) return "noConfigurations";
  if (
    !agent.capabilities.includes(CLEAN_WORKTREE_BUILD_CAPABILITY) ||
    !agent.capabilities.includes(AUTO_BUILD_READINESS_CAPABILITY)
  )
    return "updateAgent";
  return available.length ? null : "noCompatibleConfigurations";
}

export function WorktreeAutoBuildCard({
  agent,
  worktreeAvailable,
  worktreeId,
  repositoryId,
  repositorySettingsVersion,
  lastCheckedAt,
  rule,
  onRuleChanged,
}: {
  agent: BuildAgent;
  worktreeAvailable: boolean;
  worktreeId: string;
  repositoryId: string;
  repositorySettingsVersion: number;
  lastCheckedAt: string | null;
  rule: WorktreeAutoBuild | null;
  onRuleChanged: () => Promise<void>;
}) {
  const t = useTranslations("worktreeAutoBuild");
  const [options, setOptions] = useState<Options>();
  const [draft, setDraft] = useState<Selection | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void controlPlaneRequest<Options>(
      OPTIONS_QUERY,
      { repositoryId },
      { signal: controller.signal },
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        setOptions(result);
        setReadingError(null);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setReadingError(String(error));
      },
    );
    return () => controller.abort();
  }, [
    repositoryId,
    repositorySettingsVersion,
    lastCheckedAt,
    rule?.configurationId,
    reload,
  ]);

  if (!options && !readingError && !rule) return null;
  const configured = options ? configurations(options) : [];
  const available = configured
    .map((configuration) => ({
      ...configuration,
      platforms: configuration.platforms.filter((platform) =>
        supportsPlatform(agent.capabilities, platform),
      ),
    }))
    .filter(({ platforms }) => platforms.length > 0);
  const unavailableReason = configurationUnavailableReason(
    agent,
    worktreeAvailable,
    configured,
    available,
  );
  const selected = available.find(({ id }) => id === draft?.configurationId);
  const canSave =
    !unavailableReason && draft && selected?.platforms.includes(draft.platform);
  const currentConfiguration = configured.find(
    ({ id }) => id === rule?.configurationId,
  );
  const destinationLabel = (type: AutoBuildDestination) => t(type);

  function selectConfiguration(id: string) {
    const configuration = available.find((item) => item.id === id);
    const platform = configuration?.platforms[0];
    if (!platform) return;
    setDraft({
      configurationId: id,
      platform,
      destinationType: destinations(platform)[0],
    });
  }

  async function save() {
    if (!draft || !canSave) return;
    setBusy(true);
    setSavingError(null);
    try {
      await controlPlaneRequest(SAVE_MUTATION, {
        input: { worktreeId, ...draft },
      });
      await onRuleChanged();
      setDraft(null);
    } catch (error) {
      setSavingError(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setSavingError(null);
    try {
      await controlPlaneRequest(DISABLE_MUTATION, { worktreeId });
      await onRuleChanged();
    } catch (error) {
      setSavingError(String(error));
    } finally {
      setBusy(false);
    }
  }

  function configure() {
    setSavingError(null);
    if (
      rule &&
      available.some(
        ({ id, platforms }) =>
          id === rule.configurationId && platforms.includes(rule.platform),
      )
    ) {
      const { configurationId, platform, destinationType } = rule;
      setDraft({ configurationId, platform, destinationType });
    } else if (available[0]) {
      selectConfiguration(available[0].id);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("title")}
          {rule && <Badge variant="secondary">{t("enabled")}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rule && (
          <>
            <p className="text-sm">
              {options && (
                <>
                  {currentConfiguration?.name ?? t("missingConfiguration")}{" "}
                  ·{" "}
                </>
              )}
              {platformLabel(rule.platform)} ·{" "}
              {destinationLabel(rule.destinationType)}
            </p>
            {rule.lastQueuedBuildId && (
              <p className="text-sm">
                <Link
                  className="text-primary hover:underline"
                  href={`/dashboard/builds/${rule.lastQueuedBuildId}`}
                >
                  {t("lastQueuedBuild")}
                  {rule.lastQueuedHeadSha && (
                    <span className="ml-2 font-mono">
                      {rule.lastQueuedHeadSha.slice(0, 8)}
                    </span>
                  )}
                </Link>
              </p>
            )}
          </>
        )}
        {options && (!rule || unavailableReason) && (
          <p className="text-sm text-muted-foreground">
            {t(unavailableReason ?? "description")}
          </p>
        )}
        {(readingError || rule?.lastError || (!draft && savingError)) && (
          <Alert variant="destructive">
            <AlertDescription>
              {readingError ?? rule?.lastError ?? savingError}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {!unavailableReason && (
            <Button variant="outline" disabled={busy} onClick={configure}>
              {t("configure")}
            </Button>
          )}
          {rule && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void disable()}
            >
              {t("disable")}
            </Button>
          )}
          {readingError && (
            <Button
              variant="outline"
              onClick={() => setReload((value) => value + 1)}
            >
              {t("retry")}
            </Button>
          )}
        </div>
        <Dialog
          open={draft !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setDraft(null);
          }}
        >
          {draft && (
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("configure")}</DialogTitle>
                <DialogDescription>
                  {t(unavailableReason ?? "description")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="auto-build-configuration">
                    {t("configuration")}
                  </Label>
                  <Select
                    disabled={busy}
                    value={draft.configurationId}
                    onValueChange={selectConfiguration}
                  >
                    <SelectTrigger
                      id="auto-build-configuration"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map(({ id, name }) => (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="auto-build-platform">{t("platform")}</Label>
                  <Select
                    disabled={busy}
                    value={draft.platform}
                    onValueChange={(value) => {
                      const platform = selected?.platforms.find(
                        (entry) => entry === value,
                      );
                      if (platform)
                        setDraft({
                          ...draft,
                          platform,
                          destinationType: destinations(platform)[0],
                        });
                    }}
                  >
                    <SelectTrigger id="auto-build-platform" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {selected?.platforms.map((platform) => (
                        <SelectItem key={platform} value={platform}>
                          {platformLabel(platform)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="auto-build-destination">
                    {t("destination")}
                  </Label>
                  <Select
                    disabled={busy}
                    value={draft.destinationType}
                    onValueChange={(value) => {
                      const destinationType = destinations(draft.platform).find(
                        (type) => type === value,
                      );
                      if (destinationType)
                        setDraft({ ...draft, destinationType });
                    }}
                  >
                    <SelectTrigger
                      id="auto-build-destination"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {destinations(draft.platform).map((type) => (
                        <SelectItem key={type} value={type}>
                          {destinationLabel(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {savingError && (
                  <Alert variant="destructive">
                    <AlertDescription>{savingError}</AlertDescription>
                  </Alert>
                )}
              </div>
              <DialogFooter>
                <Button disabled={busy || !canSave} onClick={() => void save()}>
                  {t(rule ? "save" : "enable")}
                </Button>
              </DialogFooter>
            </DialogContent>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}
