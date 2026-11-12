"use client";

import type { BuildSigningRequirement } from "@ai-development-environment/agent-contract/builds";
import { Hammer, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { Textarea } from "@/components/ui/textarea";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

import type {
  BuildAction,
  BuildConfiguration,
  BuildPlatform,
  BuildPlatformConfiguration,
  BuildScript,
  IosAppProject,
} from "./types";
import {
  BUILD_PLATFORMS,
  configurationPlatforms,
  platformLabel,
  settingsForPlatform,
} from "./types";
import { BUILD_PLATFORM_CONFIGURATION_FIELDS } from "./graphql-fields";
import { BuildConfigurationIconPicker } from "./build-icon-picker";
import { CollectDsymsSelect } from "./collect-dsyms-select";
import { ConfigurationIcon } from "./configuration-icon";
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportSettingsForm,
  exportSettingsForPlatform,
  type ExportSettingsValue,
} from "./export-settings-form";

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
const SCRIPT_FIELDS = `id name iconKey preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior lockScope`;
type SourceCandidate = {
  kind: "PROJECT" | "WORKSPACE" | "PACKAGE";
  relativePath: string;
};

type SourceInspection = {
  source: SourceCandidate;
  schemes: string[];
  configurations: string[];
  testPlans: string[];
  signingRequirements: BuildSigningRequirement[];
  platforms?: BuildPlatform[] | null;
  headSha: string | null;
  xcodeVersion: string | null;
};

type ProjectCheckout = {
  codebaseId: string;
  label: string;
  available: boolean;
};

