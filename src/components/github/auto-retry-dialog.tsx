"use client";

import { Pause, Pencil, Play, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubAutoRetryFailureStrategy,
  GitHubAutoRetryMode,
  GitHubAutoRetryRuleView,
  GitHubRepositoryWorkflowView,
  GitHubWorkflowJobView,
} from "@/services/github/types";

const RULE_FIELDS = `
  id scope codebaseRepositoryId repositoryGithubId worktreeId branch pullRequestNumber
  allWorkflows mode retryLimit failureStrategy status enabled lastError createdAt updatedAt
  targets { id workflowId workflowRunId jobName }
  executions { id workflowRunId workflowId targetKey status observedAttempt automaticRetries lastStatus lastError updatedAt }
`;

export type AutoRetryRunOption = {
  id: string;
  workflowId: string;
  name: string;
  jobs?: GitHubWorkflowJobView[];
};

export function AutoRetryDialog({
  codebaseRepositoryId,
  repositoryGithubId,
  currentRuns = [],
  allowFuture = false,
  worktreeId,
  branch,
  pullRequestNumber,
  repositoryMode = false,
  trigger,
}: {
  codebaseRepositoryId: string;
  repositoryGithubId?: string | null;
  currentRuns?: AutoRetryRunOption[];
  allowFuture?: boolean;
  worktreeId?: string | null;
  branch?: string | null;
  pullRequestNumber?: number | null;
  repositoryMode?: boolean;
  trigger?: ReactNode;
}) {
  const t = useTranslations("githubAutomation");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<GitHubAutoRetryRuleView[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [repositoryWorkflows, setRepositoryWorkflows] = useState<
    GitHubRepositoryWorkflowView[]
  >([]);
  const [hydratedRuns, setHydratedRuns] =
    useState<AutoRetryRunOption[]>(currentRuns);
  const [future, setFuture] = useState(repositoryMode);
  const [allWorkflows, setAllWorkflows] = useState(repositoryMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<GitHubAutoRetryMode>("FAILURE");
  const [limit, setLimit] = useState("3");
  const [unlimited, setUnlimited] = useState(false);
  const [failureStrategy, setFailureStrategy] =
    useState<GitHubAutoRetryFailureStrategy>("FAILED_JOBS");
  const currentRunsRef = useRef(currentRuns);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    currentRunsRef.current = currentRuns;
  }, [currentRuns]);

  const refreshRules = useCallback(async () => {
    const rulesData = await controlPlaneRequest<{
      githubAutoRetryRules: GitHubAutoRetryRuleView[];
      githubSettings: { tokenConfigured: boolean };
      githubAppSettings: {
        configured: boolean;
        actionsPermission: string | null;
      };
    }>(
      `query GitHubAutoRetryRules($codebaseRepositoryId: ID) {
        githubSettings { tokenConfigured }
        githubAppSettings { configured actionsPermission }
        githubAutoRetryRules(codebaseRepositoryId: $codebaseRepositoryId) { ${RULE_FIELDS} }
      }`,
      { codebaseRepositoryId },
    );
    setRules(rulesData.githubAutoRetryRules);
    setCredentialsReady(
      rulesData.githubSettings.tokenConfigured &&
        rulesData.githubAppSettings.configured &&
        rulesData.githubAppSettings.actionsPermission === "write",
    );
  }, [codebaseRepositoryId]);

  const refreshRepositoryWorkflows = useCallback(async () => {
    const workflowData = await controlPlaneRequest<{
      githubRepositoryWorkflows: GitHubRepositoryWorkflowView[];
    }>(
      `query GitHubRepositoryWorkflows($codebaseRepositoryId: ID!) {
        githubRepositoryWorkflows(codebaseRepositoryId: $codebaseRepositoryId) {
          id name path state url jobNames
        }
      }`,
      { codebaseRepositoryId },
    );
    setRepositoryWorkflows(workflowData.githubRepositoryWorkflows);
  }, [codebaseRepositoryId]);

  const load = useCallback(async () => {
    if (!loadedOnceRef.current) setLoading(true);
    setError(null);
    try {
      await refreshRules();

      if (repositoryMode) await refreshRepositoryWorkflows();

      const withJobs = await Promise.all(
        currentRunsRef.current.map(async (run) => {
          if (run.jobs?.length) return run;
          try {
            const data = await controlPlaneRequest<{
              githubActionsWorkflowJobs: GitHubWorkflowJobView[];
            }>(
              `query AutoRetryWorkflowJobs($repositoryId: ID!, $workflowRunId: ID!) {
                githubActionsWorkflowJobs(
                  codebaseRepositoryId: $repositoryId
                  workflowRunId: $workflowRunId
                ) { id name status url canRetry retryUnavailableReason runAttempt steps { number name status } }
              }`,
              { repositoryId: codebaseRepositoryId, workflowRunId: run.id },
            );
            return { ...run, jobs: data.githubActionsWorkflowJobs };
          } catch {
            return run;
          }
        }),
      );
      setHydratedRuns(withJobs);
      if (!repositoryMode) {
        setSelected((current) =>
          current.size
            ? current
            : new Set(withJobs.map((run) => `workflow:${run.id}`)),
        );
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      loadedOnceRef.current = true;
      setLoading(false);
    }
  }, [
    codebaseRepositoryId,
    refreshRepositoryWorkflows,
    refreshRules,
    repositoryMode,
  ]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(
      () => void refreshRules().catch(() => undefined),
      10_000,
    );
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [load, open, refreshRules]);

  const workflows = useMemo(
    () =>
      future
        ? repositoryWorkflows.map((workflow) => ({
            id: workflow.id,
            workflowId: workflow.id,
            name: workflow.name,
            jobNames: workflow.jobNames,
          }))
        : hydratedRuns.map((run) => ({
            id: run.id,
            workflowId: run.workflowId,
            name: run.name,
            jobNames: run.jobs?.map((job) => job.name) ?? [],
          })),
    [future, hydratedRuns, repositoryWorkflows],
  );
  const visibleRules = useMemo(() => {
    const currentIds = new Set(hydratedRuns.map((run) => run.id));
    return rules.filter((rule) => {
      if (rule.scope === "WORKFLOW_RUN") {
        return rule.targets.some(
          (target) =>
            target.workflowRunId && currentIds.has(target.workflowRunId),
        );
      }
      if (repositoryMode) return rule.scope === "REPOSITORY";
      if (pullRequestNumber) {
        return (
          rule.scope === "PULL_REQUEST" &&
          rule.pullRequestNumber === pullRequestNumber
        );
      }
      return rule.scope === "WORKTREE_BRANCH" && rule.worktreeId === worktreeId;
    });
  }, [hydratedRuns, pullRequestNumber, repositoryMode, rules, worktreeId]);

  const toggleWorkflow = (workflowId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const workflowKey = `workflow:${workflowId}`;
      if (checked) {
        next.add(workflowKey);
        for (const key of next) {
          if (key.startsWith(`job:${workflowId}:`)) next.delete(key);
        }
      } else {
        next.delete(workflowKey);
      }
      return next;
    });
  };

  const toggleJob = (workflowId: string, jobName: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(`workflow:${workflowId}`);
      const jobKey = `job:${workflowId}:${jobName}`;
      if (checked) next.add(jobKey);
      else next.delete(jobKey);
      return next;
    });
  };

  const save = async () => {
    const parsedLimit = unlimited && mode === "FAILURE" ? null : Number(limit);
    if (
      parsedLimit !== null &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
    ) {
      setError(t("limitError"));
      return;
    }
    const targets: Array<{
      workflowId: string;
      workflowRunId: string | null;
      jobName: string | null;
    }> = [];
    for (const workflow of workflows) {
      const workflowKey = `workflow:${workflow.id}`;
      if (selected.has(workflowKey)) {
        targets.push({
          workflowId: workflow.workflowId,
          workflowRunId: future ? null : workflow.id,
          jobName: null,
        });
        continue;
      }
      for (const jobName of workflow.jobNames) {
        if (selected.has(`job:${workflow.id}:${jobName}`)) {
          targets.push({
            workflowId: workflow.workflowId,
            workflowRunId: future ? null : workflow.id,
            jobName,
          });
        }
      }
    }
    if (!allWorkflows && targets.length === 0) {
      setError(t("targetRequired"));
      return;
    }
    const scope = repositoryMode
      ? "REPOSITORY"
      : future && pullRequestNumber
        ? "PULL_REQUEST"
        : future
          ? "WORKTREE_BRANCH"
          : "WORKFLOW_RUN";
    setSaving(true);
    try {
      await controlPlaneRequest(
        `mutation SaveGitHubAutoRetryRule($input: SaveGitHubAutoRetryRuleInput!) {
          saveGitHubAutoRetryRule(input: $input) { ${RULE_FIELDS} }
        }`,
        {
          input: {
            id: editingId,
            scope,
            codebaseRepositoryId,
            repositoryGithubId: repositoryGithubId ?? null,
            worktreeId: future ? (worktreeId ?? null) : null,
            branch: future ? (branch ?? null) : null,
            pullRequestNumber: future ? (pullRequestNumber ?? null) : null,
            allWorkflows: future && allWorkflows,
            mode,
            retryLimit: parsedLimit,
            failureStrategy,
            targets,
          },
        },
      );
      setError(null);
      setEditingId(null);
      await refreshRules();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (rule: GitHubAutoRetryRuleView) => {
    try {
      await controlPlaneRequest(
        `mutation SetGitHubAutoRetryRuleEnabled($id: ID!, $enabled: Boolean!) {
          setGitHubAutoRetryRuleEnabled(id: $id, enabled: $enabled) { id enabled status }
        }`,
        { id: rule.id, enabled: !rule.enabled },
      );
      await refreshRules();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const remove = async (id: string) => {
    try {
      await controlPlaneRequest(
        "mutation DeleteGitHubAutoRetryRule($id: ID!) { deleteGitHubAutoRetryRule(id: $id) }",
        { id },
      );
      await refreshRules();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const edit = async (rule: GitHubAutoRetryRuleView) => {
    const nextFuture = rule.scope !== "WORKFLOW_RUN";
    if (nextFuture && repositoryWorkflows.length === 0) {
      setLoading(true);
      setError(null);
      try {
        await refreshRepositoryWorkflows();
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
        return;
      } finally {
        setLoading(false);
      }
    }
    setEditingId(rule.id);
    setFuture(nextFuture);
    setAllWorkflows(rule.allWorkflows);
    setMode(rule.mode);
    setLimit(String(rule.retryLimit ?? 3));
    setUnlimited(rule.mode === "FAILURE" && rule.retryLimit === null);
    setFailureStrategy(rule.failureStrategy);
    setSelected(
      new Set(
        rule.targets.map((target) => {
          const workflowKey = nextFuture
            ? target.workflowId
            : target.workflowRunId;
          return target.jobName
            ? `job:${workflowKey}:${target.jobName}`
            : `workflow:${workflowKey}`;
        }),
      ),
    );
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <RotateCcw /> {t("autoRetry")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner /> {t("loading")}
          </div>
        ) : (
          <div className="space-y-5">
            {!credentialsReady ? (
              <Alert>
                <AlertDescription>{t("credentialsRequired")}</AlertDescription>
              </Alert>
            ) : null}
            {allowFuture && !repositoryMode ? (
              <div className="space-y-2">
                <Label>{t("scope")}</Label>
                <ToggleGroup
                  onValueChange={(value) => {
                    if (!value) return;
                    const nextFuture = value === "future";
                    setFuture(nextFuture);
                    setAllWorkflows(nextFuture);
                    if (nextFuture && repositoryWorkflows.length === 0) {
                      void refreshRepositoryWorkflows().catch((value) =>
                        setError(
                          value instanceof Error
                            ? value.message
                            : String(value),
                        ),
                      );
                    }
                    setSelected(
                      nextFuture
                        ? new Set()
                        : new Set(
                            hydratedRuns.map((run) => `workflow:${run.id}`),
                          ),
                    );
                  }}
                  type="single"
                  value={future ? "future" : "current"}
                  variant="outline"
                >
                  <ToggleGroupItem value="current">
                    {t("currentRuns")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="future">
                    {t("futureRuns")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label>{t("targets")}</Label>
              {future ? (
                <label className="flex items-center gap-2 rounded-md border p-3">
                  <Checkbox
                    checked={allWorkflows}
                    onCheckedChange={(checked) =>
                      setAllWorkflows(checked === true)
                    }
                  />
                  <span className="font-medium">{t("allWorkflows")}</span>
                </label>
              ) : null}
              {!allWorkflows ? (
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-2">
                  {workflows.map((workflow) => (
                    <div className="rounded-md border p-2" key={workflow.id}>
                      <label className="flex items-center gap-2 font-medium">
                        <Checkbox
                          checked={selected.has(`workflow:${workflow.id}`)}
                          onCheckedChange={(checked) =>
                            toggleWorkflow(workflow.id, checked === true)
                          }
                        />
                        {workflow.name}
                      </label>
                      {workflow.jobNames.length ? (
                        <div className="ml-6 mt-2 space-y-1">
                          {workflow.jobNames.map((jobName) => (
                            <label
                              className="flex items-center gap-2 text-sm"
                              key={jobName}
                            >
                              <Checkbox
                                checked={selected.has(
                                  `job:${workflow.id}:${jobName}`,
                                )}
                                onCheckedChange={(checked) =>
                                  toggleJob(
                                    workflow.id,
                                    jobName,
                                    checked === true,
                                  )
                                }
                              />
                              {jobName}
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {!workflows.length ? (
                    <p className="p-2 text-sm text-muted-foreground">
                      {t("noWorkflows")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("mode")}</Label>
                <Select
                  value={mode}
                  onValueChange={(value) =>
                    setMode(value as GitHubAutoRetryMode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FAILURE">{t("failureMode")}</SelectItem>
                    <SelectItem value="COUNT">{t("countMode")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="auto-retry-limit">{t("retryLimit")}</Label>
                <Input
                  disabled={mode === "FAILURE" && unlimited}
                  id="auto-retry-limit"
                  max={100}
                  min={1}
                  onChange={(event) => setLimit(event.target.value)}
                  type="number"
                  value={limit}
                />
                {mode === "FAILURE" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={unlimited}
                      onCheckedChange={(checked) =>
                        setUnlimited(checked === true)
                      }
                    />
                    {t("unlimited")}
                  </label>
                ) : null}
              </div>
            </div>
            {mode === "FAILURE" ? (
              <div className="space-y-2">
                <Label>{t("failureStrategy")}</Label>
                <Select
                  value={failureStrategy}
                  onValueChange={(value) =>
                    setFailureStrategy(value as GitHubAutoRetryFailureStrategy)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FAILED_JOBS">
                      {t("failedJobs")}
                    </SelectItem>
                    <SelectItem value="ALL_JOBS">{t("allJobs")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {visibleRules.length ? (
              <div className="space-y-2 border-t pt-4">
                <Label>{t("savedRules")}</Label>
                {visibleRules.map((rule) => (
                  <div
                    className="flex items-start justify-between gap-3 rounded-md border p-3"
                    key={rule.id}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={rule.enabled ? "default" : "secondary"}>
                          {t(`statuses.${rule.status}`)}
                        </Badge>
                        <span className="text-sm font-medium">
                          {t(`scopes.${rule.scope}`)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("ruleProgress", {
                          retries: rule.executions.reduce(
                            (sum, item) => sum + item.automaticRetries,
                            0,
                          ),
                          executions: rule.executions.length,
                        })}
                      </p>
                      {rule.lastError ? (
                        <p className="text-xs text-destructive">
                          {rule.lastError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        aria-label={t("edit")}
                        onClick={() => void edit(rule)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Pencil />
                      </Button>
                      <Button
                        aria-label={rule.enabled ? t("pause") : t("resume")}
                        onClick={() => void setEnabled(rule)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        {rule.enabled ? <Pause /> : <Play />}
                      </Button>
                      <Button
                        aria-label={t("delete")}
                        onClick={() => void remove(rule.id)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            {t("close")}
          </Button>
          <Button
            disabled={loading || saving || !credentialsReady}
            onClick={() => void save()}
          >
            {saving ? <Spinner /> : <Save />} {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
