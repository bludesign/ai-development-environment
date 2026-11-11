"use client";

import { Hammer, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

import { ANDROID_BUILD_CONFIGURATION_FIELDS } from "./graphql-fields";
import type { AndroidBuildConfiguration } from "./types";

export type AndroidAppProject = {
  id: string;
  androidConfigurations: AndroidBuildConfiguration[];
  allowedScripts?: Array<{
    script: { id: string; name: string; enabledByDefault: boolean };
  }>;
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

export function AndroidProjectSection({ codebaseId }: { codebaseId: string }) {
  const t = useTranslations("androidBuilds");
  const tc = useTranslations("common");
  const [project, setProject] = useState<AndroidAppProject | null>(null);
  const [loading, setLoading] = useState(Boolean(codebaseId));
  const [discoveryWorktreeId, setDiscoveryWorktreeId] = useState<string>();
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
    void controlPlaneRequest<{
      worktreeOverview: {
        agents: Array<{
          agent: { connectionStatus: string; capabilities: string[] };
          codebases: Array<{
            codebase: { id: string };
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
        codebases { codebase { id } worktrees { id primary availability } }
      } }
    }`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        const group = data.worktreeOverview.agents
          .filter(
            ({ agent }) =>
              agent.connectionStatus === "ONLINE" &&
              agent.capabilities.includes("android.source.discover") &&
              agent.capabilities.includes("android.source.inspect"),
          )
          .flatMap(({ codebases }) => codebases)
          .find(({ codebase }) => codebase.id === codebaseId);
        const available = group?.worktrees.filter(
          ({ availability }) => availability === "AVAILABLE",
        );
        setDiscoveryWorktreeId(
          available?.find(({ primary }) => primary)?.id ?? available?.[0]?.id,
        );
      })
      .catch(() => {});
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
              <p className="text-sm text-muted-foreground">
                {t("noConfigurations")}
              </p>
            )}
            <ul className="divide-y">
              {project.androidConfigurations.map((item) => (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={item.id}
                >
                  <div className="min-w-0">
                    <Link
                      className="font-medium hover:underline"
                      href={`/dashboard/builds/configurations/${item.id}`}
                    >
                      {item.name}
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
      </CardContent>
      {editing !== undefined && (
        <AndroidBuildConfigurationDialog
          codebaseId={codebaseId}
          configuration={editing}
          discoveryWorktreeId={discoveryWorktreeId}
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
  discoveryWorktreeId,
  onClose,
  onSaved,
}: {
  codebaseId: string;
  configuration: AndroidBuildConfiguration | null;
  discoveryWorktreeId?: string;
  onClose: () => void;
  onSaved: (configuration: AndroidBuildConfiguration) => void;
}) {
  const t = useTranslations("androidBuilds");
  const tc = useTranslations("common");
  const buildsT = useTranslations("builds");
  const id = useId();
  const [values, setValues] = useState({
    name: configuration?.name ?? "",
    projectPath: configuration?.projectPath ?? ".",
    module: configuration?.module ?? ":app",
    variant: configuration?.variant ?? "debug",
    apkPath: configuration?.apkPath ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [inspection, setInspection] = useState<"projects" | "modules" | null>(
    null,
  );
  const [projects, setProjects] = useState<string[] | null>(null);
  const [modules, setModules] = useState<Array<{
    module: string;
    variants: string[];
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fields = [
    "name",
    "projectPath",
    "module",
    "variant",
    "apkPath",
  ] as const;
  const inspectedSelection = modules?.some(
    ({ module, variants }) =>
      module === values.module && variants.includes(values.variant),
  )
    ? JSON.stringify([values.module, values.variant])
    : "";

  async function discover() {
    if (!discoveryWorktreeId) return;
    setInspection("projects");
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        discoverAndroidBuildSources: string[];
      }>(
        `mutation DiscoverAndroidBuildSources($worktreeId: ID!, $requestId: ID!) { discoverAndroidBuildSources(worktreeId: $worktreeId, requestId: $requestId) }`,
        { worktreeId: discoveryWorktreeId, requestId: createClientId() },
      );
      const sources = data.discoverAndroidBuildSources;
      setProjects(sources);
      if (sources.length === 1 && sources[0] !== values.projectPath) {
        setValues((current) => ({ ...current, projectPath: sources[0]! }));
        setModules(null);
      }
    } catch (value) {
      setError(String(value));
    } finally {
      setInspection(null);
    }
  }

  async function inspect() {
    if (!discoveryWorktreeId || !values.projectPath.trim()) return;
    setInspection("modules");
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectAndroidBuildSource: Array<{
          module: string;
          variants: string[];
        }>;
      }>(
        `mutation InspectAndroidBuildSource($worktreeId: ID!, $projectPath: String!, $requestId: ID!) { inspectAndroidBuildSource(worktreeId: $worktreeId, projectPath: $projectPath, requestId: $requestId) { module variants } }`,
        {
          worktreeId: discoveryWorktreeId,
          projectPath: values.projectPath,
          requestId: createClientId(),
        },
      );
      setModules(data.inspectAndroidBuildSource);
    } catch (value) {
      setError(String(value));
    } finally {
      setInspection(null);
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
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
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
          {fields.map((field) => (
            <div className="space-y-1.5" key={field}>
              <Label htmlFor={`${id}-${field}`}>{t(field)}</Label>
              <Input
                disabled={saving || inspection !== null}
                id={`${id}-${field}`}
                onChange={(event) => {
                  if (field === "projectPath") setModules(null);
                  setValues((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }));
                }}
                required={field !== "apkPath"}
                value={values[field]}
              />
            </div>
          ))}
          {discoveryWorktreeId && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={saving || inspection !== null}
                  onClick={() => void discover()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {inspection === "projects" ? <Spinner /> : <Search />}{" "}
                  {t("discoverProjects")}
                </Button>
                <Button
                  disabled={
                    saving || inspection !== null || !values.projectPath.trim()
                  }
                  onClick={() => void inspect()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {inspection === "modules" ? <Spinner /> : <Search />}{" "}
                  {t("inspectModules")}
                </Button>
              </div>
              {projects &&
                (projects.length > 0 ? (
                  <Select
                    disabled={saving || inspection !== null}
                    value={
                      projects.includes(values.projectPath)
                        ? values.projectPath
                        : ""
                    }
                    onValueChange={(projectPath) => {
                      setValues((current) => ({ ...current, projectPath }));
                      setModules(null);
                    }}
                  >
                    <SelectTrigger aria-label={t("discoveredProject")}>
                      <SelectValue placeholder={t("discoveredProject")} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((path) => (
                        <SelectItem key={path} value={path}>
                          {path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("noDiscoveredProjects")}
                  </p>
                ))}
              {modules &&
                (modules.length > 0 ? (
                  <Select
                    disabled={saving || inspection !== null}
                    value={inspectedSelection}
                    onValueChange={(value) => {
                      const [module, variant] = JSON.parse(value) as [
                        string,
                        string,
                      ];
                      setValues((current) => ({ ...current, module, variant }));
                    }}
                  >
                    <SelectTrigger aria-label={t("useModuleVariant")}>
                      <SelectValue placeholder={t("useModuleVariant")} />
                    </SelectTrigger>
                    <SelectContent>
                      {modules.flatMap(({ module, variants }) =>
                        variants.map((variant) => {
                          const value = JSON.stringify([module, variant]);
                          return (
                            <SelectItem key={value} value={value}>
                              {module} · {variant}
                            </SelectItem>
                          );
                        }),
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("noDiscoveredModules")}
                  </p>
                ))}
            </div>
          )}
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
                inspection !== null ||
                fields.some(
                  (field) => field !== "apkPath" && !values[field].trim(),
                )
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
