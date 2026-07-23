"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { File, Play, Save, Search, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";

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
import { Checkbox } from "@/components/ui/checkbox";
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
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RUN_DRAFT_FIELDS } from "./graphql-fields";
import type { RunAttachmentView, RunDraftView } from "./types";

type WorktreeOption = {
  id: string;
  folder: string;
  branch: string | null;
  availability: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  repository: string;
  agentName: string;
  agentOnline: boolean;
  capabilities: string[];
};

type ProviderCatalog = {
  key: string;
  label: string;
  available: boolean;
  supportsWebSearch: boolean;
  models: Array<{ id: string; label: string; efforts: string[] }>;
};

export function RunStartPage({
  initialKind,
  draftId,
}: {
  initialKind: "PLAN" | "SESSION";
  draftId?: string | null;
}) {
  const t = useTranslations("runs");
  const router = useRouter();
  const [kind, setKind] = useState(initialKind);
  const [worktrees, setWorktrees] = useState<WorktreeOption[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalog[]>([]);
  const [worktreeId, setWorktreeId] = useState("");
  const [jiraIssueKey, setJiraIssueKey] = useState("");
  const [jiraSummary, setJiraSummary] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("CODEX");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("auto");
  const [webSearch, setWebSearch] = useState(false);
  const [attachments, setAttachments] = useState<RunAttachmentView[]>([]);
  const [worktreeSearch, setWorktreeSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "start" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        worktreeOverview: {
          agents: Array<{
            agent: {
              name: string;
              connectionStatus: string;
              capabilities: string[];
            };
            codebases: Array<{
              repository: { name: string };
              worktrees: Array<{
                id: string;
                folder: string;
                branch: string | null;
                availability: string;
                ticketKey: string | null;
                ticketTitle: string | null;
              }>;
            }>;
          }>;
        };
        runProviderCatalog: ProviderCatalog[];
        runDraft?: RunDraftView | null;
      }>(
        `query RunStartPage${draftId ? "($draftId: ID!)" : ""} {
        worktreeOverview {
          agents {
            agent { name connectionStatus capabilities }
            codebases {
              repository { name }
              worktrees { id folder branch availability ticketKey ticketTitle }
            }
          }
        }
        runProviderCatalog { key label available supportsWebSearch models { id label efforts } }
        ${draftId ? `runDraft(id: $draftId) { ${RUN_DRAFT_FIELDS} }` : ""}
      }`,
        draftId ? { draftId } : undefined,
      );
      setCatalog(data.runProviderCatalog);
      if (!data.runDraft) {
        const initialProvider =
          data.runProviderCatalog.find(
            ({ key, available }) => key === "CODEX" && available,
          ) ??
          data.runProviderCatalog.find(({ available }) => available) ??
          data.runProviderCatalog[0];
        if (initialProvider) {
          setProvider(initialProvider.key);
          setModel(initialProvider.models[0]?.id ?? "default");
          setEffort(initialProvider.models[0]?.efforts[0] ?? "auto");
        }
      }
      setWorktrees(
        data.worktreeOverview.agents.flatMap(({ agent, codebases }) =>
          codebases.flatMap(({ repository, worktrees }) =>
            worktrees.map((worktree) => ({
              ...worktree,
              repository: repository.name,
              agentName: agent.name,
              agentOnline: agent.connectionStatus === "ONLINE",
              capabilities: agent.capabilities,
            })),
          ),
        ),
      );
      if (data.runDraft) {
        const draft = data.runDraft;
        setKind(draft.kind);
        setWorktreeId(draft.worktreeId ?? "");
        setJiraIssueKey(draft.jiraIssueKey ?? "");
        setJiraSummary(draft.jiraSummary ?? "");
        setPrompt(draft.prompt);
        setProvider(draft.provider);
        setModel(draft.model);
        setEffort(draft.effort ?? "auto");
        setWebSearch(draft.webSearchEnabled);
        setAttachments(draft.attachments);
      }
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedWorktree = worktrees.find(({ id }) => id === worktreeId);
  const selectedProvider = catalog.find(({ key }) => key === provider);
  const providerUsable = Boolean(
    selectedProvider?.available &&
    selectedWorktree?.agentOnline &&
    selectedWorktree.capabilities.includes(
      `runs.provider.${provider.toLowerCase()}`,
    ),
  );
  const selectedModel =
    selectedProvider?.models.find(({ id }) => id === model) ??
    selectedProvider?.models[0];
  const visibleWorktrees = useMemo(() => {
    const term = worktreeSearch.trim().toLowerCase();
    return worktrees.filter(
      (worktree) =>
        !term ||
        `${worktree.repository} ${worktree.branch} ${worktree.folder} ${worktree.ticketKey}`
          .toLowerCase()
          .includes(term),
    );
  }, [worktreeSearch, worktrees]);

  const selectWorktree = (value: string | null) => {
    const id = value ?? "";
    setWorktreeId(id);
    const worktree = worktrees.find((entry) => entry.id === id);
    if (worktree?.ticketKey) {
      setJiraIssueKey(worktree.ticketKey);
      setJiraSummary(worktree.ticketTitle ?? "");
    } else {
      setJiraIssueKey("");
      setJiraSummary("");
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("upload");
    try {
      const next = [...attachments];
      for (const file of Array.from(files)) {
        if (file.size > 25 * 1024 * 1024)
          throw new Error(t("fileTooLarge", { name: file.name }));
        if (
          next.reduce((total, item) => total + item.size, 0) + file.size >
          100 * 1024 * 1024
        )
          throw new Error(t("attachmentsTooLarge"));
        const response = await fetch("/api/run-attachments", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-attachment-filename": encodeURIComponent(file.name),
          },
          body: file,
        });
        const value = (await response.json()) as RunAttachmentView & {
          error?: string;
        };
        if (!response.ok) throw new Error(value.error || t("uploadFailed"));
        next.push({
          ...value,
          downloadPath: `/api/run-attachments/${value.id}`,
          createdAt: new Date().toISOString(),
        });
      }
      setAttachments(next);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const configuration = () => ({
    kind,
    worktreeId,
    jiraIssueKey: jiraIssueKey.trim() || null,
    jiraSummary: jiraSummary.trim() || null,
    provider,
    model,
    effort: effort === "auto" ? null : effort,
    webSearchEnabled: webSearch,
    prompt,
    attachmentIds: attachments.map(({ id }) => id),
  });

  const save = async () => {
    setBusy("save");
    try {
      await controlPlaneRequest(
        `mutation SaveRunDraft($input: SaveRunDraftInput!) { saveRunDraft(input: $input) { id } }`,
        { input: { ...configuration(), id: draftId ?? null } },
      );
      router.push("/drafts");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy("start");
    try {
      const data = await controlPlaneRequest<{
        createAgentRun: { id: string; kind: string };
      }>(
        `mutation CreateRun($input: RunConfigurationInput!) { createAgentRun(input: $input) { id kind } }`,
        { input: { ...configuration(), draftId: draftId ?? null } },
      );
      router.push(
        `/${data.createAgentRun.kind === "PLAN" ? "plans" : "sessions"}/${data.createAgentRun.id}`,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  if (loading)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{draftId ? t("editDraft") : t("startTitle")}</CardTitle>
          <CardDescription>{t("startDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("mode")}</Label>
              <Select
                onValueChange={(value) =>
                  setKind((value ?? "PLAN") as "PLAN" | "SESSION")
                }
                value={kind}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PLAN">{t("plan")}</SelectItem>
                  <SelectItem value="SESSION">{t("session")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("worktree")}</Label>
              <div className="relative mb-2">
                <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
                <Input
                  aria-label={t("searchWorktrees")}
                  className="pl-9"
                  onChange={(event) => setWorktreeSearch(event.target.value)}
                  placeholder={t("searchWorktrees")}
                  value={worktreeSearch}
                />
              </div>
              <Select onValueChange={selectWorktree} value={worktreeId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("selectWorktree")} />
                </SelectTrigger>
                <SelectContent>
                  {visibleWorktrees.map((worktree) => (
                    <SelectItem
                      disabled={
                        !worktree.agentOnline ||
                        worktree.availability !== "AVAILABLE"
                      }
                      key={worktree.id}
                      value={worktree.id}
                    >
                      {worktree.repository} · {worktree.branch ?? t("detached")}{" "}
                      · {worktree.agentName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedWorktree && (
                <p
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={selectedWorktree.folder}
                >
                  {selectedWorktree.folder}
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="jira-key">{t("jiraTicket")}</Label>
              <Input
                id="jira-key"
                onChange={(event) => setJiraIssueKey(event.target.value)}
                placeholder="AIDE-123"
                value={jiraIssueKey}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="jira-summary">{t("jiraSummary")}</Label>
              <Input
                id="jira-summary"
                onChange={(event) => setJiraSummary(event.target.value)}
                value={jiraSummary}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="run-prompt">{t("prompt")}</Label>
            <Textarea
              className="min-h-48 resize-y"
              id="run-prompt"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t("promptPlaceholder")}
              required
              value={prompt}
            />
          </div>
          <div className="space-y-3">
            <Label>{t("attachments")}</Label>
            <div className="flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <Badge
                  className="gap-1 py-1"
                  key={attachment.id}
                  variant="secondary"
                >
                  <File className="size-3" />
                  <span className="max-w-56 truncate">
                    {attachment.filename}
                  </span>
                  <button
                    aria-label={t("removeAttachment", {
                      name: attachment.filename,
                    })}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter(({ id }) => id !== attachment.id),
                      )
                    }
                    type="button"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <Button asChild disabled={busy === "upload"} variant="outline">
              <label>
                {busy === "upload" ? <Spinner /> : <Upload />}{" "}
                {t("attachFiles")}
                <input
                  className="sr-only"
                  multiple
                  onChange={(event) => void uploadFiles(event.target.files)}
                  type="file"
                />
              </label>
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("attachmentLimits")}
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>{t("tool")}</Label>
              <Select
                onValueChange={(value) => {
                  const next = value ?? "CODEX";
                  setProvider(next);
                  const entry = catalog.find(({ key }) => key === next);
                  setModel(entry?.models[0]?.id ?? "default");
                  setEffort("auto");
                }}
                value={provider}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((entry) => (
                    <SelectItem
                      disabled={
                        !entry.available ||
                        Boolean(
                          selectedWorktree &&
                          !selectedWorktree.capabilities.includes(
                            `runs.provider.${entry.key.toLowerCase()}`,
                          ),
                        )
                      }
                      key={entry.key}
                      value={entry.key}
                    >
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("model")}</Label>
              <Select
                onValueChange={(value) => setModel(value ?? "default")}
                value={model}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedProvider?.models.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("effort")}</Label>
              <Select
                onValueChange={(value) => setEffort(value ?? "auto")}
                value={effort}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(selectedModel?.efforts ?? ["auto"]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-3 rounded-lg border p-3">
            <Checkbox
              checked={webSearch}
              disabled={!selectedProvider?.supportsWebSearch}
              onCheckedChange={(checked) => setWebSearch(Boolean(checked))}
            />
            <div>
              <p className="font-medium">{t("webSearch")}</p>
              <p className="text-xs text-muted-foreground">
                {t("webSearchDescription")}
              </p>
            </div>
          </label>
          {kind === "SESSION" && (
            <Alert>
              <AlertDescription>{t("unrestrictedWarning")}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={Boolean(busy) || !worktreeId || !prompt.trim()}
              onClick={() => void save()}
              variant="outline"
            >
              {busy === "save" ? <Spinner /> : <Save />} {t("saveDraft")}
            </Button>
            <Button
              disabled={
                Boolean(busy) ||
                !worktreeId ||
                !prompt.trim() ||
                !providerUsable
              }
              onClick={() => void start()}
            >
              {busy === "start" ? <Spinner /> : <Play />} {t("start")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
