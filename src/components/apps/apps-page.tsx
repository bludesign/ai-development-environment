"use client";

import { Boxes, FolderGit2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { isRowActivation } from "@/lib/row-activation";
import { cn } from "@/lib/utils";

import type { AppDetailView } from "./app-detail-page";
import { AppEditorDialog } from "./app-editor-dialog";
import { subscribeToAppSummaryChanges } from "./app-summary-subscriptions";
import {
  APP_FIELDS,
  APP_REPOSITORY_FIELDS,
  type AppRepository,
  type ManagedApp,
} from "./types";

export function AppsPage() {
  const t = useTranslations("apps");
  const router = useRouter();
  const [apps, setApps] = useState<ManagedApp[]>([]);
  const [repositories, setRepositories] = useState<AppRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        apps: ManagedApp[];
        codebaseOverview: { repositories: AppRepository[] };
      }>(`query AppsPage {
        apps { ${APP_FIELDS} }
        codebaseOverview { repositories { ${APP_REPOSITORY_FIELDS} } }
      }`);
      setApps(data.apps);
      setRepositories(data.codebaseOverview.repositories);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = subscribeToAppSummaryChanges(() => void load());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          disabled={!repositories.length}
          onClick={() => setEditorOpen(true)}
        >
          <Plus /> {t("createApp")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : !apps.length ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Boxes />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {apps.map((app) => (
            <Card
              className="cursor-pointer transition-colors hover:bg-muted/30"
              key={app.id}
              /* The whole card opens the app; the count tiles, badges, and
                 footer button inside it keep their own behaviour. */
              onClick={(event) => {
                if (!isRowActivation(event)) return;
                router.push(`/apps/${app.id}`);
              }}
            >
              <CardHeader>
                <CardTitle>{app.name}</CardTitle>
                <CardDescription>
                  {app.description || t("noDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {app.repositories.map((repository) => (
                    <Badge key={repository.id} variant="secondary">
                      <FolderGit2 /> {repository.name}
                    </Badge>
                  ))}
                </div>
                <div
                  className={cn(
                    "grid gap-3 text-center",
                    app.counts.dirtyWorktrees > 0
                      ? "grid-cols-4"
                      : "grid-cols-3",
                  )}
                >
                  {app.counts.dirtyWorktrees > 0 && (
                    <AppListCount
                      appId={app.id}
                      destructive
                      label={t("dirtyWorktrees")}
                      value={app.counts.dirtyWorktrees}
                      view="worktrees"
                    />
                  )}
                  <AppListCount
                    appId={app.id}
                    label={t("worktrees")}
                    value={app.counts.worktrees}
                    view="worktrees"
                  />
                  <AppListCount
                    appId={app.id}
                    label={t("plans")}
                    value={app.counts.plans}
                    view="plans"
                  />
                  <AppListCount
                    appId={app.id}
                    label={t("sessions")}
                    value={app.counts.sessions}
                    view="sessions"
                  />
                </div>
              </CardContent>
              <CardFooter className="mt-auto justify-end">
                <Button asChild>
                  <Link href={`/apps/${app.id}`}>{t("openApp")}</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <AppEditorDialog
        key={editorOpen ? "create-open" : "create-closed"}
        onOpenChange={setEditorOpen}
        onSaved={async () => load()}
        open={editorOpen}
        repositories={repositories}
      />
    </section>
  );
}

/**
 * A count tile that jumps straight to its own tab on the app page, rather than
 * to the app's overview the way the rest of the card does.
 */
function AppListCount({
  appId,
  label,
  value,
  view,
  destructive = false,
}: {
  appId: string;
  destructive?: boolean;
  label: string;
  value: number;
  view: AppDetailView;
}) {
  return (
    <Link
      className={cn(
        "block rounded-lg p-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        destructive
          ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "bg-muted/50 hover:bg-muted",
      )}
      href={`/apps/${appId}?view=${view}`}
    >
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div
        className={cn(
          "text-xs",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
    </Link>
  );
}
