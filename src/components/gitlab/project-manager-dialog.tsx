"use client";

import {
  CheckCircle2,
  FolderCog,
  Plus,
  Save,
  Search,
  Trash2,
  Webhook,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitLabProjectCandidateView,
  GitLabProjectView,
  GitLabSettingsView,
  GitLabWebhookSetupView,
  Paginated,
} from "@/services/gitlab";

const SETTINGS_FIELDS =
  "configured tokenConfigured baseUrl version revision pipelinePollIntervalSeconds cacheTtlSeconds memberProjectsOnly defaultSquash defaultMoveTicketToDone defaultDeleteWorktree verifiedAt updatedAt viewer { id username name avatarUrl webUrl }";
const PROJECT_FIELDS =
  "id name pathWithNamespace webUrl defaultBranch visibility enabled webhookId webhookState webhookError webhookConfiguredAt webhookLastReceivedAt";

function announceChange() {
  window.dispatchEvent(new Event("source-control-settings-changed"));
}

export function GitLabProjectManagerDialog({
  onChanged,
  projects,
  settings,
}: {
  onChanged: () => Promise<void>;
  projects: GitLabProjectView[];
  settings: GitLabSettingsView;
}) {
  const t = useTranslations("gitlabSettings");
  const common = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [manualProject, setManualProject] = useState("");
  const [candidates, setCandidates] = useState<GitLabProjectCandidateView[]>(
    [],
  );
  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [memberProjectsOnly, setMemberProjectsOnly] = useState(
    settings.memberProjectsOnly,
  );
  const [defaultSquash, setDefaultSquash] = useState(settings.defaultSquash);
  const [defaultMoveTicketToDone, setDefaultMoveTicketToDone] = useState(
    settings.defaultMoveTicketToDone,
  );
  const [defaultDeleteWorktree, setDefaultDeleteWorktree] = useState(
    settings.defaultDeleteWorktree,
  );

  const loadAvailable = useCallback(
    async (query: string, requestedPage = 1) => {
      setBrowseLoading(true);
      try {
        const data = await controlPlaneRequest<{
          gitlabAvailableProjects: Paginated<GitLabProjectCandidateView>;
        }>(
          `query GitLabAvailableProjects($search: String, $page: Int!) {
          gitlabAvailableProjects(search: $search, page: $page, perPage: 50) {
            items { id name pathWithNamespace webUrl defaultBranch visibility alreadyManaged }
            total page perPage nextPage
          }
        }`,
          { search: query.trim() || null, page: requestedPage },
        );
        setCandidates(data.gitlabAvailableProjects.items);
        setPage(data.gitlabAvailableProjects.page);
        setNextPage(data.gitlabAvailableProjects.nextPage);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setBrowseLoading(false);
      }
    },
    [],
  );

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setMemberProjectsOnly(settings.memberProjectsOnly);
    setDefaultSquash(settings.defaultSquash);
    setDefaultMoveTicketToDone(settings.defaultMoveTicketToDone);
    setDefaultDeleteWorktree(settings.defaultDeleteWorktree);
    setSearch("");
    setNotice(null);
    setError(null);
    void loadAvailable("", 1);
  };

  const savePreferences = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest<{ saveGitLabPreferences: GitLabSettingsView }>(
        `mutation SaveGitLabPreferences($input: SaveGitLabPreferencesInput!) {
          saveGitLabPreferences(input: $input) { ${SETTINGS_FIELDS} }
        }`,
        {
          input: {
            memberProjectsOnly,
            defaultSquash,
            defaultMoveTicketToDone,
            defaultDeleteWorktree,
          },
        },
      );
      setNotice(t("preferencesSaved"));
      setError(null);
      announceChange();
      await onChanged();
      await loadAvailable(search, 1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const addProject = async (projectIdentifier: string) => {
    const projectId = projectIdentifier.trim();
    if (!projectId) return;
    setBusy(true);
    try {
      await controlPlaneRequest<{ addGitLabProject: GitLabProjectView[] }>(
        `mutation AddGitLabProject($projectId: ID!) {
          addGitLabProject(projectId: $projectId) { ${PROJECT_FIELDS} }
        }`,
        { projectId },
      );
      setManualProject("");
      setNotice(t("projectAdded"));
      setError(null);
      announceChange();
      await onChanged();
      await loadAvailable(search, page);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void addProject(manualProject);
  };

  const removeProject = async (projectId: string) => {
    setBusy(true);
    try {
      await controlPlaneRequest<{ removeGitLabProject: GitLabProjectView[] }>(
        `mutation RemoveGitLabProject($projectId: ID!) {
          removeGitLabProject(projectId: $projectId) { ${PROJECT_FIELDS} }
        }`,
        { projectId },
      );
      setNotice(t("projectRemoved"));
      setError(null);
      announceChange();
      await onChanged();
      await loadAvailable(search, page);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
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
      setManualToken(setup.signingToken);
      setNotice(
        setup.manualConfigurationRequired
          ? t("manualWebhookRequired", { callbackUrl: setup.callbackUrl })
          : t("webhookConfigured"),
      );
      setError(null);
      announceChange();
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FolderCog />
          {t("manageTitle")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
          <DialogDescription>{t("manageDescription")}</DialogDescription>
        </DialogHeader>
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
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          <section className="min-w-0 space-y-4">
            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <h3 className="font-medium">{t("preferencesTitle")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("preferencesDescription")}
                </p>
              </div>
              {[
                [
                  "gitlab-member-projects-only",
                  memberProjectsOnly,
                  setMemberProjectsOnly,
                  t("memberProjectsOnly"),
                ],
                [
                  "gitlab-default-squash",
                  defaultSquash,
                  setDefaultSquash,
                  t("defaultSquash"),
                ],
                [
                  "gitlab-default-move-ticket",
                  defaultMoveTicketToDone,
                  setDefaultMoveTicketToDone,
                  t("defaultMoveTicketToDone"),
                ],
                [
                  "gitlab-default-delete-worktree",
                  defaultDeleteWorktree,
                  setDefaultDeleteWorktree,
                  t("defaultDeleteWorktree"),
                ],
              ].map(([id, checked, setter, label]) => (
                <div className="flex items-start gap-2" key={String(id)}>
                  <Checkbox
                    checked={Boolean(checked)}
                    disabled={busy}
                    id={String(id)}
                    onCheckedChange={(value) =>
                      (setter as (next: boolean) => void)(value === true)
                    }
                  />
                  <Label htmlFor={String(id)}>{String(label)}</Label>
                </div>
              ))}
              <Button
                disabled={busy}
                onClick={() => void savePreferences()}
                type="button"
              >
                {busy ? <Spinner /> : <Save />}
                {t("savePreferences")}
              </Button>
            </div>

            <div>
              <h3 className="font-medium">{t("projectsTitle")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("projectsDescription")}
              </p>
            </div>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noProjects")}</p>
            ) : (
              <div className="space-y-2">
                {projects.map((project) => (
                  <div className="rounded-lg border p-3" key={project.id}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <a
                          className="block truncate text-sm font-medium text-primary hover:underline"
                          href={project.webUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {project.pathWithNamespace}
                        </a>
                        <p className="text-xs text-muted-foreground">
                          {t("webhookState", { state: project.webhookState })}
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
                          onClick={() => void configureWebhook(project.id)}
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
                              size="icon-sm"
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
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 space-y-3">
            <h3 className="font-medium">{t("addProject")}</h3>
            <Tabs defaultValue="browse">
              <TabsList>
                <TabsTrigger value="browse">{t("browse")}</TabsTrigger>
                <TabsTrigger value="manual">{t("enterManually")}</TabsTrigger>
              </TabsList>
              <TabsContent className="mt-3 space-y-3" value="browse">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadAvailable(search, 1);
                  }}
                >
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label={t("searchProjects")}
                      className="pl-8"
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("searchProjects")}
                      value={search}
                    />
                  </div>
                  <Button
                    disabled={browseLoading}
                    type="submit"
                    variant="outline"
                  >
                    {t("search")}
                  </Button>
                </form>
                {browseLoading && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> {t("loadingProjects")}
                  </p>
                )}
                {!browseLoading && candidates.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {t("noProjectMatches")}
                  </p>
                )}
                <div className="space-y-2">
                  {candidates.map((candidate) => {
                    const managed =
                      candidate.alreadyManaged ||
                      projects.some((project) => project.id === candidate.id);
                    return (
                      <div
                        className="flex items-center justify-between gap-2 rounded-lg border p-3"
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
                          disabled={busy || managed}
                          onClick={() => void addProject(candidate.id)}
                          size="sm"
                          type="button"
                        >
                          <Plus />
                          {managed ? t("managed") : t("add")}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {(page > 1 || nextPage !== null) && (
                  <div className="flex justify-between gap-2">
                    <Button
                      disabled={browseLoading || page <= 1}
                      onClick={() => void loadAvailable(search, page - 1)}
                      type="button"
                      variant="outline"
                    >
                      {t("previous")}
                    </Button>
                    <Button
                      disabled={browseLoading || nextPage === null}
                      onClick={() =>
                        void loadAvailable(search, nextPage ?? page + 1)
                      }
                      type="button"
                      variant="outline"
                    >
                      {t("next")}
                    </Button>
                  </div>
                )}
              </TabsContent>
              <TabsContent className="mt-3" value="manual">
                <form className="space-y-3" onSubmit={submitManual}>
                  <div>
                    <Label
                      className="mb-1.5 block"
                      htmlFor="gitlab-project-identifier"
                    >
                      {t("projectIdentifier")}
                    </Label>
                    <Input
                      id="gitlab-project-identifier"
                      onChange={(event) => setManualProject(event.target.value)}
                      placeholder="12345 or namespace/project"
                      required
                      value={manualProject}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("projectIdentifierHelp")}
                    </p>
                  </div>
                  <Button
                    disabled={busy || !manualProject.trim()}
                    type="submit"
                  >
                    <Plus />
                    {t("add")}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
