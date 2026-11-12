"use client";

import {
  ANDROID_BUILD_JOB_KIND,
  ANDROID_SOURCE_DISCOVER_JOB_KIND,
  ANDROID_SOURCE_INSPECT_JOB_KIND,
} from "@ai-development-environment/agent-contract/builds";
import { Hammer, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
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
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { BuildConfigurationIconPicker } from "./build-icon-picker";
import { ConfigurationIcon } from "./configuration-icon";
import { ANDROID_BUILD_CONFIGURATION_FIELDS } from "./graphql-fields";
import type { AndroidBuildConfiguration } from "./types";

export type AndroidAppProject = {
  id: string;
  androidConfigurations: AndroidBuildConfiguration[];
  allowedScripts?: Array<{
    script: { id: string; name: string; enabledByDefault: boolean };
  }>;
};

type AndroidBuildCheckout = {
  codebaseId: string;
  label: string;
  androidBuildStatus: "ready" | "offline" | "unavailable" | "missingTools";
};

const ANDROID_APP_PROJECT_FIELDS = `id androidConfigurations { ${ANDROID_BUILD_CONFIGURATION_FIELDS} } allowedScripts { script { id name enabledByDefault } }`;

export function fetchAndroidAppProject(
  codebaseId: string,
  signal?: AbortSignal,
) {
  return controlPlaneRequest<{ androidAppProject: AndroidAppProject | null }>(
    `query AndroidAppProject($codebaseId: ID!) { androidAppProject(codebaseId: $codebaseId) { ${ANDROID_APP_PROJECT_FIELDS} } }`,
    { codebaseId },
    { signal },
  ).then((data) => data.androidAppProject);
}

export function AndroidProjectSection({
  checkouts,
  codebaseId,
  repositoryId,
}: {
  checkouts: AndroidBuildCheckout[];
  codebaseId: string;
  repositoryId: string;
}) {
  const t = useTranslations("androidBuilds");
  const tc = useTranslations("common");
  const [project, setProject] = useState<AndroidAppProject | null>(null);
  const [loading, setLoading] = useState(Boolean(codebaseId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    AndroidBuildConfiguration | null | undefined
  >();
  const [deleting, setDeleting] = useState<{
    id: string;
    project: boolean;
  } | null>(null);

  useEffect(() => {
    if (!codebaseId) return;
    const controller = new AbortController();
    void fetchAndroidAppProject(codebaseId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setProject(result);
        setLoading(false);
      },
      (value) => {
        if (controller.signal.aborted) return;
        setError(String(value));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [codebaseId]);

  async function createProject() {
    setError(null);
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        createAndroidAppProject: AndroidAppProject;
      }>(
        `mutation CreateAndroidAppProject($codebaseId: ID!) { createAndroidAppProject(codebaseId: $codebaseId) { ${ANDROID_APP_PROJECT_FIELDS} } }`,
        { codebaseId },
      );
      setProject(data.createAndroidAppProject);
      setEditing(null);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    const { id, project: removeProject } = deleting;
    setError(null);
    setBusy(true);
    try {
      await controlPlaneRequest(
        removeProject
          ? `mutation DeleteAndroidAppProject($id: ID!) { deleteAndroidAppProject(id: $id) }`
          : `mutation DeleteAndroidBuildConfiguration($id: ID!) { deleteAndroidBuildConfiguration(id: $id) }`,
        { id },
      );
      setProject((current) =>
        removeProject || !current
          ? null
          : {
              ...current,
              androidConfigurations: current.androidConfigurations.filter(
                (item) => item.id !== id,
              ),
            },
      );
      setDeleting(null);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hammer /> {t("project")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("projectDescription")}
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <Spinner />
        ) : !codebaseId ? (
          <p className="text-sm text-muted-foreground">{t("noCheckout")}</p>
        ) : !project ? (
          <Button disabled={busy} onClick={() => void createProject()}>
            {busy ? <Spinner /> : <Plus />} {t("enableProject")}
          </Button>
        ) : (
          <>
            {project.androidConfigurations.length === 0 && (
              <div className="space-y-1 text-sm">
                <p>{t("noConfigurations")}</p>
                <p className="text-muted-foreground">
                  {t("configurationEnablesBuilds")}
                </p>
              </div>
            )}
            <ul className="divide-y">
              {project.androidConfigurations.map((item) => (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={item.id}
                >
                  <div className="min-w-0">
                    <Link
                      className="flex items-center gap-2 font-medium hover:underline"
                      href={`/dashboard/builds/configurations/${item.id}`}
                    >
                      <ConfigurationIcon iconKey={item.iconKey} /> {item.name}
                    </Link>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {item.projectPath} · {item.module} · {item.variant}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      aria-label={t("editConfiguration")}
                      disabled={busy}
                      onClick={() => setEditing(item)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      aria-label={t("deleteConfiguration")}
                      disabled={busy}
                      onClick={() =>
                        setDeleting({ id: item.id, project: false })
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => setEditing(null)}>
                <Plus /> {t("addConfiguration")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => setDeleting({ id: project.id, project: true })}
                variant="outline"
              >
                <Trash2 /> {t("deleteProject")}
              </Button>
            </div>
          </>
        )}
        {checkouts.length > 0 && (
          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t("buildAgents")}</h3>
            <ul className="space-y-2">
              {checkouts.map(({ codebaseId, label, androidBuildStatus }) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  key={codebaseId}
                >
                  <span className="break-all">{label}</span>
                  <Badge
                    variant={
                      androidBuildStatus === "ready" ? "success" : "secondary"
                    }
                  >
                    {t(`agentStatus.${androidBuildStatus}`)}
                  </Badge>
                </li>
              ))}
            </ul>
            {checkouts.some(
              ({ androidBuildStatus }) => androidBuildStatus === "missingTools",
            ) && (
              <p className="text-sm text-muted-foreground">
                {t("buildRequirements")}
              </p>
            )}
          </section>
        )}
      </CardContent>
      {editing !== undefined && (
        <AndroidBuildConfigurationDialog
          codebaseId={codebaseId}
          configuration={editing}
          repositoryId={repositoryId}
          onClose={() => setEditing(undefined)}
          onSaved={(configuration) =>
            setProject((current) =>
              current
                ? {
                    ...current,
                    androidConfigurations: [
                      ...current.androidConfigurations.filter(
                        ({ id }) => id !== configuration.id,
                      ),
                      configuration,
                    ].sort((a, b) => a.name.localeCompare(b.name)),
                  }
                : null,
            )
          }
        />
      )}
      <ConfirmationDialog
        actionLabel={t(
          deleting?.project ? "deleteProject" : "deleteConfiguration",
        )}
        cancelLabel={tc("cancel")}
        description={t(
          deleting?.project
            ? "deleteProjectDescription"
            : "deleteConfigurationDescription",
        )}
        onConfirm={remove}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        open={deleting !== null}
        title={t(deleting?.project ? "deleteProject" : "deleteConfiguration")}
      />
    </Card>
  );
}

export function AndroidBuildConfigurationDialog({
  codebaseId,
  configuration,
  onClose,
  onSaved,
  repositoryId,
}: {
  codebaseId: string;
  configuration: AndroidBuildConfiguration | null;
  onClose: () => void;
  onSaved: (configuration: AndroidBuildConfiguration) => void;
  repositoryId: string;
}) {
  const t = useTranslations("androidBuilds");
  const tc = useTranslations("common");
  const buildsT = useTranslations("builds");
  const id = useId();
  const [values, setValues] = useState({
    name: configuration?.name ?? "",
    iconKey: configuration?.iconKey ?? null,
    projectPath: configuration?.projectPath ?? ".",
    module: configuration?.module ?? ":app",
    variant: configuration?.variant ?? "debug",
    apkPath: configuration?.apkPath ?? "",
  });
  const projectPathEdited = useRef(false);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [projects, setProjects] = useState<string[] | null>(null);
  const [modules, setModules] = useState<{
    projectPath: string;
    entries: Array<{ module: string; variants: string[] }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceWorktrees, setSourceWorktrees] = useState<{
    repositoryId: string;
    discoveryId?: string;
    inspectionId?: string;
  }>();
  const sourceCheckout =
    sourceWorktrees?.repositoryId === repositoryId ? sourceWorktrees : null;
  const { discoveryId, inspectionId } = sourceCheckout ?? {};
  const creating = configuration === null;

  const discover = useCallback(
    async (worktreeId: string, signal?: AbortSignal) => {
      setDiscovering(true);
      setProjects(null);
      setSourceError(null);
      try {
        const { discoverAndroidBuildSources: sources } =
          await controlPlaneRequest<{ discoverAndroidBuildSources: string[] }>(
            `mutation DiscoverAndroidBuildSources($worktreeId: ID!, $requestId: ID!) { discoverAndroidBuildSources(worktreeId: $worktreeId, requestId: $requestId) }`,
            { worktreeId, requestId: createClientId() },
            { signal },
          );
        if (signal?.aborted) return;
        setProjects(sources);
        if (creating && !projectPathEdited.current && sources.length === 1) {
          const [projectPath] = sources;
          setValues((current) =>
            current.projectPath === "."
              ? { ...current, projectPath: projectPath! }
              : current,
          );
        }
      } catch (value) {
        if (!signal?.aborted) setSourceError(String(value));
      } finally {
        if (!signal?.aborted) setDiscovering(false);
      }
    },
    [creating],
  );

  useEffect(() => {
    const controller = new AbortController();
    void controlPlaneRequest<{
      worktreeOverview: {
        agents: Array<{
          agent: { connectionStatus: string; capabilities: string[] };
          codebases: Array<{
            repository: { id: string };
            worktrees: Array<{
              id: string;
              primary: boolean;
              availability: string;
            }>;
          }>;
        }>;
      };
    }>(
      `query AndroidDiscoveryCheckout {
        worktreeOverview(savedOnly: true) { agents {
          agent { connectionStatus capabilities }
          codebases { repository { id } worktrees { id primary availability } }
        } }
      }`,
      undefined,
      { signal: controller.signal },
    )
      .then(({ worktreeOverview }) => {
        if (controller.signal.aborted) return;
        const checkouts = worktreeOverview.agents
          .filter(({ agent }) => agent.connectionStatus === "ONLINE")
          .flatMap(({ agent, codebases }) =>
            codebases
              .filter(({ repository }) => repository.id === repositoryId)
              .flatMap(({ worktrees }) => {
                const available = worktrees.filter(
                  ({ availability }) => availability === "AVAILABLE",
                );
                const worktree =
                  available.find(({ primary }) => primary) ?? available[0];
                return worktree
                  ? [{ id: worktree.id, capabilities: agent.capabilities }]
                  : [];
              }),
          );
        const inspectableCheckouts = checkouts.filter(({ capabilities }) =>
          capabilities.includes(ANDROID_SOURCE_INSPECT_JOB_KIND),
        );
        const inspection =
          inspectableCheckouts.find(({ capabilities }) =>
            capabilities.includes(ANDROID_BUILD_JOB_KIND),
          ) ?? inspectableCheckouts[0];
        const discovery = inspection?.capabilities.includes(
          ANDROID_SOURCE_DISCOVER_JOB_KIND,
        )
          ? inspection
          : checkouts.find(({ capabilities }) =>
              capabilities.includes(ANDROID_SOURCE_DISCOVER_JOB_KIND),
            );
        setSourceWorktrees({
          repositoryId,
          discoveryId: discovery?.id,
          inspectionId: inspection?.id,
        });
        if (discovery) void discover(discovery.id, controller.signal);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSourceWorktrees({ repositoryId });
      });
    return () => controller.abort();
  }, [discover, repositoryId]);

  const inspectedModules =
    modules?.projectPath === values.projectPath ? modules.entries : null;
  const inspectedVariants = inspectedModules?.find(
    ({ module }) => module === values.module,
  )?.variants;

  function updateProjectPath(projectPath: string) {
    projectPathEdited.current = true;
    setValues((current) => ({ ...current, projectPath }));
    setModules(null);
  }

  async function inspect() {
    if (!inspectionId || !values.projectPath.trim()) return;
    setInspecting(true);
    setModules(null);
    setSourceError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectAndroidBuildSource: Array<{
          module: string;
          variants: string[];
        }>;
      }>(
        `mutation InspectAndroidBuildSource($worktreeId: ID!, $projectPath: String!, $requestId: ID!) { inspectAndroidBuildSource(worktreeId: $worktreeId, projectPath: $projectPath, requestId: $requestId) { module variants } }`,
        {
          worktreeId: inspectionId,
          projectPath: values.projectPath,
          requestId: createClientId(),
        },
      );
      setModules({
        projectPath: values.projectPath,
        entries: data.inspectAndroidBuildSource,
      });
    } catch (value) {
      setSourceError(String(value));
    } finally {
      setInspecting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        saveAndroidBuildConfiguration: AndroidBuildConfiguration;
      }>(
        `mutation SaveAndroidBuildConfiguration($input: SaveAndroidBuildConfigurationInput!) { saveAndroidBuildConfiguration(input: $input) { ${ANDROID_BUILD_CONFIGURATION_FIELDS} } }`,
        {
          input: {
            ...values,
            codebaseId,
            id: configuration?.id,
            apkPath: values.apkPath.trim() || null,
          },
        },
      );
      onSaved(data.saveAndroidBuildConfiguration);
      onClose();
    } catch (value) {
      setError(String(value));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving && !inspecting) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(configuration ? "editConfiguration" : "addConfiguration")}
            </DialogTitle>
            <DialogDescription>
              {t("configurationDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>{t("name")}</Label>
              <Input
                disabled={saving}
                id={`${id}-name`}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                required
                value={values.name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-icon`}>{buildsT("icon")}</Label>
              <BuildConfigurationIconPicker
                disabled={saving}
                id={`${id}-icon`}
                onChange={(iconKey) =>
                  setValues((current) => ({ ...current, iconKey }))
                }
                value={values.iconKey}
              />
            </div>
          </div>
          <Card className="py-4">
            <CardContent className="space-y-3">
              <AndroidSourceChoice
                disabled={saving || inspecting}
                id={`${id}-projectPath`}
                label={t("projectPath")}
                manualLabel={t("manualProjectPath")}
                onChange={updateProjectPath}
                options={projects ?? undefined}
                value={values.projectPath}
              />
              <div className="flex flex-wrap gap-2">
                {discoveryId && (
                  <Button
                    disabled={saving || inspecting || discovering}
                    onClick={() => void discover(discoveryId)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {discovering ? <Spinner /> : <Search />}{" "}
                    {t("discoverProjects")}
                  </Button>
                )}
                {inspectionId && (
                  <Button
                    disabled={
                      saving ||
                      inspecting ||
                      discovering ||
                      !values.projectPath.trim()
                    }
                    onClick={() => void inspect()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {inspecting ? <Spinner /> : <Search />}{" "}
                    {t("inspectVariants")}
                  </Button>
                )}
              </div>
              {projects?.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("noDiscoveredProjects")}
                </p>
              )}
              {sourceCheckout && !inspectionId && (
                <p className="text-xs text-muted-foreground">
                  {t("inspectionUnavailable")}
                </p>
              )}
              {inspectedModules?.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("noDiscoveredModules")}
                </p>
              )}
              {sourceError && (
                <Alert variant="destructive">
                  <AlertDescription>{sourceError}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <AndroidSourceChoice
                  disabled={saving || inspecting}
                  id={`${id}-module`}
                  label={t("module")}
                  manualLabel={t("manualModule")}
                  options={inspectedModules?.map(({ module }) => module)}
                  value={values.module}
                  onChange={(module, fromOptions) => {
                    const variants = fromOptions
                      ? inspectedModules?.find(
                          (entry) => entry.module === module,
                        )?.variants
                      : undefined;
                    setValues((current) => ({
                      ...current,
                      module,
                      variant:
                        variants?.length && !variants.includes(current.variant)
                          ? variants[0]!
                          : current.variant,
                    }));
                  }}
                />
                <AndroidSourceChoice
                  disabled={saving || inspecting}
                  id={`${id}-variant`}
                  key={values.module}
                  label={t("variant")}
                  manualLabel={t("manualVariant")}
                  options={inspectedVariants}
                  value={values.variant}
                  onChange={(variant) =>
                    setValues((current) => ({ ...current, variant }))
                  }
                />
              </div>
            </CardContent>
          </Card>
          <div className="space-y-2">
            <Label htmlFor={`${id}-apkPath`}>{t("apkPath")}</Label>
            <Input
              disabled={saving}
              id={`${id}-apkPath`}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  apkPath: event.target.value,
                }))
              }
              value={values.apkPath}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={onClose}
              type="button"
              variant="outline"
            >
              {tc("cancel")}
            </Button>
            <Button
              disabled={
                saving ||
                inspecting ||
                [
                  values.name,
                  values.projectPath,
                  values.module,
                  values.variant,
                ].some((value) => !value.trim())
              }
              type="submit"
            >
              {saving && <Spinner />} {buildsT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Discovered paths are relative, and Gradle modules and variants cannot be '/'.
const MANUAL_SOURCE_VALUE = "/";

function AndroidSourceChoice({
  disabled,
  id,
  label,
  manualLabel,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  id: string;
  label: string;
  manualLabel: string;
  onChange: (value: string, fromOptions: boolean) => void;
  options?: string[];
  value: string;
}) {
  const t = useTranslations("androidBuilds");
  const [manual, setManual] = useState(false);
  const hasOptions = Boolean(options?.length);
  const showInput = manual || !options?.includes(value);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {hasOptions && (
        <Select
          disabled={disabled}
          value={showInput ? MANUAL_SOURCE_VALUE : value}
          onValueChange={(option) => {
            const isManual = option === MANUAL_SOURCE_VALUE;
            setManual(isManual);
            if (!isManual) onChange(option, true);
          }}
        >
          <SelectTrigger className="w-full" id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
            <SelectItem value={MANUAL_SOURCE_VALUE}>
              {t("enterManually")}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
      {showInput && (
        <Input
          aria-label={hasOptions ? manualLabel : undefined}
          disabled={disabled}
          id={hasOptions ? `${id}-manual` : id}
          onChange={(event) => onChange(event.target.value, false)}
          required
          value={value}
        />
      )}
    </div>
  );
}
