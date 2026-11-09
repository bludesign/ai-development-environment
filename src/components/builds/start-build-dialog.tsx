"use client";
import { formatEnumLabel } from "@/lib/enum-label";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import {
  defaultServerUrlKind,
  serverUrlOptions,
  type ServerUrlKind,
} from "@/lib/server-urls";
import {
  ServerUrlSelect,
  ServerUrlSettingsLink,
} from "@/components/server-urls/server-url-controls";

import {
  buildDestinationSpecifier,
  genericBuildDestinations,
  XCODE_MULTIPLATFORM_BUILD_CAPABILITY,
  type BuildSigningRequirement,
} from "@ai-development-environment/agent-contract/builds";
import {
  Hammer,
  RefreshCw,
  TestTube2,
  Smartphone,
  Monitor,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BuildConfigurationDialog } from "./ios-project-section";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";
import { cn } from "@/lib/utils";

import type {
  BuildAction,
  BuildConfiguration,
  BuildDestination,
  BuildPlatform,
  BuildSourceObservation,
  IosAppProject,
} from "./types";
import {
  configurationPlatforms,
  destinationPlatform,
  platformLabel,
  settingsForPlatform,
} from "./types";
import { BUILD_PLATFORM_CONFIGURATION_FIELDS } from "./graphql-fields";
import { BuildDestinationPicker } from "./destination-picker";
import { CollectDsymsSelect } from "./collect-dsyms-select";
import { ConfigurationIcon } from "./configuration-icon";
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportSettingsForm,
  exportSettingsForPlatform,
  type ExportSettingsValue,
} from "./export-settings-form";

