"use client";

import type { BuildSigningRequirement } from "@ai-development-environment/agent-contract/builds";
import {
  CircleOff,
  ChevronDown,
  Hammer,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

import type {
  BuildAction,
  BuildConfiguration,
  BuildScript,
  IosAppProject,
} from "./types";
import {
  BUILD_CONFIGURATION_ICON_KEYS,
  ConfigurationIcon,
} from "./configuration-icon";
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportSettingsForm,
  type ExportSettingsValue,
} from "./export-settings-form";

const PROJECT_FIELDS = `
  id type
  configurations {
  id name iconKey scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings createdAt updatedAt
    source { id kind relativePath }
    observation { id scopeKey status schemes configurations testPlans error stale headSha xcodeVersion lastParseAttemptAt lastParsedAt }
  }
  allowedScripts {
    position
    script { id name preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior }
  }
`;
const SCRIPT_FIELDS = `id name preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior`;
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
              <SelectTrigger aria-label={t("parseCheckout")}>
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
                          </div>
                          <Badge
                            variant={
                              configuration.observation?.status === "ERROR" ||
                              configuration.observation?.status === "INVALID"
                                ? "destructive"
                                : "outline"
                            }
                          >
                            {configuration.observation?.status ?? "UNPARSED"}
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
                                  value: new Date(
                                    configuration.observation.lastParsedAt,
                                  ).toLocaleString(),
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
                      <span className="text-sm">{script.name}</span>
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

function BuildConfigurationDialog({
  codebaseId,
  worktreeId,
  configuration,
  open,
  onOpenChange,
  onSaved,
}: {
  codebaseId: string;
  worktreeId: string;
  configuration: BuildConfiguration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("builds");
  const [name, setName] = useState(configuration?.name ?? "");
  const [iconKey, setIconKey] = useState(configuration?.iconKey ?? "none");
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
  const [testPlan, setTestPlan] = useState(
    typeof configuration?.advancedSettings?.testPlan === "string"
      ? configuration.advancedSettings.testPlan
      : "__SCHEME_DEFAULT__",
  );
  const [loadingSources, setLoadingSources] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  ) => {
    setInspecting(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectBuildSource: SourceInspection;
      }>(
        `mutation InspectBuildSource($input: InspectBuildSourceInput!) {
          inspectBuildSource(input: $input) {
            source { kind relativePath }
            schemes configurations testPlans headSha xcodeVersion
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
            configuration: null,
            requestId: createClientId(),
          },
        },
      );
      setInspection(data.inspectBuildSource);
      setParseStatus("VALID");
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
      setParseStatus("ERROR");
      setInspectionStale(Boolean(inspection));
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setInspecting(false);
    }
  };

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
          requestId: createClientId(),
        },
      },
    );
    return data.inspectBuildSource.signingRequirements;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
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
      };
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
            iconKey: iconKey === "none" ? null : iconKey,
            sourceKind,
            sourcePath,
            scheme,
            buildConfiguration,
            defaultAction: action,
            advancedSettings,
            autoExport: action === "ARCHIVE" && autoExport,
            exportSettings,
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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {configuration ? t("editConfiguration") : t("newConfiguration")}
          </DialogTitle>
          <DialogDescription>{t("configurationDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-5">
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`${t("icon")}: ${t(`configurationIcons.${iconKey}`)}`}
                    className="justify-between"
                    id="configuration-icon"
                    type="button"
                    variant="outline"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {iconKey === "none" ? (
                        <CircleOff className="size-4 shrink-0" />
                      ) : (
                        <ConfigurationIcon iconKey={iconKey} />
                      )}
                      <span className="truncate">
                        {t(`configurationIcons.${iconKey}`)}
                      </span>
                    </span>
                    <ChevronDown className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuRadioGroup
                    onValueChange={setIconKey}
                    value={iconKey}
                  >
                    {["none", ...BUILD_CONFIGURATION_ICON_KEYS].map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {value === "none" ? (
                          <CircleOff className="size-4" />
                        ) : (
                          <ConfigurationIcon iconKey={value} />
                        )}
                        {t(`configurationIcons.${value}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
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
                        parseStatus === "VALID" ? "outline" : "destructive"
                      }
                    >
                      {parseStatus}
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
                      <SelectTrigger>
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
                      onValueChange={setBuildConfiguration}
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
                              {buildConfiguration} ·{" "}
                              {t("savedValueUnavailable")}
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
                  value={exportSettings}
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
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
          <Button
            disabled={
              busy ||
              inspecting ||
              !name.trim() ||
              !sourcePath ||
              !scheme ||
              !buildConfiguration
            }
            onClick={() => void save()}
          >
            {busy && <Spinner />} {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
