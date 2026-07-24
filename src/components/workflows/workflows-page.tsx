"use client";

import {
  Archive,
  CirclePlay,
  FileUp,
  GitFork,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { workflowStatusVariant } from "./workflow-graph";
import type { WorkflowRun, WorkflowSummary } from "./types";

const WORKFLOW_FIELDS = `
  id name description draftDefinition activeVersionId enabled overlapPolicy maxConcurrentRuns archivedAt
  versionCount runCount createdAt updatedAt
`;

const RUN_FIELDS = `
  id displayNumber workflowId triggerKind triggerSubjectKey status phase generation
  blockedReason error queuedAt startedAt pausedAt finishedAt
  workflow { id name }
  version { id workflowId version name description schemaVersion definition contentHash publishedAt }
`;

export function WorkflowsPage() {
  const t = useTranslations("workflows");
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"workflows" | "runs">("workflows");
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        workflows: { items: WorkflowSummary[] };
        workflowRuns: { items: WorkflowRun[] };
      }>(`query WorkflowManagement {
        workflows(first: 200) { items { ${WORKFLOW_FIELDS} } }
        workflowRuns(first: 200) { items { ${RUN_FIELDS} } }
      }`);
      setWorkflows(data.workflows.items);
      setRuns(data.workflowRuns.items);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const subscriptions = controlPlaneSubscriptions();
    const dispose = subscriptions.subscribe<{
      workflowsChanged: { id: string } | null;
    }>(
      { query: "subscription WorkflowListChanges { workflowsChanged { id } }" },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      dispose();
    };
  }, [load]);

  const filteredWorkflows = useMemo(
    () =>
      workflows.filter((workflow) =>
        `${workflow.name} ${workflow.description}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search, workflows],
  );
  const filteredRuns = useMemo(
    () =>
      runs.filter((run) =>
        `${run.displayNumber} ${run.workflow.name} ${run.status} ${run.triggerKind}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [runs, search],
  );

  const mutateWorkflow = async (
    workflow: WorkflowSummary,
    operation: "enabled" | "archive" | "run",
  ) => {
    try {
      if (operation === "enabled") {
        await controlPlaneRequest(
          `mutation ToggleWorkflow($id: ID!, $enabled: Boolean!) { setWorkflowEnabled(id: $id, enabled: $enabled) { id } }`,
          { id: workflow.id, enabled: !workflow.enabled },
        );
      } else if (operation === "archive") {
        await controlPlaneRequest(
          `mutation ArchiveWorkflow($id: ID!) { archiveWorkflow(id: $id, archived: true) { id } }`,
          { id: workflow.id },
        );
      } else {
        const data = await controlPlaneRequest<{
          triggerWorkflow: { id: string };
        }>(
          `mutation TriggerWorkflow($input: TriggerWorkflowInput!) { triggerWorkflow(input: $input) { id } }`,
          { input: { workflowId: workflow.id, sessionData: {} } },
        );
        router.push(`/workflows/runs/${data.triggerWorkflow.id}`);
      }
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const importWorkflow = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const data = await controlPlaneRequest<{
        importWorkflow: { id: string };
      }>(
        `mutation ImportWorkflow($input: ImportWorkflowInput!) { importWorkflow(input: $input) { id } }`,
        { input: { payload } },
      );
      router.push(`/workflows/${data.importWorkflow.id}/edit`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("descriptionLong")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importWorkflow(file);
              event.target.value = "";
            }}
            ref={fileRef}
            type="file"
          />
          <Button onClick={() => fileRef.current?.click()} variant="outline">
            <FileUp /> {t("import")}
          </Button>
          <Button asChild>
            <Link href="/workflows/new">
              <Plus /> {t("newWorkflow")}
            </Link>
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          onValueChange={(value) => setTab(value as "workflows" | "runs")}
          value={tab}
        >
          <TabsList>
            <TabsTrigger value="workflows">{t("workflowsTab")}</TabsTrigger>
            <TabsTrigger value="runs">{t("allRuns")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <InputGroup className="w-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("search")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search")}
              value={search}
            />
          </InputGroup>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("refresh")}
                onClick={() => void load()}
                size="icon"
                variant="outline"
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("refresh")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <Card key={item}>
              <CardHeader>
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="h-4 w-4/5" />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-20" />
                </div>
                <Skeleton className="h-8 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : tab === "workflows" ? (
        filteredWorkflows.length ? (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredWorkflows.map((workflow) => (
              <Card key={workflow.id}>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate">
                      <Link
                        className="hover:underline"
                        href={`/workflows/${workflow.id}`}
                      >
                        {workflow.name}
                      </Link>
                    </CardTitle>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {workflow.description || t("noDescription")}
                    </p>
                  </div>
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={t("actions")}
                            size="icon"
                            variant="ghost"
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>{t("actions")}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/workflows/${workflow.id}/edit`}>
                          {t("edit")}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void mutateWorkflow(workflow, "enabled")}
                      >
                        {workflow.enabled ? t("pauseDefinition") : t("enable")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void mutateWorkflow(workflow, "archive")}
                      >
                        <Archive /> {t("archive")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={workflow.enabled ? "secondary" : "outline"}>
                      {workflow.enabled ? t("enabled") : t("disabled")}
                    </Badge>
                    <Badge variant="outline">
                      {t("versionCount", { count: workflow.versionCount })}
                    </Badge>
                    <Badge variant="outline">{workflow.overlapPolicy}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t("runCount", { count: workflow.runCount })}</span>
                    <DateTime kind="relative" value={workflow.updatedAt} />
                  </div>
                  <div className="flex gap-2">
                    <Button asChild className="flex-1" variant="outline">
                      <Link href={`/workflows/${workflow.id}/edit`}>
                        <GitFork /> {t("edit")}
                      </Link>
                    </Button>
                    <Button
                      className="flex-1"
                      disabled={!workflow.enabled}
                      onClick={() => void mutateWorkflow(workflow, "run")}
                    >
                      <CirclePlay /> {t("run")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="border py-16">
            <EmptyHeader>
              <EmptyTitle>{t("empty")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("run")}</TableHead>
                <TableHead>{t("workflow")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("trigger")}</TableHead>
                <TableHead>{t("generation")}</TableHead>
                <TableHead>{t("started")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      className="font-medium hover:underline"
                      href={`/workflows/runs/${run.id}`}
                    >
                      #{run.displayNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      href={`/workflows/${run.workflow.id}`}
                    >
                      {run.workflow.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={workflowStatusVariant(run.status)}>
                      {run.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{run.triggerKind}</TableCell>
                  <TableCell>{run.generation}</TableCell>
                  <TableCell>
                    {run.startedAt ? (
                      <DateTime kind="relative" value={run.startedAt} />
                    ) : (
                      t("queued")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!filteredRuns.length && (
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyTitle>{t("noRuns")}</EmptyTitle>
                <EmptyDescription>{t("descriptionLong")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}