type PriorBuildForTesting = {
  id: string;
  action: BuildAction;
  destinationType: BuildDestination["type"];
  platform?: BuildPlatform | null;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

type BuildAgent = {
  id: string;
  name: string;
  hostname: string;
  capabilities?: string[];
};

type DestinationCacheEntry = {
  destinations: BuildDestination[];
  expiresAt: number;
};

type PlatformBuildDraft = {
  action: BuildAction;
  destination?: BuildDestination;
  advanced: Record<string, unknown>;
  overrides: string;
  exportWhenComplete: boolean;
  exportSettings: ExportSettingsValue;
  serverUrlKindOverride: ServerUrlKind | null;
  priorBuildId: string | null;
};

type BuildSubmission = {
  kind: "batch" | "startBuild" | "startWorktreeCoverage";
  input: Record<string, unknown>;
};

const DESTINATION_CACHE_TTL_MS = 15_000;

const PROJECT_FIELDS = `
  id type defaultDestinationType
  configurations {
  id name iconKey scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings createdAt updatedAt
    source { id kind relativePath }
    platformConfigurations { ${BUILD_PLATFORM_CONFIGURATION_FIELDS} }
    observation { id scopeKey status schemes configurations testPlans error stale headSha xcodeVersion lastParseAttemptAt lastParsedAt }
  }
  allowedScripts {
    position
    script { id name iconKey preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior lockScope }
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

export function StartBuildButton({
  codebaseId,
  worktreeId,
  disabled,
  disabledReason,
  buildSettingsHref,
  onStarted,
  size = "sm",
}: {
  codebaseId: string;
  worktreeId: string;
  disabled?: boolean;
  disabledReason?: string | null;
  buildSettingsHref?: string;
  onStarted?: (buildId: string) => void;
  size?: "sm" | "default";
}) {
  const t = useTranslations("builds");
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsCloseTimer = useRef<number | null>(null);
  const [destinationCache] = useState(
    () => new Map<string, DestinationCacheEntry>(),
  );

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
          destinationCache={destinationCache}
          onOpenChange={setOpen}
          onStarted={(id) => onStarted?.(id)}
          open={open}
          worktreeId={worktreeId}
        />
      )}
    </>
  );
}

export function WorktreeCoverageButton({
  codebaseId,
  worktreeId,
  disabled,
  onStarted,
}: {
  codebaseId: string;
  worktreeId: string;
  disabled?: boolean;
  onStarted?: (buildId: string) => void;
}) {
  const t = useTranslations("builds");
  const [open, setOpen] = useState(false);
  const [destinationCache] = useState(
    () => new Map<string, DestinationCacheEntry>(),
  );
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)} type="button">
        <TestTube2 /> {t("generateWorktreeCoverage")}
      </Button>
      {open && (
        <StartBuildDialog
          codebaseId={codebaseId}
          coverageMode
          destinationCache={destinationCache}
          onOpenChange={setOpen}
          onStarted={(id) => onStarted?.(id)}
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
  destinationCache,
  coverageMode = false,
}: {
  codebaseId: string;
  worktreeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (buildId: string) => void;
  destinationCache: Map<string, DestinationCacheEntry>;
  coverageMode?: boolean;
}) {
  const { settings: serverUrls, error: serverUrlsError } =
    useServerUrlSettings();
  const [serverUrlKindOverride, setServerUrlKindOverride] =
    useState<ServerUrlKind | null>(null);
  const t = useTranslations("builds");
  const locale = useLocale();
  const deviceId = useId();
  const [project, setProject] = useState<IosAppProject | null>(null);
  const [agent, setAgent] = useState<BuildAgent | null>(null);
  const [priorBuilds, setPriorBuilds] = useState<PriorBuildForTesting[]>([]);
  const [priorBuildsLoading, setPriorBuildsLoading] = useState(false);
  const [configurationId, setConfigurationId] = useState("");
  const [customConfiguration, setCustomConfiguration] =
    useState<BuildConfiguration | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [platform, setPlatform] = useState<BuildPlatform>("IOS");
  const [selectedPlatforms, setSelectedPlatforms] = useState<BuildPlatform[]>([
    "IOS",
  ]);
  const [platformDrafts, setPlatformDrafts] = useState<
    Partial<Record<BuildPlatform, PlatformBuildDraft>>
  >({});
  const [completedPlatforms, setCompletedPlatforms] = useState<BuildPlatform[]>(
    [],
  );
  const [retrySubmission, setRetrySubmission] =
    useState<BuildSubmission | null>(null);
  const selectionInput = (entry: BuildConfiguration) =>
    entry.id === "__custom__"
      ? {
          customConfiguration: {
            sourceKind: entry.source.kind,
            sourcePath: entry.source.relativePath,
            scheme: entry.scheme,
            buildConfiguration: entry.buildConfiguration,
            ...(entry.platformConfigurations?.some(
              (item) => item.platform !== "IOS" || Object.keys(item).length > 1,
            )
              ? { platformConfigurations: entry.platformConfigurations }
              : {}),
            ...(entry.exportSettings &&
            entry.platformConfigurations?.some((item) => item.exportSettings)
              ? { exportSettings: entry.exportSettings }
              : {}),
          },
        }
      : { configurationId: entry.id };
  const [action, setAction] = useState<BuildAction>("BUILD");
  const [observations, setObservations] = useState<
    Record<string, BuildSourceObservation>
  >({});
  const [destinations, setDestinations] = useState<BuildDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(false);
  const [destinationType, setDestinationType] =
    useState<BuildDestination["type"]>("SIMULATOR");
  const [destinationId, setDestinationId] = useState("");
  const [scriptIds, setScriptIds] = useState<Set<string>>(new Set());
  const [advanced, setAdvanced] = useState<Record<string, unknown>>({});
  const [exportWhenComplete, setExportWhenComplete] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettingsValue>(
    DEFAULT_EXPORT_SETTINGS,
  );
  const [overrides, setOverrides] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [reparsing, setReparsing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destinationWarning, setDestinationWarning] = useState<string | null>(
    null,
  );
  const destinationRequest = useRef(0);
  const destinationTypeRef = useRef<BuildDestination["type"]>("SIMULATOR");
  const destinationIdRef = useRef("");
  const priorBuildsLoaded = useRef(false);

  const baseConfiguration =
    configurationId === "__custom__"
      ? customConfiguration
      : project?.configurations.find((entry) => entry.id === configurationId);
  const availablePlatforms = baseConfiguration
    ? configurationPlatforms(baseConfiguration)
    : [];
  const configuration = baseConfiguration
    ? settingsForPlatform(baseConfiguration, platform)
    : null;
  const selectedConfigurationId = customOpen ? "__custom__" : configurationId;
  const observation = configuration
    ? (observations[`${configuration.id}:${platform}`] ??
      configuration.observation)
    : null;

  useEffect(() => {
    let disposed = false;
    void controlPlaneRequest<{
      iosAppProject: IosAppProject | null;
      codebase: { agent: BuildAgent } | null;
    }>(
      `query StartBuildProject($codebaseId: ID!) {
        iosAppProject(codebaseId: $codebaseId) { ${PROJECT_FIELDS} }
        codebase(id: $codebaseId) { agent { id name hostname capabilities } }
      }`,
      { codebaseId },
    )
      .then((data) => {
        if (disposed) return;
        setProject(data.iosAppProject);
        setAgent(data.codebase?.agent ?? null);
        setScriptIds(
          new Set(
            data.iosAppProject?.allowedScripts
              .filter(({ script }) => script.enabledByDefault)
              .map(({ script }) => script.id) ?? [],
          ),
        );
        const first = data.iosAppProject?.configurations[0];
        if (!first && data.iosAppProject) {
          setConfigurationId("__custom__");
          setCustomOpen(true);
        }
        if (first) {
          setConfigurationId(first.id);
          const firstPlatform = configurationPlatforms(first)[0]!.platform;
          const settings = settingsForPlatform(first, firstPlatform);
          setPlatform(firstPlatform);
          setSelectedPlatforms([firstPlatform]);
          setAction(coverageMode ? "TEST" : settings.defaultAction);
          setAdvanced(settings.advancedSettings ?? {});
          setOverrides(
            JSON.stringify(
              settings.advancedSettings?.buildSettingOverrides ?? {},
            ),
          );
          setExportWhenComplete(
            Boolean(
              !coverageMode &&
              settings.defaultAction === "ARCHIVE" &&
              settings.autoExport,
            ),
          );
          setExportSettings(
            exportSettingsForPlatform(firstPlatform, settings.exportSettings),
          );
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
  }, [codebaseId, coverageMode, worktreeId]);

  useEffect(() => {
    if (action !== "TEST_WITHOUT_BUILDING" || priorBuildsLoaded.current) {
      return;
    }
    priorBuildsLoaded.current = true;
    setPriorBuildsLoading(true);
    void controlPlaneRequest<{ builds: { items: PriorBuildForTesting[] } }>(
      `query StartBuildPriorBuilds($worktreeId: ID!) {
        builds(first: 50, status: SUCCEEDED, worktreeId: $worktreeId) {
          items { id action platform destinationType snapshot createdAt }
        }
      }`,
      { worktreeId },
    )
      .then((data) => setPriorBuilds(data.builds.items))
      .catch((value) => {
        priorBuildsLoaded.current = false;
        setError(value instanceof Error ? value.message : String(value));
      })
      .finally(() => setPriorBuildsLoading(false));
  }, [action, worktreeId]);

  const compatiblePriorBuilds = useMemo(
    () =>
      priorBuilds.filter((build) => {
        if (build.action !== "BUILD_FOR_TESTING") return false;
        if (build.destinationType !== destinationType) return false;
        if ((build.platform ?? "IOS") !== platform) return false;
        const snapshotConfiguration = build.snapshot.configuration as
          | {
              id?: string;
              kind?: string;
              source?: { kind: string; relativePath: string };
              scheme?: string;
              buildConfiguration?: string;
              advancedSettings?: { testPlan?: string | null };
            }
          | undefined;
        const currentTestPlan =
          typeof advanced.testPlan === "string" ? advanced.testPlan : null;
        const priorTestPlan = snapshotConfiguration?.advancedSettings?.testPlan;
        return (
          (configurationId === "__custom__"
            ? snapshotConfiguration?.kind === "CUSTOM" &&
              snapshotConfiguration.source?.kind ===
                configuration?.source.kind &&
              snapshotConfiguration.source?.relativePath ===
                configuration?.source.relativePath &&
              snapshotConfiguration.scheme === configuration?.scheme &&
              snapshotConfiguration.buildConfiguration ===
                configuration?.buildConfiguration
            : snapshotConfiguration?.id === configurationId) &&
          (!currentTestPlan ||
            !priorTestPlan ||
            currentTestPlan === priorTestPlan)
        );
      }),
    [
      advanced.testPlan,
      configurationId,
      configuration,
      destinationType,
      platform,
      priorBuilds,
    ],
  );
  const selectedPriorBuildId =
    compatiblePriorBuilds.find(
      (build) => build.id === advanced.priorBuildForTestingId,
    )?.id ??
    compatiblePriorBuilds[0]?.id ??
    null;

  const applyDestinations = (
    next: BuildDestination[],
    selectedAction: BuildAction,
    preserveSelection: boolean,
  ) => {
    const selectable = next.filter(
      (destination) => destination.available !== false,
    );
    const preferredType = project?.defaultDestinationType ?? "SIMULATOR";
    const defaultType: BuildDestination["type"] =
      selectedAction === "ARCHIVE"
        ? (selectable.find((destination) => destination.generic)?.type ??
          destinationTypeRef.current)
        : selectable.some((destination) => destination.type === preferredType)
          ? preferredType
          : (selectable[0]?.type ?? destinationTypeRef.current);
    const nextType =
      preserveSelection &&
      selectable.some(
        (destination) => destination.type === destinationTypeRef.current,
      )
        ? destinationTypeRef.current
        : defaultType;
    const nextId =
      preserveSelection &&
      selectable.some(
        (destination) =>
          destination.id === destinationIdRef.current &&
          destination.type === nextType,
      )
        ? destinationIdRef.current
        : (selectable.find((destination) => destination.type === nextType)
            ?.id ?? "");
    destinationTypeRef.current = nextType;
    destinationIdRef.current = nextId;
    setDestinations(next);
    setDestinationType(nextType);
    setDestinationId(nextId);
  };

  const prepare = async (
    selected: BuildConfiguration,
    selectedAction: BuildAction,
  ) => {
    const request = ++destinationRequest.current;
    setDestinationsLoading(true);
    const input = selectionInput(selected);
    const legacyIos =
      platform === "IOS" &&
      !agent?.capabilities?.includes(XCODE_MULTIPLATFORM_BUILD_CAPABILITY);
    const cacheKey = `${worktreeId}:${JSON.stringify(input)}:${platform}:${selectedAction}`;
    const cached = destinationCache.get(cacheKey);
    if (cached && cached.expiresAt <= Date.now()) {
      destinationCache.delete(cacheKey);
    }
    const initialDestinations =
      cached && cached.expiresAt > Date.now()
        ? cached.destinations
        : legacyIos
          ? genericBuildDestinations(selectedAction)
          : [];
    setError(null);
    setDestinationWarning(null);
    if (initialDestinations.length) {
      applyDestinations(
        initialDestinations,
        selectedAction,
        Boolean(destinationIdRef.current),
      );
    } else {
      setDestinations([]);
      setDestinationId("");
    }
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
            ...input,
            action: selectedAction,
            ...(platform !== "IOS" ? { platform } : {}),
            requestId: createClientId(),
          },
        },
      );
      if (request !== destinationRequest.current) return;
      const live = data.inspectBuildDestinations.filter(
        (destination) =>
          destinationPlatform(destination) === platform &&
          (selectedAction !== "ARCHIVE" || destination.generic),
      );
      const generic =
        legacyIos &&
        live.length > 0 &&
        live.every((destination) => !destination.platformId)
          ? genericBuildDestinations(selectedAction)
          : [];
      const refreshed = [
        ...generic,
        ...live.filter(
          (destination) =>
            !generic.some(
              (entry) =>
                entry.type === destination.type && entry.id === destination.id,
            ),
        ),
      ];
      destinationCache.set(cacheKey, {
        destinations: refreshed,
        expiresAt: Date.now() + DESTINATION_CACHE_TTL_MS,
      });
      applyDestinations(refreshed, selectedAction, true);
    } catch (value) {
      if (request !== destinationRequest.current) return;
      const message = value instanceof Error ? value.message : String(value);
      if (initialDestinations.length) {
        setDestinationWarning(
          t("destinationRefreshWarning", { error: message }),
        );
      } else {
        setError(message);
      }
    } finally {
      if (request === destinationRequest.current) {
        setDestinationsLoading(false);
      }
    }
  };

  const reparse = async (selected: BuildConfiguration) => {
    const currentRequest = destinationRequest.current;
    setReparsing(true);
    setError(null);
    try {
      let nextObservation: BuildSourceObservation;
      if (
        baseConfiguration &&
        (platform !== "IOS" ||
          availablePlatforms[0]?.platform !== platform ||
          selected.source.kind !== baseConfiguration.source.kind ||
          selected.source.relativePath !==
            baseConfiguration.source.relativePath ||
          selected.scheme !== baseConfiguration.scheme ||
          selected.buildConfiguration !== baseConfiguration.buildConfiguration)
      ) {
        const data = await controlPlaneRequest<{
          inspectBuildSource: Pick<
            BuildSourceObservation,
            | "schemes"
            | "configurations"
            | "testPlans"
            | "headSha"
            | "xcodeVersion"
          > & { platforms: BuildPlatform[] | null };
        }>(
          `mutation InspectStartBuildPlatformSource($input: InspectBuildSourceInput!) {
          inspectBuildSource(input: $input) { schemes configurations testPlans headSha xcodeVersion platforms }
        }`,
          {
            input: {
              worktreeId,
              sourceKind: selected.source.kind,
              sourcePath: selected.source.relativePath,
              scheme: selected.scheme,
              configuration: selected.buildConfiguration,
              platform,
              requestId: createClientId(),
            },
          },
        );
        const parsed = data.inspectBuildSource;
        const supported =
          parsed.schemes.includes(selected.scheme) &&
          parsed.configurations.includes(selected.buildConfiguration) &&
          (!parsed.platforms || parsed.platforms.includes(platform));
        const inspectedAt = new Date().toISOString();
        nextObservation = {
          ...parsed,
          id: "",
          scopeKey: `worktree:${worktreeId}`,
          status: supported ? "VALID" : "INVALID",
          error: supported ? null : t("configurationInvalid"),
          stale: false,
          lastParseAttemptAt: inspectedAt,
          lastParsedAt: inspectedAt,
        };
      } else {
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
        nextObservation = parsed.reparseBuildConfiguration;
      }
      setObservations((current) => ({
        ...current,
        [`${selected.id}:${platform}`]: nextObservation,
      }));
      if (nextObservation.status !== "VALID") {
        throw new Error(nextObservation.error || t("configurationInvalid"));
      }
      if (destinationRequest.current === currentRequest)
        void prepare(baseConfiguration ?? selected, action);
    } catch (value) {
      if (destinationRequest.current === currentRequest)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      setReparsing(false);
    }
  };

  const parseSigningRequirements = async () => {
    if (!configuration) throw new Error(t("selectSigningSourceFirst"));
    const data = await controlPlaneRequest<{
      inspectBuildSource: {
        signingRequirements: BuildSigningRequirement[];
      };
    }>(
      `mutation InspectStartBuildSigningRequirements($input: InspectBuildSourceInput!) {
        inspectBuildSource(input: $input) {
          signingRequirements {
            bundleId name target platform teamId provisioningProfileSpecifier
          }
        }
      }`,
      {
        input: {
          worktreeId,
          sourceKind: configuration.source.kind,
          sourcePath: configuration.source.relativePath,
          scheme: configuration.scheme,
          configuration: configuration.buildConfiguration,
          ...(platform !== "IOS" ? { platform } : {}),
          requestId: createClientId(),
        },
      },
    );
    return data.inspectBuildSource.signingRequirements;
  };

  useEffect(() => {
    if (!baseConfiguration || loading) return;
    const timer = window.setTimeout(
      () => void prepare(baseConfiguration, action),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      destinationRequest.current += 1;
    };
    // Prepare only when the selected configuration/action changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationId, customConfiguration, action, loading, platform]);

  const filteredDestinations = useMemo(
    () =>
      destinations.filter(
        (destination) => destination.type === destinationType,
      ),
    [destinations, destinationType],
  );
  const destination = destinations.find(
    (entry) => entry.id === destinationId && entry.type === destinationType,
  );
  const currentDraft: PlatformBuildDraft = {
    action,
    destination,
    advanced,
    overrides,
    exportWhenComplete,
    exportSettings,
    serverUrlKindOverride,
    priorBuildId: selectedPriorBuildId,
  };
  const draftFor = (entry: BuildPlatform) =>
    entry === platform ? currentDraft : platformDrafts[entry];

  const editPlatform = (
    entry: BuildPlatform,
    base: BuildConfiguration,
    preserve: boolean,
  ) => {
    const settings = settingsForPlatform(base, entry);
    const existing = preserve ? platformDrafts[entry] : undefined;
    const nextAction = coverageMode
      ? "TEST"
      : (existing?.action ?? settings.defaultAction);
    destinationRequest.current += 1;
    destinationIdRef.current = existing?.destination?.id ?? "";
    destinationTypeRef.current =
      existing?.destination?.type ??
      project?.defaultDestinationType ??
      "SIMULATOR";
    setPlatform(entry);
    setAction(nextAction);
    setAdvanced(existing?.advanced ?? settings.advancedSettings);
    setOverrides(
      existing?.overrides ??
        JSON.stringify(settings.advancedSettings?.buildSettingOverrides ?? {}),
    );
    setExportWhenComplete(
      !coverageMode &&
        (existing?.exportWhenComplete ?? Boolean(settings.autoExport)),
    );
    setExportSettings(
      existing?.exportSettings ??
        exportSettingsForPlatform(entry, settings.exportSettings),
    );
    setServerUrlKindOverride(existing?.serverUrlKindOverride ?? null);
    setDestinationWarning(null);
    setError(null);
    setDestinations([]);
    setDestinationType(destinationTypeRef.current);
    setDestinationId("");
    setDestinationsLoading(true);
  };

  const selectConfiguration = (entry: BuildConfiguration) => {
    const first = configurationPlatforms(entry)[0]!.platform;
    setConfigurationId(entry.id);
    setSelectedPlatforms([first]);
    setPlatformDrafts({});
    setCompletedPlatforms([]);
    editPlatform(first, entry, false);
  };

  const focusPlatform = (entry: BuildPlatform) => {
    if (!baseConfiguration || entry === platform) return;
    setPlatformDrafts((current) => ({ ...current, [platform]: currentDraft }));
    editPlatform(entry, baseConfiguration, true);
  };
  const preview = configuration
    ? `xcrun xcodebuild ${configuration.source.kind === "PROJECT" ? `-project ${configuration.source.relativePath}` : configuration.source.kind === "WORKSPACE" ? `-workspace ${configuration.source.relativePath}` : ""} -scheme ${JSON.stringify(configuration.scheme)} -configuration ${JSON.stringify(configuration.buildConfiguration)} -destination ${JSON.stringify(destination ? buildDestinationSpecifier(destination) : "<destination>")} -hideShellScriptEnvironment ${action.toLowerCase().replaceAll("_", "-")}${action === "TEST_WITHOUT_BUILDING" && selectedPriorBuildId ? ` · ${t("priorBuildSummary", { id: selectedPriorBuildId })}` : ""}`
    : "";

  const pendingPlatforms = selectedPlatforms.filter(
    (entry) => !completedPlatforms.includes(entry),
  );
  const availableServerUrls = serverUrls ? serverUrlOptions(serverUrls) : [];
  const canStart =
    serverUrls &&
    pendingPlatforms.length > 0 &&
    pendingPlatforms.every((entry) => {
      const draft = draftFor(entry);
      if (!draft?.destination || draft.destination.available === false)
        return false;
      if (draft.action === "ARCHIVE" && !draft.destination.generic)
        return false;
      if (draft.action === "TEST_WITHOUT_BUILDING" && !draft.priorBuildId)
        return false;
      return availableServerUrls.some(
        ({ kind }) =>
          kind ===
          (draft.serverUrlKindOverride ??
            defaultServerUrlKind(serverUrls, draft.destination?.type)),
      );
    });

  const submitBatch = async (input: Record<string, unknown>) => {
    const data = await controlPlaneRequest<{
      startBuilds: Array<{
        platform: BuildPlatform;
        build: { id: string } | null;
        error: string | null;
      }>;
    }>(
      `mutation StartPlatformBuilds($input: StartBuildsInput!) {
        startBuilds(input: $input) { platform build { id } error }
      }`,
      { input },
    );
    const accepted = data.startBuilds.filter(
      (result) => result.build && !result.error,
    );
    const errors = data.startBuilds.filter(
      (result) => result.error || !result.build,
    );
    setRetrySubmission(null);
    setCompletedPlatforms((current) => [
      ...current,
      ...accepted.map((result) => result.platform),
    ]);
    if (accepted[0]?.build) onStarted(accepted[0].build.id);
    if (errors.length || !accepted.length) {
      setError(
        errors
          .map(
            ({ platform, error }) =>
              `${platformLabel(platform)}: ${error ?? t("startBuildFailed")}`,
          )
          .join("\n") || t("startBuildFailed"),
      );
      return;
    }
    onOpenChange(false);
  };

  const submit = async (submission: BuildSubmission) => {
    setRetrySubmission(submission);
    if (submission.kind === "batch") {
      await submitBatch(submission.input);
      return;
    }
    const field = submission.kind;
    const data = await controlPlaneRequest<
      Partial<
        Record<
          typeof field,
          { id: string; errorCode: string | null; error: string | null }
        >
      >
    >(
      `mutation StartIosBuild($input: StartBuildInput!) {
        ${field}(input: $input) { id errorCode error }
      }`,
      { input: submission.input },
    );
    const started = data[field];
    if (!started) throw new Error(t("startBuildFailed"));
    setRetrySubmission(null);
    if (started.errorCode === "QUEUE_FAILED") {
      setError(started.error ?? t("startBuildFailed"));
      return;
    }
    onOpenChange(false);
    onStarted(started.id);
  };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      if (retrySubmission) {
        await submit(retrySubmission);
        return;
      }
      if (!baseConfiguration || !serverUrls || !canStart) return;
      const selectionsError = (entry: BuildPlatform) =>
        pendingPlatforms.length > 1
          ? `${platformLabel(entry)}: ${t("overridesInvalid")}`
          : t("overridesInvalid");
      const selections = pendingPlatforms.map((entry) => {
        const draft = draftFor(entry)!;
        let buildSettingOverrides: Record<string, string>;
        try {
          const parsed: unknown = JSON.parse(draft.overrides);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          buildSettingOverrides = parsed as Record<string, string>;
        } catch {
          throw new Error(selectionsError(entry));
        }
        return {
          platform: entry,
          destination: draft.destination!,
          action: draft.action,
          advancedSettings: {
            ...draft.advanced,
            buildSettingOverrides,
            ...(coverageMode
              ? { codeCoverage: true, parseTestResults: true }
              : {}),
            ...(draft.action === "TEST_WITHOUT_BUILDING"
              ? {
                  priorBuildForTestingId: draft.priorBuildId,
                  priorTestProductsPath: null,
                  priorXctestrunPath: null,
                }
              : {}),
          },
          exportWhenComplete:
            !coverageMode &&
            draft.action === "ARCHIVE" &&
            draft.exportWhenComplete,
          exportSettings:
            draft.action === "ARCHIVE" ? draft.exportSettings : null,
          serverUrlKind:
            draft.serverUrlKindOverride ??
            defaultServerUrlKind(serverUrls, draft.destination!.type),
        };
      });
      const commonInput = {
        worktreeId,
        ...selectionInput(baseConfiguration),
        scriptIds: [...scriptIds],
        requestId: createClientId(),
      };
      if (
        !coverageMode &&
        (availablePlatforms.length > 1 ||
          selections[0]?.platform !== "IOS" ||
          agent?.capabilities?.includes(XCODE_MULTIPLATFORM_BUILD_CAPABILITY))
      ) {
        await submit({
          kind: "batch",
          input: structuredClone({ ...commonInput, selections }),
        });
        return;
      }
      const {
        platform: selectedPlatform,
        destination: selectedDestination,
        ...selection
      } = selections[0]!;
      await submit({
        kind: coverageMode ? "startWorktreeCoverage" : "startBuild",
        input: structuredClone({
          ...commonInput,
          ...selection,
          destination:
            selectedPlatform === "IOS"
              ? selectedDestination
              : { ...selectedDestination, platformId: selectedPlatform },
        }),
      });
    } catch (value) {
      if (
        value instanceof Error &&
        "code" in value &&
        value.code === "BUILD_SUBMISSION_REJECTED"
      ) {
        setRetrySubmission(null);
      }
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Dialog
        onOpenChange={(next) => {
          if (!starting) onOpenChange(next);
        }}
        open={open}
      >
        <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {t(coverageMode ? "startWorktreeCoverage" : "startBuild")}
            </DialogTitle>
            <DialogDescription>
              {t(
                coverageMode
                  ? "startWorktreeCoverageDescription"
                  : "startBuildDescription",
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="whitespace-pre-line">
                {error}
              </AlertDescription>
            </Alert>
          )}
          {destinationWarning && (
            <Alert>
              <AlertDescription>{destinationWarning}</AlertDescription>
            </Alert>
          )}
          {retrySubmission && !starting && (
            <Alert>
              <AlertDescription>
                {t("buildSubmissionUnconfirmed")}
              </AlertDescription>
            </Alert>
          )}
          {loading ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> {t("loading")}
            </p>
          ) : !project ? (
            <Alert>
              <AlertDescription>{t("noConfigurations")}</AlertDescription>
            </Alert>
          ) : (
            <div
              className="space-y-5"
              inert={starting || Boolean(retrySubmission)}
            >
              <section className="space-y-2">
                <Label>{t("configuration")}</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {project.configurations.map((entry) => (
                    <button
                      className={`rounded-xl border p-3 text-left transition-colors ${entry.id === selectedConfigurationId ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                      key={entry.id}
                      aria-pressed={entry.id === selectedConfigurationId}
                      disabled={starting}
                      onClick={() => {
                        setCustomOpen(false);
                        if (entry.id !== configurationId)
                          selectConfiguration(entry);
                      }}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 font-medium">
                          <ConfigurationIcon iconKey={entry.iconKey} />
                          {entry.name}
                        </span>
                        <Badge
                          variant={
                            (
                              observations[
                                `${entry.id}:${configurationPlatforms(entry)[0]!.platform}`
                              ] ?? entry.observation
                            )?.status === "VALID"
                              ? "success"
                              : "outline"
                          }
                        >
                          {t(
                            `parseStatuses.${(observations[`${entry.id}:${configurationPlatforms(entry)[0]!.platform}`] ?? entry.observation)?.status ?? "UNPARSED"}`,
                          )}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.scheme} · {entry.buildConfiguration}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {configurationPlatforms(entry)
                          .map(({ platform }) => platformLabel(platform))
                          .join(" · ")}
                      </p>
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={selectedConfigurationId === "__custom__"}
                    disabled={starting}
                    className={`rounded-xl border p-3 text-left ${selectedConfigurationId === "__custom__" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                    onClick={() => setCustomOpen(true)}
                  >
                    <span className="font-medium">{t("custom")}</span>
                    <p className="text-xs text-muted-foreground">
                      {t("customDescription")}
                    </p>
                  </button>
                </div>
              </section>

              {customOpen && (
                <BuildConfigurationDialog
                  inline
                  codebaseId={codebaseId}
                  worktreeId={worktreeId}
                  configuration={customConfiguration}
                  open={customOpen}
                  onOpenChange={setCustomOpen}
                  onSaved={async () => {}}
                  onCustom={(value) => {
                    setCustomConfiguration(value);
                    selectConfiguration(value);
                  }}
                />
              )}

              {!customOpen && (
                <>
                  {baseConfiguration && (
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium">
                        {t("buildPlatforms")}
                      </legend>
                      {!coverageMode && availablePlatforms.length > 1 && (
                        <p className="text-xs text-muted-foreground">
                          {t("startPlatformsDescription")}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {availablePlatforms.map(({ platform: entry }) => {
                          const selected = selectedPlatforms.includes(entry);
                          const completed = completedPlatforms.includes(entry);
                          return (
                            <div
                              className="flex items-center gap-2 rounded-lg border px-2 py-1"
                              key={entry}
                            >
                              {!coverageMode &&
                                availablePlatforms.length > 1 && (
                                  <Checkbox
                                    aria-label={platformLabel(entry)}
                                    checked={selected}
                                    disabled={
                                      starting ||
                                      completed ||
                                      (selected &&
                                        selectedPlatforms.length === 1)
                                    }
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        setSelectedPlatforms((current) => [
                                          ...current,
                                          entry,
                                        ]);
                                        focusPlatform(entry);
                                      } else {
                                        const remaining =
                                          selectedPlatforms.filter(
                                            (item) => item !== entry,
                                          );
                                        setSelectedPlatforms(remaining);
                                        if (entry === platform && remaining[0])
                                          focusPlatform(remaining[0]);
                                      }
                                    }}
                                  />
                                )}
                              <Button
                                aria-pressed={entry === platform}
                                disabled={
                                  starting ||
                                  completed ||
                                  (!coverageMode && !selected)
                                }
                                onClick={() => {
                                  if (coverageMode)
                                    setSelectedPlatforms([entry]);
                                  focusPlatform(entry);
                                }}
                                size="sm"
                                type="button"
                                variant={
                                  entry === platform ? "secondary" : "ghost"
                                }
                              >
                                {platformLabel(entry)}{" "}
                                {completed && (
                                  <Badge variant="success">
                                    {t("platformBuildQueued")}
                                  </Badge>
                                )}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t("destinationType")}</Label>
                      <Tabs
                        value={destinationType}
                        onValueChange={(value) => {
                          const type = value as BuildDestination["type"];
                          destinationTypeRef.current = type;
                          setDestinationType(type);
                          const id =
                            destinations.find(
                              (entry) =>
                                entry.type === type &&
                                entry.available !== false,
                            )?.id ?? "";
                          destinationIdRef.current = id;
                          setDestinationId(id);
                        }}
                      >
                        <TabsList>
                          {platform === "MACOS" ||
                          platform === "MAC_CATALYST" ? (
                            <TabsTrigger value="LOCAL_MAC">
                              <Monitor /> {t("localMac")}
                            </TabsTrigger>
                          ) : (
                            <>
                              <TabsTrigger value="PHYSICAL_DEVICE">
                                <Smartphone />
                                {t("physicalDevice")}
                              </TabsTrigger>
                            </>
                          )}
                          <TabsTrigger
                            value="SIMULATOR"
                            disabled={action === "ARCHIVE"}
                          >
                            <Monitor />
                            {t("simulator")}
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={deviceId}>{t("device")}</Label>
                        {destinationsLoading && (
                          <Spinner
                            aria-hidden={false}
                            aria-label={t("loadingDevices")}
                          />
                        )}
                      </div>
                      <BuildDestinationPicker
                        id={deviceId}
                        destinations={filteredDestinations}
                        value={destinationId}
                        loading={destinationsLoading}
                        onChange={(value) => {
                          destinationIdRef.current = value;
                          setDestinationId(value);
                        }}
                      />
                      {!destinationsLoading && !destinations.length && (
                        <p className="text-xs text-muted-foreground">
                          {t("noCompatibleDevices")}
                        </p>
                      )}
                    </div>
                  </div>

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
                              <span className="flex items-center gap-2 text-sm font-medium">
                                <ConfigurationIcon
                                  iconKey={script.iconKey ?? null}
                                />{" "}
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
                      {t("details")}
                    </summary>
                    <div className="mt-4 space-y-4">
                      {configuration && (
                        <Card>
                          <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p
                                  className="truncate font-mono text-xs"
                                  title={configuration.source.relativePath}
                                >
                                  {configuration.source.relativePath}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {configuration.scheme} ·{" "}
                                  {configuration.buildConfiguration}
                                </p>
                                {agent && (
                                  <p
                                    className="truncate text-xs text-muted-foreground"
                                    title={`${agent.name} (${agent.hostname})`}
                                  >
                                    {t("agent")}: {agent.name}
                                  </p>
                                )}
                              </div>
                              <Button
                                disabled={reparsing}
                                onClick={() =>
                                  configuration.id === "__custom__"
                                    ? setCustomOpen(true)
                                    : void reparse(configuration)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                {reparsing ? <Spinner /> : <RefreshCw />}{" "}
                                {t("reparse")}
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

                      <div
                        className={cn("space-y-2", coverageMode && "hidden")}
                      >
                        <Label>{t("action")}</Label>
                        <Select
                          onValueChange={(value) => {
                            if (value !== action)
                              destinationRequest.current += 1;
                            setAction(value as BuildAction);
                            if (value !== "ARCHIVE")
                              setExportWhenComplete(false);
                          }}
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
                      {!coverageMode && action === "ARCHIVE" && (
                        <section className="space-y-3">
                          <label className="flex items-center gap-2 font-medium">
                            <Checkbox
                              checked={exportWhenComplete}
                              onCheckedChange={(checked) =>
                                setExportWhenComplete(Boolean(checked))
                              }
                            />
                            {t("exportWhenComplete")}
                          </label>
                          {exportWhenComplete && (
                            <ExportSettingsForm
                              key={`${configurationId}:${platform}`}
                              onChange={setExportSettings}
                              onParseSigningRequirements={
                                parseSigningRequirements
                              }
                              platform={platform}
                              value={exportSettings}
                            />
                          )}
                        </section>
                      )}

                      {action === "TEST_WITHOUT_BUILDING" && (
                        <div className="space-y-2">
                          <Label>{t("priorBuildForTesting")}</Label>
                          <Select
                            disabled={
                              priorBuildsLoading ||
                              !compatiblePriorBuilds.length
                            }
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
                                  {formatDateValue(build.createdAt, "short", {
                                    locale,
                                  })}{" "}
                                  · {build.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {priorBuildsLoading && (
                            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Spinner /> {t("loading")}
                            </p>
                          )}
                          {!priorBuildsLoading &&
                            !compatiblePriorBuilds.length && (
                              <p className="text-xs text-destructive">
                                {t("noPriorBuildForTesting")}
                              </p>
                            )}
                        </div>
                      )}

                      {[
                        "TEST",
                        "BUILD_FOR_TESTING",
                        "TEST_WITHOUT_BUILDING",
                      ].includes(action) && (
                        <div className="space-y-2">
                          <Label>{t("testPlan")}</Label>
                          <Select
                            onValueChange={(value) =>
                              setAdvanced((current) => ({
                                ...current,
                                testPlan:
                                  value === "__SCHEME_DEFAULT__" ? null : value,
                              }))
                            }
                            value={String(
                              advanced.testPlan ?? "__SCHEME_DEFAULT__",
                            )}
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
                                !observation?.testPlans.includes(
                                  advanced.testPlan,
                                ) && (
                                  <SelectItem value={advanced.testPlan}>
                                    {advanced.testPlan} ·{" "}
                                    {t("savedValueUnavailable")}
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
                            value={String(
                              advanced.packageResolution ?? "DEFAULT",
                            )}
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
                                  {formatEnumLabel(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={
                              coverageMode || Boolean(advanced.codeCoverage)
                            }
                            disabled={coverageMode}
                            onCheckedChange={(checked) =>
                              setAdvanced((current) => ({
                                ...current,
                                codeCoverage: Boolean(checked),
                              }))
                            }
                          />
                          {t("codeCoverage")}
                        </label>
                        {["TEST", "TEST_WITHOUT_BUILDING"].includes(action) && (
                          <label className="flex items-center gap-2">
                            <Checkbox
                              checked={
                                coverageMode ||
                                advanced.parseTestResults !== false
                              }
                              disabled={coverageMode}
                              onCheckedChange={(checked) =>
                                setAdvanced((current) => ({
                                  ...current,
                                  parseTestResults: Boolean(checked),
                                }))
                              }
                            />
                            {t("parseTestResults")}
                          </label>
                        )}
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
                        <CollectDsymsSelect
                          id="collect-dsyms"
                          onChange={(collectDsyms) =>
                            setAdvanced((current) => ({
                              ...current,
                              collectDsyms,
                            }))
                          }
                          value={advanced.collectDsyms}
                        />
                        <div className="space-y-2 sm:col-span-2">
                          <Label htmlFor="build-setting-overrides">
                            {t("buildSettingOverrides")}
                          </Label>
                          <Textarea
                            className="font-mono text-xs"
                            id="build-setting-overrides"
                            onChange={(event) =>
                              setOverrides(event.target.value)
                            }
                            rows={4}
                            value={overrides}
                          />
                        </div>
                      </div>
                      <section className="space-y-2">
                        <Label>{t("commandPreview")}</Label>
                        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                          {preview}
                        </pre>
                      </section>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
          <div
            className="space-y-2"
            inert={starting || Boolean(retrySubmission)}
          >
            {serverUrls ? (
              <ServerUrlSelect
                settings={serverUrls}
                value={
                  serverUrlKindOverride ??
                  defaultServerUrlKind(serverUrls, destinationType)
                }
                onValueChange={(kind) => {
                  if (kind !== "INHERIT") setServerUrlKindOverride(kind);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {serverUrlsError ?? "Loading server URLs…"}
              </p>
            )}
            <ServerUrlSettingsLink />
          </div>
          <DialogFooter>
            <Button
              disabled={starting}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={
                starting ||
                (!retrySubmission &&
                  (loading || customOpen || !baseConfiguration || !canStart))
              }
              onClick={() => void start()}
              type="button"
            >
              {starting && <Spinner />}{" "}
              {retrySubmission && !starting
                ? t("retryBuildSubmission")
                : pendingPlatforms.length > 1
                  ? t("startPlatformBuilds", { count: pendingPlatforms.length })
                  : t("startBuild")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
