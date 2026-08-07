"use client";

import {
  CheckCircle2,
  ExternalLink,
  GitFork,
  Plus,
  Save,
  Trash2,
  Unplug,
  Webhook,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useCredentialStoreReadOnly } from "@/hooks/use-credential-store-read-only";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitLabProjectCandidateView,
  GitLabProjectView,
  GitLabSettingsView,
  GitLabWebhookSetupView,
} from "@/services/gitlab";

const SETTINGS_FIELDS =
  "configured tokenConfigured baseUrl version revision pipelinePollIntervalSeconds cacheTtlSeconds verifiedAt updatedAt viewer { id username name avatarUrl webUrl }";
const PROJECT_FIELDS =
  "id name pathWithNamespace webUrl defaultBranch visibility enabled webhookId webhookState webhookError webhookConfiguredAt webhookLastReceivedAt";

function announceChange() {
  window.dispatchEvent(new Event("source-control-settings-changed"));
}

export function GitLabSettingsCard() {
  const t = useTranslations("gitlabSettings");
  const common = useTranslations("common");
  const credentialsReadOnly = useCredentialStoreReadOnly();
  const [settings, setSettings] = useState<GitLabSettingsView | null>(null);
  const [projects, setProjects] = useState<GitLabProjectView[]>([]);
  const [candidates, setCandidates] = useState<GitLabProjectCandidateView[]>(
    [],
  );
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [pollInterval, setPollInterval] = useState(60);
  const [search, setSearch] = useState("");
  const [manualToken, setManualToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applySettings = useCallback((next: GitLabSettingsView) => {
    setSettings(next);
    setBaseUrl(next.baseUrl ?? "https://gitlab.com");
    setPollInterval(next.pipelinePollIntervalSeconds);
    setToken("");
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        gitlabSettings: GitLabSettingsView;
        gitlabProjects: GitLabProjectView[];
      }>(`query GitLabSettingsCard {
        gitlabSettings { ${SETTINGS_FIELDS} }
        gitlabProjects { ${PROJECT_FIELDS} }
      }`);
      applySettings(data.gitlabSettings);
      setProjects(data.gitlabProjects);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveGitLabSettings: GitLabSettingsView;
      }>(
        `mutation SaveGitLabSettings($input: SaveGitLabSettingsInput!) {
          saveGitLabSettings(input: $input) { ${SETTINGS_FIELDS} }
        }`,
        {
          input: {
            baseUrl: baseUrl.trim(),
            accessToken: token || null,
            pipelinePollIntervalSeconds: pollInterval,
          },
        },
      );
      applySettings(data.saveGitLabSettings);
      setError(null);
      setNotice(t("saved"));
      announceChange();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        testGitLabConnection: GitLabSettingsView;
      }>(
        `mutation TestGitLabConnection { testGitLabConnection { ${SETTINGS_FIELDS} } }`,
      );
      applySettings(data.testGitLabConnection);
      setError(null);
      setNotice(t("connectionSucceeded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        clearGitLabCredentials: GitLabSettingsView;
      }>(
        `mutation ClearGitLabCredentials { clearGitLabCredentials { ${SETTINGS_FIELDS} } }`,
      );
      applySettings(data.clearGitLabCredentials);
      setProjects([]);
      setCandidates([]);
      setManualToken(null);
      setError(null);
      setNotice(t("removed"));
      announceChange();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const findProjects = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        gitlabAvailableProjects: { items: GitLabProjectCandidateView[] };
      }>(
        `query GitLabAvailableProjects($search: String) {
        gitlabAvailableProjects(search: $search) {
          items { id name pathWithNamespace webUrl defaultBranch visibility alreadyManaged }
        }
      }`,
        { search: search.trim() || null },
      );
      setCandidates(data.gitlabAvailableProjects.items);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const addProject = async (projectId: string) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        addGitLabProject: GitLabProjectView[];
      }>(
        `mutation AddGitLabProject($projectId: ID!) {
          addGitLabProject(projectId: $projectId) { ${PROJECT_FIELDS} }
        }`,
        { projectId },
      );
      setProjects(data.addGitLabProject);
      setCandidates((items) =>
        items.map((item) =>
          item.id === projectId ? { ...item, alreadyManaged: true } : item,
        ),
      );
      setNotice(t("projectAdded"));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const configureWebhook = async (projectId: string) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        configureGitLabProjectWebhook: GitLabWebhookSetupView;
      }>(
        `mutation ConfigureGitLabProjectWebhook($projectId: ID!) {
        configureGitLabProjectWebhook(projectId: $projectId) {
          callbackUrl signingToken manualConfigurationRequired
          project { ${PROJECT_FIELDS} }
        }
      }`,
        { projectId },
      );
      const setup = data.configureGitLabProjectWebhook;
      setProjects((items) =>
        items.map((item) => (item.id === projectId ? setup.project : item)),
      );
      setManualToken(setup.signingToken);
      setNotice(
        setup.manualConfigurationRequired
          ? t("manualWebhookRequired", { callbackUrl: setup.callbackUrl })
          : t("webhookConfigured"),
      );
      setError(null);
      announceChange();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (projectId: string) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        removeGitLabProject: GitLabProjectView[];
      }>(
        `mutation RemoveGitLabProject($projectId: ID!) {
          removeGitLabProject(projectId: $projectId) { ${PROJECT_FIELDS} }
        }`,
        { projectId },
      );
      setProjects(data.removeGitLabProject);
      setCandidates((items) =>
        items.map((item) =>
          item.id === projectId ? { ...item, alreadyManaged: false } : item,
        ),
      );
      setNotice(t("projectRemoved"));
      setError(null);
      announceChange();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <GitFork className="size-5" />
              <div>
                <h2 className="font-semibold">{t("title")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("description")}
                </p>
              </div>
            </div>
            <Badge
              className={
                settings?.configured
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : undefined
              }
            >
              {settings?.configured ? t("configured") : t("notConfigured")}
            </Badge>
          </div>

          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("loading")}
            </p>
          ) : (
            <>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 />
                  <AlertDescription className="whitespace-pre-wrap text-current">
                    {notice}
                  </AlertDescription>
                </Alert>
              )}
              {manualToken && (
                <Alert>
                  <AlertDescription>
                    <p>{t("manualSigningToken")}</p>
                    <code className="mt-2 block break-all rounded bg-muted p-2 text-xs">
                      {manualToken}
                    </code>
                  </AlertDescription>
                </Alert>
              )}

              <div>
                <Label className="mb-1.5 block" htmlFor="gitlab-base-url">
                  {t("baseUrl")}
                </Label>
                <Input
                  disabled={credentialsReadOnly}
                  id="gitlab-base-url"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://gitlab.com"
                  required
                  type="url"
                  value={baseUrl}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("baseUrlHelp")}
                </p>
              </div>
              <div>
                <Label className="mb-1.5 block" htmlFor="gitlab-token">
                  {t("accessToken")}
                </Label>
                <Input
                  autoComplete="new-password"
                  disabled={credentialsReadOnly}
                  id="gitlab-token"
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={
                    settings?.tokenConfigured
                      ? t("tokenConfiguredPlaceholder")
                      : t("tokenPlaceholder")
                  }
                  required={!settings?.tokenConfigured && !credentialsReadOnly}
                  type="password"
                  value={token}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("tokenHelp")}
                </p>
              </div>
              <div>
                <Label className="mb-1.5 block" htmlFor="gitlab-poll-interval">
                  {t("pollInterval")}
                </Label>
                <Input
                  id="gitlab-poll-interval"
                  max={3600}
                  min={30}
                  onChange={(event) =>
                    setPollInterval(Number(event.target.value))
                  }
                  required
                  type="number"
                  value={pollInterval}
                />
              </div>
              {settings?.viewer && (
                <Alert>
                  <AlertDescription>
                    <a
                      className="font-medium text-primary hover:underline"
                      href={settings.viewer.webUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {settings.viewer.name} (@{settings.viewer.username}){" "}
                      <ExternalLink className="inline size-3" />
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {t("version", { version: settings.version ?? "—" })}
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <ConfirmationDialog
                  actionLabel={t("remove")}
                  cancelLabel={common("cancel")}
                  description={t("confirmRemoveDescription")}
                  onConfirm={clear}
                  title={t("confirmRemove")}
                  trigger={
                    <Button
                      disabled={
                        busy || !settings?.configured || credentialsReadOnly
                      }
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                      {t("remove")}
                    </Button>
                  }
                />
                <Button
                  disabled={busy || !settings?.configured}
                  onClick={() => void testConnection()}
                  type="button"
                  variant="outline"
                >
                  <Unplug />
                  {t("test")}
                </Button>
                <Button disabled={busy || credentialsReadOnly} type="submit">
                  {busy ? <Spinner /> : <Save />}
                  {t("save")}
                </Button>
              </div>

              {settings?.configured && (
                <div className="space-y-4 border-t pt-5">
                  <div>
                    <h3 className="font-medium">{t("projectsTitle")}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("projectsDescription")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("searchProjects")}
                      value={search}
                    />
                    <Button
                      disabled={busy}
                      onClick={() => void findProjects()}
                      type="button"
                      variant="outline"
                    >
                      {t("search")}
                    </Button>
                  </div>
                  {candidates.length > 0 && (
                    <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-2">
                      {candidates.map((candidate) => (
                        <div
                          className="flex items-center justify-between gap-2 rounded-md p-2 hover:bg-muted/50"
                          key={candidate.id}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {candidate.pathWithNamespace}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {candidate.visibility}
                            </p>
                          </div>
                          <Button
                            disabled={busy || candidate.alreadyManaged}
                            onClick={() => void addProject(candidate.id)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Plus />
                            {candidate.alreadyManaged ? t("managed") : t("add")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-2">
                    {projects.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("noProjects")}
                      </p>
                    ) : (
                      projects.map((project) => (
                        <div className="rounded-lg border p-3" key={project.id}>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <a
                                className="truncate text-sm font-medium text-primary hover:underline"
                                href={project.webUrl}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {project.pathWithNamespace}
                              </a>
                              <p className="text-xs text-muted-foreground">
                                {t("webhookState", {
                                  state: project.webhookState,
                                })}
                              </p>
                              {project.webhookError && (
                                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                                  {project.webhookError}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void configureWebhook(project.id)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                <Webhook />
                                {t("configureWebhook")}
                              </Button>
                              <ConfirmationDialog
                                actionLabel={t("removeProject")}
                                cancelLabel={common("cancel")}
                                description={t("removeProjectDescription")}
                                onConfirm={() => removeProject(project.id)}
                                title={t("removeProject")}
                                trigger={
                                  <Button
                                    disabled={busy}
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <Trash2 />
                                    <span className="sr-only">
                                      {t("removeProject")}
                                    </span>
                                  </Button>
                                }
                              />
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
