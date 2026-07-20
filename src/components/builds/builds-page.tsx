"use client";

import { Hammer, Plus, ScrollText, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import {
  buildDuration,
  buildSnapshotName,
  buildStatusVariant,
  relativeBuildAge,
} from "./build-format";
import { BUILD_LIST_FIELDS } from "./graphql-fields";
import { RebuildButton } from "./rebuild-button";
import type { BuildRecord, BuildScript } from "./types";
import { RunBuildControls } from "./run-build-controls";
import { useBuildTimeTicker } from "./use-build-time-ticker";

const SCRIPT_FIELDS = `
  id name preBuildScript postBuildScript enabledByDefault timeoutSeconds failureBehavior createdAt updatedAt
`;

const PRE_BUILD_TEMPLATE = `export default async function preBuild({
  buildId,
  branch,
  destination,
  action,
  telemetry,
}) {
  // Runs before the build from the worktree root.
    // telemetry includes localBaseUrl, remoteBaseUrl, selectedBaseUrl,
    // consoleLogsUrl, analyticsEventsUrl, and both collection-enabled flags.
}`;

const POST_BUILD_TEMPLATE = `export default async function postBuild({
  buildId,
  branch,
  destination,
  action,
  buildFolder,
  failed,
  cancelled,
  errorCode,
  error,
  telemetry,
  }) {
    // Runs after every build attempt from the worktree root.
    // telemetry is the same immutable URL and collection-settings snapshot.
  }`;

const STATUSES = [
  "ALL",
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export function BuildsPage() {
  const t = useTranslations("builds");
  const locale = useLocale();
  const router = useRouter();
  const buildTime = useBuildTimeTicker();
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [scripts, setScripts] = useState<BuildScript[]>([]);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("ALL");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<BuildScript | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (after?: string | null) => {
      if (after) setLoadingMore(true);
      else setLoading(true);
      try {
        const data = await controlPlaneRequest<{
          builds: { items: BuildRecord[]; nextCursor: string | null };
          buildScripts: BuildScript[];
        }>(
          `query BuildsPage($after: ID, $status: BuildStatus) {
            builds(first: 50, after: $after, status: $status) {
              items { ${BUILD_LIST_FIELDS} }
              nextCursor
            }
            buildScripts { ${SCRIPT_FIELDS} }
          }`,
          { after: after ?? null, status: status === "ALL" ? null : status },
        );
        setBuilds((current) =>
          after ? [...current, ...data.builds.items] : data.builds.items,
        );
        setNextCursor(data.builds.nextCursor);
        setScripts(data.buildScripts);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(
    () =>
      controlPlaneSubscriptions().subscribe<{ buildsChanged: { id: string } }>(
        { query: `subscription BuildsChanged { buildsChanged { id } }` },
        {
          next: () => void load(),
          error: () => undefined,
          complete: () => undefined,
        },
      ),
    [load],
  );

  const deleteScript = async (id: string) => {
    try {
      await controlPlaneRequest(
        `mutation DeleteBuildScript($id: ID!) { deleteBuildScript(id: $id) }`,
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const groupedBuilds = useMemo(() => {
    const groups: Array<{
      key: string;
      dateKey: string;
      label: string;
      items: BuildRecord[];
    }> = [];
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
    for (const build of builds) {
      const timestamp = build.startedAt ?? build.createdAt;
      const buildDate = new Date(timestamp);
      const dateKey = `${buildDate.getFullYear()}-${buildDate.getMonth()}-${buildDate.getDate()}`;
      const group = groups.at(-1);
      if (group?.dateKey === dateKey) group.items.push(build);
      else {
        groups.push({
          key: `${dateKey}-${build.id}`,
          dateKey,
          label: formatter.format(buildDate),
          items: [build],
        });
      }
    }
    return groups;
  }, [builds, locale]);

  const deleteSelected = async () => {
    if (!selected.size) return;
    setDeleting(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation DeleteBuilds($ids: [ID!]!) { deleteBuilds(ids: $ids) }`,
        { ids: [...selected] },
      );
      setSelected(new Set());
      setDeleteOpen(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setDeleting(false);
    }
  };

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
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">
            <Hammer /> {t("history")}
          </TabsTrigger>
          <TabsTrigger value="scripts">
            <ScrollText /> {t("buildScripts")}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="space-y-4" value="history">
          <div className="flex flex-wrap justify-end gap-2">
            {selected.size > 0 && (
              <Button
                disabled={deleting}
                onClick={() => setDeleteOpen(true)}
                variant="destructive"
              >
                {deleting ? <Spinner /> : <Trash2 />}
                {t("deleteSelected", { count: selected.size })}
              </Button>
            )}
            <Select
              onValueChange={(value) => {
                setSelected(new Set());
                setStatus(value as typeof status);
              }}
              value={status}
            >
              <SelectTrigger className="w-48" aria-label={t("filterStatus")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === "ALL"
                      ? t("allStatuses")
                      : t(`statuses.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {loading && !builds.length ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> {t("loading")}
            </p>
          ) : !builds.length ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Hammer />
                </EmptyMedia>
                <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-3">
              <Card className="gap-0 py-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12">
                        <span className="sr-only">{t("selectBuilds")}</span>
                      </TableHead>
                      <TableHead>{t("build")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead>{t("action")}</TableHead>
                      <TableHead>{t("destination")}</TableHead>
                      <TableHead>{t("startedAt")}</TableHead>
                      <TableHead className="text-right">
                        {t("actionsLabel")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupedBuilds.map((group) => {
                      const groupIds = group.items.map((build) => build.id);
                      const selectedCount = groupIds.filter((id) =>
                        selected.has(id),
                      ).length;
                      return (
                        <Fragment key={group.key}>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell className="py-1.5">
                              <Checkbox
                                aria-label={t("selectDate", {
                                  date: group.label,
                                })}
                                checked={
                                  selectedCount === groupIds.length
                                    ? true
                                    : selectedCount > 0
                                      ? "indeterminate"
                                      : false
                                }
                                onCheckedChange={(checked) =>
                                  setSelected((current) => {
                                    const next = new Set(current);
                                    for (const id of groupIds) {
                                      if (checked === true) next.add(id);
                                      else next.delete(id);
                                    }
                                    return next;
                                  })
                                }
                              />
                            </TableCell>
                            <TableCell
                              className="py-1.5 text-xs font-normal text-muted-foreground"
                              colSpan={6}
                            >
                              {group.label}
                            </TableCell>
                          </TableRow>
                          {group.items.map((build) => {
                            const names = buildSnapshotName(build);
                            const startedAt =
                              build.startedAt ?? build.createdAt;
                            const runnable =
                              build.status === "SUCCEEDED" &&
                              build.artifacts.some(
                                (artifact) => artifact.kind === "RUNNABLE_APP",
                              );
                            return (
                              <TableRow
                                aria-label={t("viewBuild")}
                                className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                                key={build.id}
                                onClick={() =>
                                  router.push(`/builds/${build.id}`)
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                  ) {
                                    event.preventDefault();
                                    router.push(`/builds/${build.id}`);
                                  }
                                }}
                                role="link"
                                tabIndex={0}
                              >
                                <TableCell
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => event.stopPropagation()}
                                >
                                  <Checkbox
                                    aria-label={t("selectBuild", {
                                      id: build.id,
                                    })}
                                    checked={selected.has(build.id)}
                                    onCheckedChange={(checked) =>
                                      setSelected((current) => {
                                        const next = new Set(current);
                                        if (checked === true)
                                          next.add(build.id);
                                        else next.delete(build.id);
                                        return next;
                                      })
                                    }
                                  />
                                </TableCell>
                                <TableCell className="min-w-56 whitespace-normal">
                                  <Link
                                    className="font-medium hover:underline"
                                    href={`/builds/${build.id}`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    {names.repository}
                                  </Link>
                                  <p className="font-mono text-xs text-muted-foreground">
                                    {names.worktree}
                                  </p>
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1.5">
                                    <Badge
                                      variant={buildStatusVariant(build.status)}
                                    >
                                      {t(`statuses.${build.status}`)}
                                    </Badge>
                                    {build.outOfDate && (
                                      <Badge
                                        className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                                        variant="outline"
                                      >
                                        {t("outOfDate")}
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {t(`actions.${build.action}`)}
                                  </Badge>
                                </TableCell>
                                <TableCell>{build.destination.name}</TableCell>
                                <TableCell className="text-muted-foreground">
                                  <div className="flex flex-col gap-0.5">
                                    <time
                                      dateTime={startedAt}
                                      title={new Date(startedAt).toLocaleString(
                                        locale,
                                      )}
                                    >
                                      {relativeBuildAge(
                                        startedAt,
                                        locale,
                                        buildTime,
                                      )}
                                    </time>
                                    <span className="text-xs">
                                      {t("durationValue", {
                                        duration: buildDuration(
                                          build,
                                          buildTime,
                                        ),
                                      })}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <RebuildButton
                                      buildId={build.id}
                                      onCompleted={() => load()}
                                      onError={setError}
                                      size="sm"
                                    />
                                    {runnable && (
                                      <RunBuildControls
                                        buildId={build.id}
                                        destinationType={build.destinationType}
                                        onCompleted={load}
                                        onError={setError}
                                        preferredDestination={build.destination}
                                        size="sm"
                                      />
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
              {nextCursor && (
                <div className="flex justify-center">
                  <Button
                    disabled={loadingMore}
                    onClick={() => void load(nextCursor)}
                    variant="outline"
                  >
                    {loadingMore && <Spinner />} {t("loadMore")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent className="space-y-4" value="scripts">
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setEditingScript(null);
                setScriptOpen(true);
              }}
            >
              <Plus /> {t("newScript")}
            </Button>
          </div>
          {!scripts.length ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScrollText />
                </EmptyMedia>
                <EmptyTitle>{t("noScripts")}</EmptyTitle>
                <EmptyDescription>{t("noScriptsDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {scripts.map((script) => (
                <Card key={script.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2">
                      <span>{script.name}</span>
                      {script.enabledByDefault && (
                        <Badge>{t("defaultEnabled")}</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {script.preBuildScript && (
                        <Badge variant="outline">{t("preBuild")}</Badge>
                      )}
                      {script.postBuildScript && (
                        <Badge variant="outline">{t("postBuild")}</Badge>
                      )}
                      <span>
                        {t("timeoutSeconds", { count: script.timeoutSeconds })}
                      </span>
                      <span>
                        {t(`failureBehaviors.${script.failureBehavior}`)}
                      </span>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        onClick={() => {
                          setEditingScript(script);
                          setScriptOpen(true);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        {t("edit")}
                      </Button>
                      <Button
                        aria-label={t("deleteScript")}
                        onClick={() => void deleteScript(script.id)}
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
        </TabsContent>
      </Tabs>
      {scriptOpen && (
        <BuildScriptDialog
          onOpenChange={setScriptOpen}
          onSaved={load}
          open={scriptOpen}
          script={editingScript}
        />
      )}
      <ConfirmationDialog
        actionLabel={t("deleteBuilds")}
        cancelLabel={t("cancel")}
        description={t("deleteBuildsDescription", { count: selected.size })}
        onConfirm={deleteSelected}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("deleteBuildsTitle", { count: selected.size })}
      />
    </section>
  );
}

function BuildScriptDialog({
  open,
  script,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  script: BuildScript | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("builds");
  const [name, setName] = useState(script?.name ?? "");
  const [pre, setPre] = useState(
    script ? (script.preBuildScript ?? "") : PRE_BUILD_TEMPLATE,
  );
  const [post, setPost] = useState(
    script ? (script.postBuildScript ?? "") : POST_BUILD_TEMPLATE,
  );
  const [enabled, setEnabled] = useState(script?.enabledByDefault ?? false);
  const [timeout, setTimeoutValue] = useState(script?.timeoutSeconds ?? 300);
  const [failure, setFailure] = useState<"FAIL_BUILD" | "CONTINUE">(
    script?.failureBehavior ?? "FAIL_BUILD",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation SaveBuildScript($input: SaveBuildScriptInput!) {
          saveBuildScript(input: $input) { id }
        }`,
        {
          input: {
            id: script?.id ?? null,
            name,
            preBuildScript: pre || null,
            postBuildScript: post || null,
            enabledByDefault: enabled,
            timeoutSeconds: timeout,
            failureBehavior: failure,
          },
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{script ? t("editScript") : t("newScript")}</DialogTitle>
          <DialogDescription>{t("scriptDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="build-script-name">{t("name")}</Label>
            <Input
              id="build-script-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pre-build-script">{t("preBuildScript")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("preBuildScriptHelp")}
            </p>
            <Textarea
              className="font-mono text-xs"
              id="pre-build-script"
              onChange={(event) => setPre(event.target.value)}
              rows={8}
              value={pre}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="post-build-script">{t("postBuildScript")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("postBuildScriptHelp")}
            </p>
            <Textarea
              className="font-mono text-xs"
              id="post-build-script"
              onChange={(event) => setPost(event.target.value)}
              rows={8}
              value={post}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="script-timeout">{t("timeout")}</Label>
              <Input
                id="script-timeout"
                min={1}
                max={3600}
                onChange={(event) =>
                  setTimeoutValue(Number(event.target.value))
                }
                type="number"
                value={timeout}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("failureBehavior")}</Label>
              <Select
                onValueChange={(value) => setFailure(value as typeof failure)}
                value={failure}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FAIL_BUILD">
                    {t("failureBehaviors.FAIL_BUILD")}
                  </SelectItem>
                  <SelectItem value="CONTINUE">
                    {t("failureBehaviors.CONTINUE")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
            />
            {t("enabledByDefault")}
          </label>
        </div>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || !name.trim() || (!pre.trim() && !post.trim())}
            onClick={() => void save()}
            type="button"
          >
            {busy && <Spinner />} {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
