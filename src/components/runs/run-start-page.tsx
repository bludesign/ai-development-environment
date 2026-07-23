"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronsUpDown,
  ClipboardList,
  Play,
  Save,
  Terminal,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

import { RUN_DRAFT_FIELDS } from "./graphql-fields";
import { AttachmentPicker } from "./attachment-picker";
import {
  ModelEffortPicker,
  type ProviderCatalogEntry,
} from "./model-effort-picker";
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
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [worktreeId, setWorktreeId] = useState("");
  const [jiraIssueKey, setJiraIssueKey] = useState("");
  const [jiraSummary, setJiraSummary] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("auto");
  const [webSearch, setWebSearch] = useState(true);
  const [attachments, setAttachments] = useState<RunAttachmentView[]>([]);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
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
        ${draftId ? `runDraft(id: $draftId) { ${RUN_DRAFT_FIELDS} }` : ""}
      }`,
        draftId ? { draftId } : undefined,
      );
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

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void controlPlaneRequest<{
        runProviderCatalog: ProviderCatalogEntry[];
      }>(
        `query RunProviderCatalog($worktreeId: ID) { runProviderCatalog(worktreeId: $worktreeId) { key label available supportsWebSearch models { id label efforts group } } }`,
        { worktreeId: worktreeId || null },
      )
        .then((data) => {
          if (!cancelled) setCatalog(data.runProviderCatalog);
        })
        .catch((value) => {
          if (!cancelled)
            setError(value instanceof Error ? value.message : String(value));
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [worktreeId]);

  const selectedWorktree = worktrees.find(({ id }) => id === worktreeId);
  const selectedProvider = catalog.find(({ key }) => key === provider);
  const providerUsable = Boolean(
    selectedProvider?.available &&
    selectedProvider.models.some(({ id }) => id === model) &&
    selectedWorktree?.agentOnline &&
    selectedWorktree.capabilities.includes(
      `runs.provider.${provider.toLowerCase()}`,
    ),
  );
  /**
   * The searchable corpus, not the label: a worktree is often found by its
   * folder or ticket rather than by the repository and branch the row shows.
   */
  const worktreeTerms = (worktree: WorktreeOption) =>
    [
      worktree.repository,
      worktree.branch,
      worktree.folder,
      worktree.ticketKey,
      worktree.ticketTitle,
      worktree.agentName,
    ]
      .filter(Boolean)
      .join(" ");
  const worktreeLabel = (worktree: WorktreeOption) =>
    `${worktree.repository} · ${worktree.branch ?? t("detached")} · ${worktree.agentName}`;

  const selectWorktree = (value: string | null) => {
    const id = value ?? "";
    setCatalog([]);
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

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy("upload");
    try {
      const next = [...attachments];
      for (const file of files) {
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
          <div className="space-y-2">
            <Label>{t("mode")}</Label>
            <Tabs
              onValueChange={(value) => setKind(value as "PLAN" | "SESSION")}
              value={kind}
            >
              <TabsList className="grid w-full grid-cols-2 sm:w-80">
                <TabsTrigger value="PLAN">
                  <ClipboardList /> {t("plan")}
                </TabsTrigger>
                <TabsTrigger value="SESSION">
                  <Terminal /> {t("session")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("worktree")}</Label>
              <Popover onOpenChange={setWorktreeOpen} open={worktreeOpen}>
                <PopoverTrigger asChild>
                  <Button
                    className="w-full justify-between font-normal"
                    type="button"
                    variant="outline"
                  >
                    <span
                      className={cn(
                        "truncate",
                        !selectedWorktree && "text-muted-foreground",
                      )}
                    >
                      {selectedWorktree
                        ? worktreeLabel(selectedWorktree)
                        : t("selectWorktree")}
                    </span>
                    <ChevronsUpDown className="text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-(--radix-popover-trigger-width) p-0"
                >
                  <Command>
                    <CommandInput placeholder={t("searchWorktrees")} />
                    <CommandList>
                      <CommandEmpty>
                        {t("empty", { kind: t("worktree") })}
                      </CommandEmpty>
                      {worktrees.map((worktree) => (
                        <CommandItem
                          data-checked={worktree.id === worktreeId}
                          disabled={
                            !worktree.agentOnline ||
                            worktree.availability !== "AVAILABLE"
                          }
                          key={worktree.id}
                          onSelect={() => {
                            selectWorktree(worktree.id);
                            setWorktreeOpen(false);
                          }}
                          value={worktreeTerms(worktree)}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {worktreeLabel(worktree)}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
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
            <AttachmentPicker
              attachments={attachments}
              onFiles={uploadFiles}
              onRemove={(id) =>
                setAttachments((current) =>
                  current.filter((attachment) => attachment.id !== id),
                )
              }
              uploading={busy === "upload"}
            />
          </div>
          <ModelEffortPicker
            catalog={catalog}
            effort={effort}
            isProviderDisabled={(entry) =>
              Boolean(
                selectedWorktree &&
                !selectedWorktree.capabilities.includes(
                  `runs.provider.${entry.key.toLowerCase()}`,
                ),
              )
            }
            model={model}
            onEffortChange={setEffort}
            onModelChange={setModel}
            onProviderChange={(next) => {
              const entry = catalog.find(({ key }) => key === next);
              setProvider(next);
              setModel("");
              setEffort("auto");
              setWebSearch(Boolean(entry?.supportsWebSearch));
            }}
            provider={provider}
          />
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
              disabled={
                Boolean(busy) ||
                !worktreeId ||
                !prompt.trim() ||
                !provider ||
                !model
              }
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
                !model ||
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
