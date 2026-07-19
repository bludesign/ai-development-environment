"use client";

import { Hammer, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type {
  BuildAction,
  BuildConfiguration,
  BuildDestination,
  BuildSourceObservation,
  IosAppProject,
} from "./types";
import { ConfigurationIcon } from "./configuration-icon";

type PriorBuildForTesting = {
  id: string;
  action: BuildAction;
  destinationType: BuildDestination["type"];
  snapshot: Record<string, unknown>;
  createdAt: string;
};

const PROJECT_FIELDS = `
  id type
  configurations {
    id name iconKey scheme buildConfiguration defaultAction advancedSettings createdAt updatedAt
    source { id kind relativePath }
    observation { id scopeKey status schemes configurations testPlans error stale headSha xcodeVersion lastParseAttemptAt lastParsedAt }
  }
  allowedScripts {
    position
    script { id name preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior }
  }
`;

const OBSERVATION_FIELDS = `
  id scopeKey status schemes configurations testPlans error stale headSha xcodeVersion lastParseAttemptAt lastParsedAt
`;

const ACTIONS: BuildAction[] = [
  "BUILD",
  "TEST",
  "ANALYZE",
  "ARCHIVE",
  "BUILD_FOR_TESTING",
  "TEST_WITHOUT_BUILDING",
];

function humanizeConstant(value: string): string {
  return value
    .toLocaleLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function StartBuildButton({
  codebaseId,
  worktreeId,
  disabled,
  disabledReason,
  buildSettingsHref,
  size = "sm",
}: {
  codebaseId: string;
  worktreeId: string;
  disabled?: boolean;
  disabledReason?: string | null;
  buildSettingsHref?: string;
  size?: "sm" | "default";
}) {
  const t = useTranslations("builds");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsCloseTimer = useRef<number | null>(null);

  const cancelSettingsClose = () => {
    if (settingsCloseTimer.current !== null) {
      window.clearTimeout(settingsCloseTimer.current);
      settingsCloseTimer.current = null;
    }
  };
  const showSettings = () => {
    cancelSettingsClose();
    setSettingsOpen(true);
  };
  const scheduleSettingsClose = () => {
    cancelSettingsClose();
    settingsCloseTimer.current = window.setTimeout(
      () => setSettingsOpen(false),
      150,
    );
  };

  useEffect(
    () => () => {
      if (settingsCloseTimer.current !== null) {
        window.clearTimeout(settingsCloseTimer.current);
      }
    },
    [],
  );

  return (
    <>
      {disabled && buildSettingsHref ? (
        <Popover onOpenChange={setSettingsOpen} open={settingsOpen}>
          <PopoverAnchor asChild>
            <Button
              aria-disabled="true"
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              className="cursor-not-allowed opacity-50"
              onClick={showSettings}
              onFocus={showSettings}
              onMouseEnter={showSettings}
              onMouseLeave={scheduleSettingsClose}
              size={size}
              title={disabledReason ?? undefined}
              type="button"
            >
              <Hammer /> {t("build")}
            </Button>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            className="w-auto max-w-64 p-2 text-xs"
            onBlurCapture={scheduleSettingsClose}
            onFocusCapture={cancelSettingsClose}
            onMouseEnter={cancelSettingsClose}
            onMouseLeave={scheduleSettingsClose}
            onOpenAutoFocus={(event) => event.preventDefault()}
            side="top"
          >
            <Link
              className="font-medium underline-offset-4 hover:underline"
              href={buildSettingsHref}
            >
              {t("configureBuilds")}
            </Link>
          </PopoverContent>
        </Popover>
      ) : (
        <Button
          disabled={disabled}
          onClick={() => setOpen(true)}
          size={size}
          title={disabledReason ?? undefined}
          type="button"
        >
          <Hammer /> {t("build")}
        </Button>
      )}
      {open && (
        <StartBuildDialog
          codebaseId={codebaseId}
          onOpenChange={setOpen}
          onStarted={(id) => router.push(`/builds/${id}`)}
          open={open}
          worktreeId={worktreeId}
        />
      )}
    </>
  );
}

function StartBuildDialog({
  codebaseId,
  worktreeId,
  open,
  onOpenChange,
  onStarted,
}: {
  codebaseId: string;
  worktreeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (buildId: string) => void;
}) {
  const t = useTranslations("builds");
  const [project, setProject] = useState<IosAppProject | null>(null);
  const [priorBuilds, setPriorBuilds] = useState<PriorBuildForTesting[]>([]);
  const [configurationId, setConfigurationId] = useState("");
  const [action, setAction] = useState<BuildAction>("BUILD");
  const [observations, setObservations] = useState<
    Record<string, BuildSourceObservation>
  >({});
  const [destinations, setDestinations] = useState<BuildDestination[]>([]);
  const [destinationType, setDestinationType] =
    useState<BuildDestination["type"]>("SIMULATOR");
  const [destinationId, setDestinationId] = useState("");
  const [scriptIds, setScriptIds] = useState<Set<string>>(new Set());
  const [advanced, setAdvanced] = useState<Record<string, unknown>>({});
  const [overrides, setOverrides] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configuration = project?.configurations.find(
    (entry) => entry.id === configurationId,
  );
  const observation = configuration
    ? (observations[configuration.id] ?? configuration.observation)
    : null;

  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<{
      iosAppProject: IosAppProject | null;
      builds: { items: PriorBuildForTesting[] };
    }>(
      `query StartBuildProject($codebaseId: ID!, $worktreeId: ID!) {
        iosAppProject(codebaseId: $codebaseId) { ${PROJECT_FIELDS} }
        builds(first: 50, status: SUCCEEDED, worktreeId: $worktreeId) {
          items { id action destinationType snapshot createdAt }
        }
      }`,
      { codebaseId, worktreeId },
    )
      .then((data) => {
        if (disposed) return;
        setProject(data.iosAppProject);
        setPriorBuilds(data.builds.items);
        const first = data.iosAppProject?.configurations[0];
        if (first) {
          setConfigurationId(first.id);
          setAction(first.defaultAction);
          setAdvanced(first.advancedSettings ?? {});
          setScriptIds(
            new Set(
              data
                .iosAppProject!.allowedScripts.filter(
                  (entry) => entry.script.enabledByDefault,
                )
                .map((entry) => entry.script.id),
            ),
          );
        }
      })
      .catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      )
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [codebaseId, worktreeId]);

  const compatiblePriorBuilds = useMemo(
    () =>
      priorBuilds.filter((build) => {
        if (build.action !== "BUILD_FOR_TESTING") return false;
        if (build.destinationType !== destinationType) return false;
        const snapshotConfiguration = build.snapshot.configuration as
          | { id?: string; advancedSettings?: { testPlan?: string | null } }
          | undefined;
        const currentTestPlan =
          typeof advanced.testPlan === "string" ? advanced.testPlan : null;
        const priorTestPlan = snapshotConfiguration?.advancedSettings?.testPlan;
        return (
          snapshotConfiguration?.id === configurationId &&
          (!currentTestPlan ||
            !priorTestPlan ||
            currentTestPlan === priorTestPlan)
        );
      }),
    [advanced.testPlan, configurationId, destinationType, priorBuilds],
  );
  const selectedPriorBuildId =
    compatiblePriorBuilds.find(
      (build) => build.id === advanced.priorBuildForTestingId,
    )?.id ??
    compatiblePriorBuilds[0]?.id ??
    null;

  const prepare = async (
    selected: BuildConfiguration,
    selectedAction: BuildAction,
  ) => {
    setPreparing(true);
    setError(null);
    setDestinations([]);
    setDestinationId("");
    try {
      const data = await controlPlaneRequest<{
        inspectBuildDestinations: BuildDestination[];
      }>(
        `mutation InspectStartBuildDestinations($input: InspectBuildDestinationsInput!) {
          inspectBuildDestinations(input: $input)
        }`,
        {
          input: {
            worktreeId,
            configurationId: selected.id,
            action: selectedAction,
            requestId: createClientId(),
          },
        },
      );
      setDestinations(data.inspectBuildDestinations);
      const preferredType =
        selectedAction === "ARCHIVE"
          ? "PHYSICAL_DEVICE"
          : data.inspectBuildDestinations.some(
                (destination) => destination.type === "SIMULATOR",
              )
            ? "SIMULATOR"
            : "PHYSICAL_DEVICE";
      setDestinationType(preferredType);
      setDestinationId(
        data.inspectBuildDestinations.find(
          (destination) => destination.type === preferredType,
        )?.id ?? "",
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setPreparing(false);
    }
  };

  const reparse = async (selected: BuildConfiguration) => {
    setPreparing(true);
    setError(null);
    try {
      const parsed = await controlPlaneRequest<{
        reparseBuildConfiguration: BuildSourceObservation;
      }>(
        `mutation ReparseStartBuild($configurationId: ID!, $worktreeId: ID!, $requestId: ID!) {
          reparseBuildConfiguration(configurationId: $configurationId, worktreeId: $worktreeId, requestId: $requestId) {
            ${OBSERVATION_FIELDS}
          }
        }`,
        {
          configurationId: selected.id,
          worktreeId,
          requestId: createClientId(),
        },
      );
      const nextObservation = parsed.reparseBuildConfiguration;
      setObservations((current) => ({
        ...current,
        [selected.id]: nextObservation,
      }));
      if (nextObservation.status !== "VALID") {
        throw new Error(nextObservation.error || t("configurationInvalid"));
      }
      await prepare(selected, action);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setPreparing(false);
    }
  };

  useEffect(() => {
    if (!configuration || loading) return;
    const timer = window.setTimeout(
      () => void prepare(configuration, action),
      0,
    );
    return () => window.clearTimeout(timer);
    // Prepare only when the selected configuration/action changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationId, action, loading]);

  const filteredDestinations = useMemo(
    () =>
      destinations.filter(
        (destination) => destination.type === destinationType,
      ),
    [destinations, destinationType],
  );
  const destination = destinations.find((entry) => entry.id === destinationId);
  const preview = configuration
    ? `xcrun xcodebuild ${configuration.source.kind === "PROJECT" ? `-project ${configuration.source.relativePath}` : configuration.source.kind === "WORKSPACE" ? `-workspace ${configuration.source.relativePath}` : ""} -scheme ${JSON.stringify(configuration.scheme)} -configuration ${JSON.stringify(configuration.buildConfiguration)} -destination ${JSON.stringify(destination?.name ?? "<destination>")} -hideShellScriptEnvironment ${action.toLowerCase().replaceAll("_", "-")}${action === "TEST_WITHOUT_BUILDING" && selectedPriorBuildId ? ` · ${t("priorBuildSummary", { id: selectedPriorBuildId })}` : ""}`
    : "";

  const start = async () => {
    if (!configuration || !destination) return;
    setStarting(true);
    setError(null);
    try {
      let buildSettingOverrides: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(overrides);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error();
        }
        buildSettingOverrides = parsed as Record<string, string>;
      } catch {
        throw new Error(t("overridesInvalid"));
      }
      const data = await controlPlaneRequest<{ startBuild: { id: string } }>(
        `mutation StartIosBuild($input: StartBuildInput!) {
          startBuild(input: $input) { id }
        }`,
        {
          input: {
            worktreeId,
            configurationId: configuration.id,
            destination,
            scriptIds: [...scriptIds],
            action,
            advancedSettings: {
              ...advanced,
              buildSettingOverrides,
              ...(action === "TEST_WITHOUT_BUILDING"
                ? {
                    priorBuildForTestingId: selectedPriorBuildId,
                    priorTestProductsPath: null,
                    priorXctestrunPath: null,
                  }
                : {}),
            },
            requestId: createClientId(),
          },
        },
      );
      onOpenChange(false);
      onStarted(data.startBuild.id);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("startBuild")}</DialogTitle>
          <DialogDescription>{t("startBuildDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> {t("loading")}
          </p>
        ) : !project?.configurations.length ? (
          <Alert>
            <AlertDescription>{t("noConfigurations")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <Label>{t("configuration")}</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {project.configurations.map((entry) => (
                  <button
                    className={`rounded-xl border p-3 text-left transition-colors ${entry.id === configurationId ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                    key={entry.id}
                    onClick={() => {
                      setConfigurationId(entry.id);
                      setAction(entry.defaultAction);
                      setAdvanced(entry.advancedSettings ?? {});
                    }}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-medium">
                        <ConfigurationIcon iconKey={entry.iconKey} />
                        {entry.name}
                      </span>
                      <Badge variant="outline">
                        {humanizeConstant(
                          (observations[entry.id] ?? entry.observation)
                            ?.status ?? "UNPARSED",
                        )}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.scheme} · {entry.buildConfiguration}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            {configuration && (
              <Card>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-mono text-xs">
                        {configuration.source.relativePath}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {configuration.scheme} ·{" "}
                        {configuration.buildConfiguration}
                      </p>
                    </div>
                    <Button
                      disabled={preparing}
                      onClick={() => void reparse(configuration)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {preparing ? <Spinner /> : <RefreshCw />} {t("reparse")}
                    </Button>
                  </div>
                  {observation?.error && (
                    <p className="text-xs text-destructive">
                      {observation.error}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>{t("action")}</Label>
                <Select
                  onValueChange={(value) => setAction(value as BuildAction)}
                  value={action}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`actions.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("destinationType")}</Label>
                <Select
                  disabled={action === "ARCHIVE"}
                  onValueChange={(value) => {
                    const type = value as BuildDestination["type"];
                    setDestinationType(type);
                    setDestinationId(
                      destinations.find((entry) => entry.type === type)?.id ??
                        "",
                    );
                  }}
                  value={destinationType}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SIMULATOR">{t("simulator")}</SelectItem>
                    <SelectItem value="PHYSICAL_DEVICE">
                      {t("physicalDevice")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("device")}</Label>
                <Select
                  disabled={preparing || !filteredDestinations.length}
                  onValueChange={setDestinationId}
                  value={destinationId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("selectDevice")} />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredDestinations.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.generic
                          ? entry.type === "SIMULATOR"
                            ? t("anySimulator")
                            : t("anyPhysicalDevice")
                          : entry.name}
                        {entry.osVersion ? ` · ${entry.osVersion}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {action === "TEST_WITHOUT_BUILDING" && (
              <div className="space-y-2">
                <Label>{t("priorBuildForTesting")}</Label>
                <Select
                  disabled={!compatiblePriorBuilds.length}
                  onValueChange={(value) =>
                    setAdvanced((current) => ({
                      ...current,
                      priorBuildForTestingId: value,
                      priorTestProductsPath: null,
                      priorXctestrunPath: null,
                    }))
                  }
                  value={selectedPriorBuildId ?? ""}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("selectPriorBuildForTesting")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {compatiblePriorBuilds.map((build) => (
                      <SelectItem key={build.id} value={build.id}>
                        {new Date(build.createdAt).toLocaleString()} ·{" "}
                        {build.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!compatiblePriorBuilds.length && (
                  <p className="text-xs text-destructive">
                    {t("noPriorBuildForTesting")}
                  </p>
                )}
              </div>
            )}

            {["TEST", "BUILD_FOR_TESTING", "TEST_WITHOUT_BUILDING"].includes(
              action,
            ) && (
              <div className="space-y-2">
                <Label>{t("testPlan")}</Label>
                <Select
                  onValueChange={(value) =>
                    setAdvanced((current) => ({
                      ...current,
                      testPlan: value === "__SCHEME_DEFAULT__" ? null : value,
                    }))
                  }
                  value={String(advanced.testPlan ?? "__SCHEME_DEFAULT__")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__SCHEME_DEFAULT__">
                      {t("schemeDefaultTestPlan")}
                    </SelectItem>
                    {typeof advanced.testPlan === "string" &&
                      advanced.testPlan &&
                      !observation?.testPlans.includes(advanced.testPlan) && (
                        <SelectItem value={advanced.testPlan}>
                          {advanced.testPlan} · {t("savedValueUnavailable")}
                        </SelectItem>
                      )}
                    {observation?.testPlans.map((testPlan) => (
                      <SelectItem key={testPlan} value={testPlan}>
                        {testPlan}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {project.allowedScripts.length > 0 && (
              <section className="space-y-2">
                <Label>{t("scripts")}</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {project.allowedScripts.map(({ script }) => (
                    <label
                      className="flex items-start gap-2 rounded-lg border p-2"
                      key={script.id}
                    >
                      <Checkbox
                        checked={scriptIds.has(script.id)}
                        onCheckedChange={(checked) => {
                          setScriptIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(script.id);
                            else next.delete(script.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <span className="block text-sm font-medium">
                          {script.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {script.preBuildScript ? t("preBuild") : ""}
                          {script.preBuildScript && script.postBuildScript
                            ? " · "
                            : ""}
                          {script.postBuildScript ? t("postBuild") : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <details className="rounded-xl border p-3">
              <summary className="cursor-pointer font-medium">
                {t("advancedSettings")}
              </summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="development-team">
                    {t("developmentTeam")}
                  </Label>
                  <Input
                    id="development-team"
                    onChange={(event) =>
                      setAdvanced((current) => ({
                        ...current,
                        developmentTeam: event.target.value || null,
                      }))
                    }
                    value={String(advanced.developmentTeam ?? "")}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("packageResolution")}</Label>
                  <Select
                    onValueChange={(value) =>
                      setAdvanced((current) => ({
                        ...current,
                        packageResolution: value,
                      }))
                    }
                    value={String(advanced.packageResolution ?? "DEFAULT")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "DEFAULT",
                        "RESOLVED_ONLY",
                        "SKIP_UPDATES",
                        "DISABLE_AUTOMATIC",
                      ].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={Boolean(advanced.codeCoverage)}
                    onCheckedChange={(checked) =>
                      setAdvanced((current) => ({
                        ...current,
                        codeCoverage: Boolean(checked),
                      }))
                    }
                  />
                  {t("codeCoverage")}
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={Boolean(advanced.allowProvisioningUpdates)}
                    onCheckedChange={(checked) =>
                      setAdvanced((current) => ({
                        ...current,
                        allowProvisioningUpdates: Boolean(checked),
                      }))
                    }
                  />
                  {t("allowProvisioningUpdates")}
                </label>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="build-setting-overrides">
                    {t("buildSettingOverrides")}
                  </Label>
                  <Textarea
                    className="font-mono text-xs"
                    id="build-setting-overrides"
                    onChange={(event) => setOverrides(event.target.value)}
                    rows={4}
                    value={overrides}
                  />
                </div>
              </div>
            </details>

            <section className="space-y-2">
              <Label>{t("commandPreview")}</Label>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                {preview}
              </pre>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={
              loading ||
              preparing ||
              starting ||
              !configuration ||
              !destination ||
              (action === "TEST_WITHOUT_BUILDING" && !selectedPriorBuildId)
            }
            onClick={() => void start()}
            type="button"
          >
            {starting && <Spinner />} {t("startBuild")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