export function IosProjectSection({
  codebaseId,
  checkouts,
}: {
  codebaseId: string;
  checkouts?: ProjectCheckout[];
}) {
  const t = useTranslations("builds");
  const locale = useLocale();
  const [activeCodebaseId, setActiveCodebaseId] = useState(
    checkouts?.find((checkout) => checkout.available)?.codebaseId ?? codebaseId,
  );
  const [project, setProject] = useState<IosAppProject | null>(null);
  const [scripts, setScripts] = useState<BuildScript[]>([]);
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BuildConfiguration | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        iosAppProject: IosAppProject | null;
        buildScripts: BuildScript[];
        worktreeOverview: {
          agents: Array<{
            codebases: Array<{
              codebase: { id: string };
              worktrees: Array<{ id: string; primary: boolean }>;
            }>;
          }>;
        };
      }>(
        `query IosProjectSection($codebaseId: ID!) {
          iosAppProject(codebaseId: $codebaseId) { ${PROJECT_FIELDS} }
          buildScripts { ${SCRIPT_FIELDS} }
          worktreeOverview {
            agents { codebases { codebase { id } worktrees { id primary } } }
          }
        }`,
        { codebaseId: activeCodebaseId },
      );
      setProject(data.iosAppProject);
      setScripts(data.buildScripts);
      const group = data.worktreeOverview.agents
        .flatMap((agent) => agent.codebases)
        .find((entry) => entry.codebase.id === activeCodebaseId);
      setWorktreeId(
        group?.worktrees.find((worktree) => worktree.primary)?.id ??
          group?.worktrees[0]?.id ??
          null,
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [activeCodebaseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const createProject = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation CreateIosProject($codebaseId: ID!) {
          createIosAppProject(codebaseId: $codebaseId) { id }
        }`,
        { codebaseId: activeCodebaseId },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const reparse = async (configuration: BuildConfiguration) => {
    if (!worktreeId) return;
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation ReparseProjectConfiguration($configurationId: ID!, $worktreeId: ID!, $requestId: ID!) {
          reparseBuildConfiguration(configurationId: $configurationId, worktreeId: $worktreeId, requestId: $requestId) { id status }
        }`,
        {
          configurationId: configuration.id,
          worktreeId,
          requestId: createClientId(),
        },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation DeleteBuildConfiguration($id: ID!) { deleteBuildConfiguration(id: $id) }`,
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const toggleAllowedScript = async (scriptId: string, enabled: boolean) => {
    const current =
      project?.allowedScripts.map((entry) => entry.script.id) ?? [];
    const next = enabled
      ? [...current, scriptId]
      : current.filter((id) => id !== scriptId);
    try {
      await controlPlaneRequest(
        `mutation SetAllowedBuildScripts($codebaseId: ID!, $scriptIds: [ID!]!) {
          setCodebaseBuildScripts(codebaseId: $codebaseId, scriptIds: $scriptIds) { id }
        }`,
        { codebaseId: activeCodebaseId, scriptIds: next },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const updateDefaultDestinationType = async (
    defaultDestinationType: IosAppProject["defaultDestinationType"],
  ) => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        updateIosAppProject: {
          defaultDestinationType: IosAppProject["defaultDestinationType"];
        };
      }>(
        `mutation UpdateIosAppProject($id: ID!, $defaultDestinationType: BuildDestinationType!) {
          updateIosAppProject(id: $id, defaultDestinationType: $defaultDestinationType) { id defaultDestinationType }
        }`,
        { id: project.id, defaultDestinationType },
      );
      setProject((current) =>
        current
          ? {
              ...current,
              defaultDestinationType:
                data.updateIosAppProject.defaultDestinationType,
            }
          : current,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {checkouts && checkouts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("parseCheckout")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select
              disabled={busy}
              onValueChange={(value) => {
                setLoading(true);
                setActiveCodebaseId(value);
              }}
              value={activeCodebaseId}
            >
              <SelectTrigger
                aria-label={t("parseCheckout")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {checkouts.map((checkout) => (
                  <SelectItem
                    disabled={!checkout.available}
                    key={checkout.codebaseId}
                    value={checkout.codebaseId}
                  >
                    {checkout.label}
                    {!checkout.available
                      ? ` · ${t("checkoutUnavailable")}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("parseCheckoutDescription")}
            </p>
          </CardContent>
        </Card>
      )}
      {!project ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Hammer />
            </EmptyMedia>
            <EmptyTitle>{t("addIosProject")}</EmptyTitle>
            <EmptyDescription>{t("addIosProjectDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button disabled={busy} onClick={() => void createProject()}>
            {busy ? <Spinner /> : <Plus />} {t("addIosProject")}
          </Button>
        </Empty>
      ) : (
        <>
          <Alert>
            <AlertDescription>{t("sharedProjectDescription")}</AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteProjectOpen(true)}
            >
              <Trash2 />
              {t("removeProject")}
            </Button>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("iosAppSettings")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="default-destination-type">
                {t("defaultDestinationType")}
              </Label>
              <Select
                disabled={busy}
                value={project.defaultDestinationType}
                onValueChange={(value) =>
                  void updateDefaultDestinationType(
                    value as IosAppProject["defaultDestinationType"],
                  )
                }
              >
                <SelectTrigger
                  id="default-destination-type"
                  className="w-full sm:w-72"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PHYSICAL_DEVICE">
                    {t("physicalDevice")}
                  </SelectItem>
                  <SelectItem value="SIMULATOR">{t("simulator")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("defaultDestinationTypeDescription")}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t("buildConfigurations")}</CardTitle>
              <Button
                disabled={!worktreeId}
                onClick={() => {
                  setEditing(null);
                  setConfigurationOpen(true);
                }}
                size="sm"
              >
                <Plus /> {t("newConfiguration")}
              </Button>
            </CardHeader>
            <CardContent>
              {!project.configurations.length ? (
                <p className="text-sm text-muted-foreground">
                  {t("noConfigurations")}
                </p>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {project.configurations.map((configuration) => (
                    <Card key={configuration.id}>
                      <CardContent className="space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="flex items-center gap-2 font-medium">
                              <ConfigurationIcon
                                iconKey={configuration.iconKey}
                              />
                              {configuration.name}
                            </h3>
                            <p className="font-mono text-xs text-muted-foreground">
                              {configuration.source.relativePath}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {configurationPlatforms(configuration)
                                .map(({ platform }) => platformLabel(platform))
                                .join(" · ")}
                            </p>
                          </div>
                          <Badge
                            variant={
                              configuration.observation?.status === "ERROR" ||
                              configuration.observation?.status === "INVALID"
                                ? "destructive"
                                : configuration.observation?.status === "VALID"
                                  ? "success"
                                  : "outline"
                            }
                          >
                            {t(
                              `parseStatuses.${configuration.observation?.status ?? "UNPARSED"}`,
                            )}
                          </Badge>
                        </div>
                        <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                          <p>
                            {configuration.scheme} ·{" "}
                            {configuration.buildConfiguration}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {configuration.observation?.lastParsedAt
                              ? t("lastParsed", {
                                  value: formatDateValue(
                                    configuration.observation.lastParsedAt,
                                    "short",
                                    { locale },
                                  ),
                                })
                              : t("neverParsed")}
                            {configuration.observation?.stale
                              ? ` · ${t("stale")}`
                              : ""}
                          </p>
                          {configuration.observation?.error && (
                            <p className="mt-1 text-xs text-destructive">
                              {configuration.observation.error}
                            </p>
                          )}
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button
                            disabled={busy || !worktreeId}
                            onClick={() => void reparse(configuration)}
                            size="sm"
                            variant="outline"
                          >
                            <RefreshCw /> {t("reparse")}
                          </Button>
                          <Button
                            onClick={() => {
                              setEditing(configuration);
                              setConfigurationOpen(true);
                            }}
                            size="sm"
                            variant="outline"
                          >
                            <Settings2 /> {t("edit")}
                          </Button>
                          <Button
                            aria-label={t("deleteConfiguration")}
                            disabled={busy}
                            onClick={() => void remove(configuration.id)}
                            size="icon-sm"
                            variant="destructive"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("allowedScripts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!scripts.length ? (
                <p className="text-sm text-muted-foreground">
                  {t("createScriptsOnBuildsPage")}
                </p>
              ) : (
                scripts.map((script) => {
                  const checked = project.allowedScripts.some(
                    (entry) => entry.script.id === script.id,
                  );
                  return (
                    <label
                      className="flex items-center gap-2 rounded-lg border p-2"
                      key={script.id}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) =>
                          void toggleAllowedScript(script.id, Boolean(value))
                        }
                      />
                      <span className="flex items-center gap-2 text-sm">
                        <ConfigurationIcon iconKey={script.iconKey ?? null} />
                        {script.name}
                      </span>
                      {script.enabledByDefault && (
                        <Badge variant="outline">{t("defaultEnabled")}</Badge>
                      )}
                    </label>
                  );
                })
              )}
            </CardContent>
          </Card>
        </>
      )}
      <ConfirmationDialog
        open={deleteProjectOpen}
        onOpenChange={setDeleteProjectOpen}
        title={t("removeProject")}
        description={t("removeProjectDescription")}
        actionLabel={t("removeProject")}
        cancelLabel={t("cancel")}
        onConfirm={async () => {
          if (!project) return;
          try {
            await controlPlaneRequest(
              `mutation DeleteIosAppProject($id: ID!) { deleteIosAppProject(id: $id) }`,
              { id: project.id },
            );
            setDeleteProjectOpen(false);
            await load();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            setDeleteProjectOpen(false);
          }
        }}
      />
      {configurationOpen && worktreeId && (
        <BuildConfigurationDialog
          codebaseId={activeCodebaseId}
          configuration={editing}
          onOpenChange={setConfigurationOpen}
          onSaved={load}
          open={configurationOpen}
          worktreeId={worktreeId}
        />
      )}
    </div>
  );
}

