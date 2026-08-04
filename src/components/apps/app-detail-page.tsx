"use client";

import {
  Boxes,
  ClipboardList,
  FolderGit2,
  GitBranch,
  Hammer,
  MessagesSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { BuildsPage } from "@/components/builds/builds-page";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { RunsPage } from "@/components/runs/runs-page";
import { WorktreesPage } from "@/components/worktrees/worktrees-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { AppBuildLauncher } from "./app-build-launcher";
import { AppEditorDialog } from "./app-editor-dialog";
import { subscribeToAppSummaryChanges } from "./app-summary-subscriptions";
import {
  APP_FIELDS,
  APP_REPOSITORY_FIELDS,
  type AppRepository,
  type ManagedApp,
} from "./types";

export type AppDetailView =
  "overview" | "repositories" | "worktrees" | "plans" | "sessions" | "builds";

const VIEWS: Array<{
  value: AppDetailView;
  icon: typeof Boxes;
}> = [
  { value: "overview", icon: Boxes },
  { value: "repositories", icon: FolderGit2 },
  { value: "worktrees", icon: GitBranch },
  { value: "plans", icon: ClipboardList },
  { value: "sessions", icon: MessagesSquare },
  { value: "builds", icon: Hammer },
];

export function AppDetailPage({
  appId,
  view,
}: {
  appId: string;
  view: AppDetailView;
}) {
  const t = useTranslations("apps");
  const router = useRouter();
  const [app, setApp] = useState<ManagedApp | null>(null);
  const [repositories, setRepositories] = useState<AppRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        app: ManagedApp | null;
        codebaseOverview: { repositories: AppRepository[] };
      }>(
        `query AppDetail($id: ID!) {
          app(id: $id) { ${APP_FIELDS} }
          codebaseOverview { repositories { ${APP_REPOSITORY_FIELDS} } }
        }`,
        { id: appId },
      );
      setApp(data.app);
      setRepositories(data.codebaseOverview.repositories);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = subscribeToAppSummaryChanges(() => void load());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const remove = async () => {
    try {
      await controlPlaneRequest(
        `mutation DeleteApp($id: ID!) { deleteApp(id: $id) { id } }`,
        { id: appId },
      );
      router.push("/apps");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setDeleteOpen(false);
    }
  };

  if (loading && !app) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }

  if (!app) {
    return (
      <Empty className="border py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Boxes />
          </EmptyMedia>
          <EmptyTitle>{t("notFound")}</EmptyTitle>
          <EmptyDescription>
            {error ?? t("notFoundDescription")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const scopeKey = `${app.id}:${app.updatedAt}`;

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {app.name}
            </h1>
            <Badge variant="secondary">
              {t("repositoryCount", { count: app.counts.repositories })}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {app.description || t("noDescription")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setEditorOpen(true)} variant="outline">
            <Pencil /> {t("edit")}
          </Button>
          <Button onClick={() => setDeleteOpen(true)} variant="destructive">
            <Trash2 /> {t("delete")}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <nav
        aria-label={t("appViews")}
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
      >
        {VIEWS.map(({ value, icon: Icon }) => (
          <Button
            asChild
            className={cn("shrink-0", view === value && "shadow-sm")}
            key={value}
            size="sm"
            variant={view === value ? "default" : "ghost"}
          >
            <Link href={`/apps/${app.id}?view=${value}`}>
              <Icon /> {t(`views.${value}`)}
            </Link>
          </Button>
        ))}
      </nav>

      {view === "overview" && <AppOverview app={app} />}
      {view === "repositories" && <AppRepositories app={app} />}
      {view === "worktrees" && (
        <WorktreesPage appId={app.id} key={`${scopeKey}:worktrees`} />
      )}
      {view === "plans" && (
        <RunsPage appId={app.id} key={`${scopeKey}:plans`} kind="PLAN" />
      )}
      {view === "sessions" && (
        <RunsPage appId={app.id} key={`${scopeKey}:sessions`} kind="SESSION" />
      )}
      {view === "builds" && (
        <div className="space-y-6" key={`${scopeKey}:builds`}>
          <AppBuildLauncher appId={app.id} />
          <BuildsPage appId={app.id} />
        </div>
      )}

      <AppEditorDialog
        app={app}
        key={`${app.id}:${editorOpen ? "edit-open" : "edit-closed"}`}
        onOpenChange={setEditorOpen}
        onSaved={async () => load()}
        open={editorOpen}
        repositories={repositories}
      />
      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        description={t("deleteDescription", { name: app.name })}
        onConfirm={remove}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("deleteTitle")}
      />
    </section>
  );
}

function AppOverview({ app }: { app: ManagedApp }) {
  const t = useTranslations("apps");
  const resources: Array<{
    view: AppDetailView;
    value: number;
    icon: typeof Boxes;
  }> = [
    { view: "repositories", value: app.counts.repositories, icon: FolderGit2 },
    { view: "worktrees", value: app.counts.worktrees, icon: GitBranch },
    { view: "plans", value: app.counts.plans, icon: ClipboardList },
    { view: "sessions", value: app.counts.sessions, icon: MessagesSquare },
    { view: "builds", value: app.counts.builds, icon: Hammer },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {resources.map(({ view, value, icon: Icon }) => (
          <Card key={view}>
            <CardContent className="flex items-center gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Icon />
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">
                  {value}
                </div>
                <Link
                  className="text-sm text-muted-foreground hover:text-foreground"
                  href={`/apps/${app.id}?view=${view}`}
                >
                  {t(`views.${view}`)}
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("assignedRepositories")}</CardTitle>
          <CardDescription>
            {t("assignedRepositoriesDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {app.repositories.map((repository) => (
            <Badge key={repository.id} variant="secondary">
              <FolderGit2 /> {repository.name}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AppRepositories({ app }: { app: ManagedApp }) {
  const t = useTranslations("apps");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {app.repositories.map((repository) => (
        <Card key={repository.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderGit2 /> {repository.name}
            </CardTitle>
            <CardDescription>{repository.displayOrigin}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {repository.description || t("noRepositoryDescription")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {t("checkoutCount", { count: repository.codebases.length })}
              </Badge>
              <Button asChild size="sm" variant="outline">
                <Link href={`/codebases/repositories/${repository.id}`}>
                  {t("manageRepository")}
                </Link>
              </Button>
            </div>
            {repository.codebases.map((codebase) => (
              <div className="rounded-lg border p-3" key={codebase.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">
                      {codebase.folder}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {codebase.agent.name} · {codebase.branch ?? t("detached")}
                    </p>
                  </div>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/codebases/${codebase.id}`}>{t("open")}</Link>
                  </Button>
                </div>
              </div>
            ))}
            {!repository.codebases.length && (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t("repositoryWithoutCheckout")}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