export function BuildConfigurationDialog({
  codebaseId,
  worktreeId,
  configuration,
  open,
  onOpenChange,
  onSaved,
  onCustom,
  inline = false,
  platformEditor,
}: {
  codebaseId: string;
  worktreeId: string;
  configuration: BuildConfiguration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  onCustom?: (configuration: BuildConfiguration) => void;
  inline?: boolean;
  platformEditor?: BuildPlatform;
}) {
  const t = useTranslations("builds");
  const [name, setName] = useState(configuration?.name ?? "");
  const [iconKey, setIconKey] = useState(configuration?.iconKey ?? null);
  const [sources, setSources] = useState<SourceCandidate[]>([]);
  const [sourcePath, setSourcePath] = useState(
    configuration?.source.relativePath ?? "",
  );
  const [sourceKind, setSourceKind] = useState<SourceCandidate["kind"]>(
    configuration?.source.kind ?? "PROJECT",
  );
  const [inspection, setInspection] = useState<SourceInspection | null>(
    configuration?.observation
      ? {
          source: configuration.source,
          schemes: configuration.observation.schemes,
          configurations: configuration.observation.configurations,
          testPlans: configuration.observation.testPlans,
          signingRequirements: [],
          headSha: configuration.observation.headSha,
          xcodeVersion: configuration.observation.xcodeVersion,
        }
      : null,
  );
  const [parseStatus, setParseStatus] = useState(
    configuration?.observation?.status ?? "UNPARSED",
  );
  const [inspectionStale, setInspectionStale] = useState(
    configuration?.observation?.stale ?? false,
  );
  const [scheme, setScheme] = useState(configuration?.scheme ?? "");
  const [buildConfiguration, setBuildConfiguration] = useState(
    configuration?.buildConfiguration ?? "",
  );
  const [action, setAction] = useState<BuildAction>(
    configuration?.defaultAction ?? "BUILD",
  );
  const [autoExport, setAutoExport] = useState(
    configuration?.defaultAction === "ARCHIVE" && configuration.autoExport,
  );
  const [exportSettings, setExportSettings] = useState<ExportSettingsValue>({
    ...DEFAULT_EXPORT_SETTINGS,
    ...(configuration?.exportSettings ?? {}),
  } as ExportSettingsValue);
  const [advanced, setAdvanced] = useState(
    JSON.stringify(configuration?.advancedSettings ?? {}, null, 2),
  );
  const [parseTestResults, setParseTestResults] = useState(
    configuration?.advancedSettings?.parseTestResults !== false,
  );
  const [collectDsyms, setCollectDsyms] = useState<boolean | null>(
    typeof configuration?.advancedSettings?.collectDsyms === "boolean"
      ? configuration.advancedSettings.collectDsyms
      : null,
  );
  const [testPlan, setTestPlan] = useState(
    typeof configuration?.advancedSettings?.testPlan === "string"
      ? configuration.advancedSettings.testPlan
      : "__SCHEME_DEFAULT__",
  );
  const [loadingSources, setLoadingSources] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const inspectionRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<BuildPlatformConfiguration[]>(
    () =>
      configuration
        ? configurationPlatforms(configuration)
        : [{ platform: "IOS" }],
  );
  const [editingPlatform, setEditingPlatform] = useState<BuildPlatform | null>(
    null,
  );
  const inspectedPlatform = platformEditor ?? platforms[0]?.platform ?? "IOS";

  const discover = useCallback(async () => {
    setLoadingSources(true);
    try {
      const data = await controlPlaneRequest<{
        discoverBuildSources: SourceCandidate[];
      }>(
        `mutation DiscoverBuildSources($worktreeId: ID!, $requestId: ID!) {
          discoverBuildSources(worktreeId: $worktreeId, requestId: $requestId) { kind relativePath }
        }`,
        { worktreeId, requestId: createClientId() },
      );
      setSources(data.discoverBuildSources);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingSources(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void discover(), 0);
    return () => window.clearTimeout(timer);
  }, [discover]);

  const inspect = async (
    candidate: SourceCandidate,
    selectedScheme?: string,
    selectedConfiguration = buildConfiguration,
  ) => {
    const request = ++inspectionRequest.current;
    setInspecting(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectBuildSource: SourceInspection;
      }>(
        `mutation InspectBuildSource($input: InspectBuildSourceInput!) {
          inspectBuildSource(input: $input) {
            source { kind relativePath }
            schemes configurations testPlans platforms headSha xcodeVersion
            signingRequirements {
              bundleId name target platform teamId provisioningProfileSpecifier
            }
          }
        }`,
        {
          input: {
            worktreeId,
            sourceKind: candidate.kind,
            sourcePath: candidate.relativePath,
            scheme: selectedScheme || null,
            configuration:
              platformEditor && selectedScheme
                ? selectedConfiguration || null
                : null,
            ...(platformEditor ? { platform: platformEditor } : {}),
            requestId: createClientId(),
          },
        },
      );
      if (request !== inspectionRequest.current) return;
      setInspection(data.inspectBuildSource);
      const supportedPlatforms = data.inspectBuildSource.platforms;
      const unsupported =
        platformEditor &&
        selectedScheme &&
        supportedPlatforms &&
        !supportedPlatforms.includes(platformEditor);
      setParseStatus(unsupported ? "INVALID" : "VALID");
      if (unsupported)
        setError(
          t("unsupportedBuildPlatform", {
            platform: platformLabel(inspectedPlatform),
          }),
        );
      setInspectionStale(false);
      setSourcePath(candidate.relativePath);
      setSourceKind(candidate.kind);
      if (!selectedScheme) {
        setScheme(data.inspectBuildSource.schemes[0] ?? scheme);
        setBuildConfiguration(
          data.inspectBuildSource.configurations[0] ?? buildConfiguration,
        );
      }
    } catch (value) {
      if (request !== inspectionRequest.current) return;
      setParseStatus("ERROR");
      setInspectionStale(Boolean(inspection));
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (request === inspectionRequest.current) setInspecting(false);
    }
  };

  useEffect(() => {
    if (!platformEditor || !sourcePath) return;
    const timer = window.setTimeout(
      () =>
        void inspect({ kind: sourceKind, relativePath: sourcePath }, scheme),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      inspectionRequest.current += 1;
    };
    // Inspect the inherited source when the platform editor first opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformEditor]);

  const parseSigningRequirements = async () => {
    if (!sourcePath || !scheme || !buildConfiguration) {
      throw new Error(t("selectSigningSourceFirst"));
    }
    const data = await controlPlaneRequest<{
      inspectBuildSource: {
        signingRequirements: BuildSigningRequirement[];
      };
    }>(
      `mutation InspectBuildSigningRequirements($input: InspectBuildSourceInput!) {
        inspectBuildSource(input: $input) {
          signingRequirements {
            bundleId name target platform teamId provisioningProfileSpecifier
          }
        }
      }`,
      {
        input: {
          worktreeId,
          sourceKind,
          sourcePath,
          scheme,
          configuration: buildConfiguration,
          ...(inspectedPlatform !== "IOS"
            ? { platform: inspectedPlatform }
            : {}),
          requestId: createClientId(),
        },
      },
    );
    return data.inspectBuildSource.signingRequirements;
  };

  const draft = (): BuildConfiguration => {
    let advancedSettings: unknown;
    try {
      advancedSettings = JSON.parse(advanced);
      if (
        !advancedSettings ||
        typeof advancedSettings !== "object" ||
        Array.isArray(advancedSettings)
      ) {
        throw new Error();
      }
    } catch {
      throw new Error(t("advancedJsonInvalid"));
    }
    advancedSettings = {
      ...(advancedSettings as Record<string, unknown>),
      testPlan: testPlan === "__SCHEME_DEFAULT__" ? null : testPlan,
      parseTestResults,
      collectDsyms,
    };
    return {
      id: "__custom__",
      name: "Custom",
      iconKey: null,
      source: { id: "", kind: sourceKind, relativePath: sourcePath },
      scheme,
      buildConfiguration,
      defaultAction: action,
      advancedSettings: advancedSettings as Record<string, unknown>,
      autoExport: action === "ARCHIVE" && autoExport,
      exportSettings: exportSettingsForPlatform(
        inspectedPlatform,
        exportSettings,
      ),
      platformConfigurations: platforms,
      observation: inspection
        ? {
            id: "",
            scopeKey: `worktree:${worktreeId}`,
            status: parseStatus,
            schemes: inspection.schemes,
            configurations: inspection.configurations,
            testPlans: inspection.testPlans,
            error: null,
            stale: inspectionStale,
            headSha: inspection.headSha,
            xcodeVersion: inspection.xcodeVersion,
            lastParseAttemptAt: new Date().toISOString(),
            lastParsedAt: new Date().toISOString(),
          }
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = draft();
      if (onCustom) {
        onCustom(value);
        onOpenChange(false);
        return;
      }
      const data = await controlPlaneRequest<{
        saveBuildConfiguration: { id: string };
      }>(
        `mutation SaveBuildConfiguration($input: SaveBuildConfigurationInput!) {
          saveBuildConfiguration(input: $input) { id }
        }`,
        {
          input: {
            id: configuration?.id ?? null,
            codebaseId,
            name,
            iconKey,
            sourceKind,
            sourcePath,
            scheme,
            buildConfiguration,
            defaultAction: action,
            advancedSettings: value.advancedSettings,
            autoExport: action === "ARCHIVE" && autoExport,
            exportSettings: value.exportSettings,
            platformConfigurations: platforms,
          },
        },
      );
      await controlPlaneRequest(
        `mutation ReparseSavedBuildConfiguration($configurationId: ID!, $worktreeId: ID!, $requestId: ID!) {
          reparseBuildConfiguration(configurationId: $configurationId, worktreeId: $worktreeId, requestId: $requestId) { id status }
        }`,
        {
          configurationId: data.saveBuildConfiguration.id,
          worktreeId,
          requestId: createClientId(),
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

  const title = platformEditor
    ? t("editPlatformSettings", { platform: platformLabel(platformEditor) })
    : onCustom
      ? t("customBuild")
      : configuration
        ? t("editConfiguration")
        : t("newConfiguration");
  const content = (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-5">
        {!platformEditor && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {t("buildPlatforms")}
            </legend>
            <p className="text-xs text-muted-foreground">
              {t("platformSettingsDescription")}
            </p>
            <div className="flex flex-wrap gap-2">
              {BUILD_PLATFORMS.map((platform) => {
                const enabled = platforms.some(
                  (entry) => entry.platform === platform,
                );
                return (
                  <div
                    className="flex items-center gap-2 rounded-lg border px-2 py-1"
                    key={platform}
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={enabled}
                        disabled={enabled && platforms.length === 1}
                        onCheckedChange={(checked) => {
                          setPlatforms((current) =>
                            checked
                              ? [...current, { platform }]
                              : current.filter(
                                  (entry) => entry.platform !== platform,
                                ),
                          );
                        }}
                      />
                      {platformLabel(platform)}
                    </label>
                    {enabled && (
                      <Button
                        aria-label={t("editPlatformSettings", {
                          platform: platformLabel(platform),
                        })}
                        disabled={!sourcePath || !scheme || !buildConfiguration}
                        onClick={() => {
                          try {
                            draft();
                            setEditingPlatform(platform);
                          } catch (value) {
                            setError(
                              value instanceof Error
                                ? value.message
                                : String(value),
                            );
                          }
                        }}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Settings2 />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {platforms.length > 1 && (
              <div className="flex items-center gap-2">
                <Label htmlFor="default-build-platform">
                  {t("defaultBuildPlatform")}
                </Label>
                <Select
                  value={platforms[0]?.platform}
                  onValueChange={(value) => {
                    setPlatforms((current) => {
                      const selected = current.find(
                        (entry) => entry.platform === value,
                      );
                      return selected
                        ? [
                            selected,
                            ...current.filter((entry) => entry !== selected),
                          ]
                        : current;
                    });
                  }}
                >
                  <SelectTrigger id="default-build-platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {platforms.map(({ platform }) => (
                      <SelectItem key={platform} value={platform}>
                        {platformLabel(platform)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </fieldset>
        )}
        {!onCustom && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="configuration-name">{t("name")}</Label>
              <Input
                id="configuration-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="configuration-icon">{t("icon")}</Label>
              <BuildConfigurationIconPicker
                id="configuration-icon"
                value={iconKey}
                onChange={setIconKey}
              />
            </div>
          </div>
        )}
        <Card>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{t("source")}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {sourcePath || t("selectSource")}
                </p>
              </div>
              {inspection && (
                <div className="flex items-center gap-2">
                  {inspectionStale && (
                    <span className="text-xs text-muted-foreground">
                      {t("stale")}
                    </span>
                  )}
                  <Badge
                    variant={
                      parseStatus === "VALID" ? "success" : "destructive"
                    }
                  >
                    {t(`parseStatuses.${parseStatus}`)}
                  </Badge>
                </div>
              )}
            </div>
            <Select
              disabled={loadingSources || inspecting}
              onValueChange={(value) => {
                const candidate = sources.find(
                  (source) => source.relativePath === value,
                );
                if (candidate) void inspect(candidate);
              }}
              value={
                sources.some((source) => source.relativePath === sourcePath)
                  ? sourcePath
                  : ""
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    loadingSources ? t("loadingSources") : t("selectSource")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem
                    key={source.relativePath}
                    value={source.relativePath}
                  >
                    {source.relativePath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {inspection && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t("scheme")}</Label>
                  <Select
                    onValueChange={(value) => {
                      setScheme(value);
                      void inspect(inspection.source, value);
                    }}
                    value={scheme}
                  >
                    <SelectTrigger aria-label={t("scheme")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scheme && !inspection.schemes.includes(scheme) && (
                        <SelectItem value={scheme}>
                          {scheme} · {t("savedValueUnavailable")}
                        </SelectItem>
                      )}
                      {inspection.schemes.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("configuration")}</Label>
                  <Select
                    onValueChange={(value) => {
                      setBuildConfiguration(value);
                      if (platformEditor)
                        void inspect(inspection.source, scheme, value);
                    }}
                    value={buildConfiguration}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {buildConfiguration &&
                        !inspection.configurations.includes(
                          buildConfiguration,
                        ) && (
                          <SelectItem value={buildConfiguration}>
                            {buildConfiguration} · {t("savedValueUnavailable")}
                          </SelectItem>
                        )}
                      {inspection.configurations.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <Button
              disabled={!sourcePath || inspecting}
              onClick={() =>
                void inspect(
                  { kind: sourceKind, relativePath: sourcePath },
                  scheme,
                )
              }
              size="sm"
              variant="outline"
            >
              {inspecting ? <Spinner /> : <RefreshCw />} {t("reparse")}
            </Button>
          </CardContent>
        </Card>
        <div className="space-y-2">
          <Label>{t("defaultAction")}</Label>
          <Select
            onValueChange={(value) => {
              setAction(value as BuildAction);
              if (value !== "ARCHIVE") setAutoExport(false);
            }}
            value={action}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                "BUILD",
                "TEST",
                "ANALYZE",
                "ARCHIVE",
                "BUILD_FOR_TESTING",
                "TEST_WITHOUT_BUILDING",
              ].map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`actions.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {action === "ARCHIVE" && (
          <section className="space-y-3">
            <label className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={autoExport}
                onCheckedChange={(checked) => setAutoExport(Boolean(checked))}
              />
              {t("autoExport")}
            </label>
            {autoExport && (
              <ExportSettingsForm
                key={`${sourceKind}:${sourcePath}:${scheme}:${buildConfiguration}`}
                onChange={setExportSettings}
                onParseSigningRequirements={parseSigningRequirements}
                platform={inspectedPlatform}
                value={exportSettingsForPlatform(
                  inspectedPlatform,
                  exportSettings,
                )}
              />
            )}
          </section>
        )}
        {["TEST", "BUILD_FOR_TESTING", "TEST_WITHOUT_BUILDING"].includes(
          action,
        ) && (
          <div className="space-y-2">
            <Label>{t("testPlan")}</Label>
            <Select onValueChange={setTestPlan} value={testPlan}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__SCHEME_DEFAULT__">
                  {t("schemeDefaultTestPlan")}
                </SelectItem>
                {testPlan !== "__SCHEME_DEFAULT__" &&
                  !inspection?.testPlans.includes(testPlan) && (
                    <SelectItem value={testPlan}>
                      {testPlan} · {t("savedValueUnavailable")}
                    </SelectItem>
                  )}
                {inspection?.testPlans.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer font-medium">
            {t("advancedSettings")}
          </summary>
          <div className="mt-3 space-y-2">
            <div className="pb-2">
              <CollectDsymsSelect
                id="configuration-collect-dsyms"
                onChange={setCollectDsyms}
                value={collectDsyms}
              />
            </div>
            <label className="flex items-center gap-2 pb-2">
              <Checkbox
                checked={parseTestResults}
                onCheckedChange={(checked) =>
                  setParseTestResults(Boolean(checked))
                }
              />
              {t("parseTestResults")}
            </label>
            <Label htmlFor="configuration-advanced-json">
              {t("advancedJson")}
            </Label>
            <Textarea
              className="font-mono text-xs"
              id="configuration-advanced-json"
              onChange={(event) => setAdvanced(event.target.value)}
              rows={10}
              value={advanced}
            />
          </div>
        </details>
      </div>
      <DialogFooter>
        {(!inline || configuration) && (
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
        )}
        <Button
          disabled={
            busy ||
            inspecting ||
            parseStatus === "INVALID" ||
            (!onCustom && !name.trim()) ||
            !sourcePath ||
            !scheme ||
            !buildConfiguration
          }
          onClick={() => void save()}
        >
          {busy && <Spinner />} {t(onCustom ? "useSettings" : "save")}
        </Button>
      </DialogFooter>
      {editingPlatform && (
        <BuildConfigurationDialog
          codebaseId={codebaseId}
          configuration={settingsForPlatform(draft(), editingPlatform)}
          key={editingPlatform}
          onCustom={(value) => {
            const base = draft();
            const advancedSettings = Object.fromEntries(
              Object.entries(value.advancedSettings).filter(
                ([key, setting]) =>
                  JSON.stringify(setting) !==
                  JSON.stringify(base.advancedSettings[key]),
              ),
            );
            const exportSettings = Object.fromEntries(
              Object.entries(value.exportSettings ?? {}).filter(
                ([key, setting]) =>
                  JSON.stringify(setting) !==
                  JSON.stringify(base.exportSettings?.[key]),
              ),
            );
            setPlatforms((current) =>
              current.map((entry) =>
                entry.platform !== editingPlatform
                  ? entry
                  : {
                      platform: editingPlatform,
                      ...(value.source.relativePath !==
                        base.source.relativePath ||
                      value.source.kind !== base.source.kind
                        ? {
                            sourcePath: value.source.relativePath,
                            sourceKind: value.source.kind,
                          }
                        : {}),
                      ...(value.scheme !== base.scheme
                        ? { scheme: value.scheme }
                        : {}),
                      ...(value.buildConfiguration !== base.buildConfiguration
                        ? { buildConfiguration: value.buildConfiguration }
                        : {}),
                      ...(value.defaultAction !== base.defaultAction
                        ? { defaultAction: value.defaultAction }
                        : {}),
                      ...(value.autoExport !== base.autoExport
                        ? { autoExport: value.autoExport }
                        : {}),
                      ...(Object.keys(advancedSettings).length
                        ? { advancedSettings }
                        : {}),
                      ...(Object.keys(exportSettings).length
                        ? { exportSettings }
                        : {}),
                    },
              ),
            );
          }}
          onOpenChange={(open) => {
            if (!open) setEditingPlatform(null);
          }}
          onSaved={async () => {}}
          open
          platformEditor={editingPlatform}
          worktreeId={worktreeId}
        />
      )}
    </>
  );

  if (inline) {
    return (
      <section aria-label={title} className="space-y-4 rounded-xl border p-4">
        <div className="space-y-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {t("configurationDescription")}
          </p>
        </div>
        {content}
      </section>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("configurationDescription")}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
