"use client";

import { waitForTicketBranchJob } from "./worktree-jobs";

import {
  FormEvent,
  ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/common/searchable-select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { parseJiraIssueKey } from "@/lib/jira-issue-key";

export type WorktreeBranchMode = "NEW" | "EXISTING" | "TICKET";

export type WorktreeBranchSelection = {
  mode: WorktreeBranchMode;
  branchName?: string | null;
  ticketKey?: string | null;
  baseBranch: string;
};

export type WorktreeBranchTarget = {
  codebaseId: string;
  worktreeId?: string;
  defaultBranch: string | null;
  currentBranch?: string | null;
  currentBaseBranch?: string | null;
  localBranches: string[];
  remoteBranches: string[];
  unavailableBranches: string[];
};

type TicketPreview = {
  ticketKey: string;
  ticketTitle: string;
  ticketType: string | null;
  projectKey: string;
  branchName: string | null;
  branchNamingMode: "JAVASCRIPT" | "AI";
  contextKey?: string;
};

const BRANCH_MODE_COOKIE = "worktree-branch-mode";
const BRANCH_MODE_EVENT = "worktree-branch-mode-changed";

function readBranchMode(): WorktreeBranchMode {
  if (typeof document === "undefined") return "NEW";
  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${BRANCH_MODE_COOKIE}=`))
    ?.split("=")[1];
  return value === "EXISTING" || value === "TICKET" ? value : "NEW";
}

function useRememberedBranchMode() {
  const [mode, setMode] = useState<WorktreeBranchMode>(readBranchMode);
  useEffect(() => {
    const sync = () => setMode(readBranchMode());
    window.addEventListener(BRANCH_MODE_EVENT, sync);
    return () => window.removeEventListener(BRANCH_MODE_EVENT, sync);
  }, []);
  const remember = (next: WorktreeBranchMode) => {
    document.cookie = `${BRANCH_MODE_COOKIE}=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    setMode(next);
    window.dispatchEvent(new Event(BRANCH_MODE_EVENT));
  };
  return [mode, remember] as const;
}

export function WorktreeBranchForm({
  target,
  busy,
  submitLabel,
  onSubmit,
  onSubmitError,
  recovery,
  fixedTicketKey,
}: {
  target: WorktreeBranchTarget;
  busy: boolean;
  submitLabel: string;
  onSubmit: (selection: WorktreeBranchSelection) => Promise<void>;
  onSubmitError?: (selection: WorktreeBranchSelection, error: Error) => void;
  recovery?: ReactNode;
  fixedTicketKey?: string;
}) {
  const t = useTranslations("worktrees");
  const id = useId();
  const [rememberedMode, setRememberedMode] = useRememberedBranchMode();
  const mode: WorktreeBranchMode = fixedTicketKey ? "TICKET" : rememberedMode;
  const [branchName, setBranchName] = useState("");
  const [existingBranch, setExistingBranch] = useState(
    target.currentBranch ?? "",
  );
  const [baseBranch, setBaseBranch] = useState(
    target.currentBaseBranch ?? target.defaultBranch ?? "",
  );
  const [ticketKey, setTicketKey] = useState(fixedTicketKey ?? "");
  const [preview, setPreview] = useState<TicketPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const [generatedName, setGeneratedName] = useState("");
  const [generating, setGenerating] = useState(false);
  const generationController = useRef<AbortController | null>(null);
  const contextKey = `${mode}:${target.codebaseId}:${target.worktreeId ?? ""}:${parseJiraIssueKey(ticketKey)}`;
  const currentPreview = preview?.contextKey === contextKey ? preview : null;
  useEffect(
    () => () => {
      generationController.current?.abort();
    },
    [contextKey],
  );

  useEffect(() => {
    const request = ++previewRequest.current;
    const normalized = parseJiraIssueKey(ticketKey);
    const timer = window.setTimeout(async () => {
      setGeneratedName("");
      setGenerating(false);
      if (mode !== "TICKET" || !normalized) {
        setPreviewLoading(false);
        return;
      }
      setPreviewLoading(true);
      try {
        const data = await controlPlaneRequest<{
          worktreeTicketBranchContext: TicketPreview;
        }>(
          `query WorktreeTicketBranchContext($input: PreviewWorktreeTicketBranchInput!) {
            worktreeTicketBranchContext(input: $input) { ticketKey ticketTitle ticketType projectKey branchName branchNamingMode }
          }`,
          {
            input: {
              codebaseId: target.codebaseId,
              worktreeId: target.worktreeId ?? null,
              ticketKey: normalized,
            },
          },
        );
        if (request !== previewRequest.current) return;
        setPreview({ ...data.worktreeTicketBranchContext, contextKey });
      } catch (value) {
        if (request !== previewRequest.current) return;
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (request === previewRequest.current) setPreviewLoading(false);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [contextKey, mode, target.codebaseId, target.worktreeId, ticketKey]);

  const baseOptions = useMemo<SearchableSelectOption[]>(
    () =>
      target.remoteBranches.map((branch) => ({
        value: branch,
        label: branch,
        description:
          branch === target.defaultBranch ? t("remoteDefault") : undefined,
      })),
    [t, target.defaultBranch, target.remoteBranches],
  );
  const existingOptions = useMemo<SearchableSelectOption[]>(() => {
    const local = new Set(target.localBranches);
    const remote = new Set(target.remoteBranches);
    const unavailable = new Set(target.unavailableBranches);
    return [...new Set([...local, ...remote])]
      .filter((branch) => !unavailable.has(branch))
      .sort((first, second) => first.localeCompare(second))
      .map((branch) => ({
        value: branch,
        label: branch,
        description:
          local.has(branch) && remote.has(branch)
            ? t("localAndOrigin")
            : local.has(branch)
              ? t("localBranch")
              : t("originBranch"),
      }));
  }, [
    t,
    target.localBranches,
    target.remoteBranches,
    target.unavailableBranches,
  ]);

  const generate = async () => {
    if (
      !currentPreview ||
      (generationController.current &&
        !generationController.current.signal.aborted)
    )
      return;
    const controller = new AbortController();
    generationController.current = controller;
    const request = previewRequest.current;
    let jobId: string | undefined;
    setGenerating(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        generateWorktreeTicketBranch: { id: string };
      }>(
        `mutation GenerateWorktreeTicketBranch($input: GenerateWorktreeTicketBranchInput!) { generateWorktreeTicketBranch(input: $input) { id } }`,
        {
          input: {
            codebaseId: target.codebaseId,
            worktreeId: target.worktreeId ?? null,
            ticketKey: currentPreview.ticketKey,
            requestId: crypto.randomUUID(),
          },
        },
      );
      jobId = data.generateWorktreeTicketBranch.id;
      const name = await waitForTicketBranchJob(jobId, controller.signal);
      if (request === previewRequest.current && !controller.signal.aborted)
        setGeneratedName(name);
    } catch (value) {
      if (jobId)
        void controlPlaneRequest(
          `mutation CancelBranchGeneration($id: ID!) { cancelAgentJob(jobId: $id) { id } }`,
          { id: jobId },
        ).catch(() => undefined);
      if (request === previewRequest.current && !controller.signal.aborted)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (generationController.current === controller)
        generationController.current = null;
      if (request === previewRequest.current) setGenerating(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const selection: WorktreeBranchSelection = {
      mode,
      baseBranch,
      ...(mode === "NEW"
        ? { branchName }
        : mode === "EXISTING"
          ? { branchName: existingBranch }
          : {
              ticketKey: parseJiraIssueKey(ticketKey),
              ...(currentPreview?.branchNamingMode === "AI" &&
              generatedName.trim()
                ? { branchName: generatedName }
                : {}),
            }),
    };
    try {
      setError(null);
      await onSubmit(selection);
    } catch (value) {
      const nextError =
        value instanceof Error ? value : new Error(String(value));
      setError(nextError.message);
      onSubmitError?.(selection, nextError);
    }
  };

  const submitDisabled =
    busy ||
    generating ||
    !baseBranch ||
    (mode === "NEW" && !branchName.trim()) ||
    (mode === "EXISTING" && !existingBranch) ||
    (mode === "TICKET" && (!currentPreview || previewLoading));

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      {!fixedTicketKey && (
        <Tabs
          onValueChange={(value) => {
            setPreview(null);
            setPreviewLoading(false);
            setError(null);
            setRememberedMode(value as WorktreeBranchMode);
          }}
          value={mode}
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger disabled={busy || generating} value="NEW">
              {t("newBranch")}
            </TabsTrigger>
            <TabsTrigger disabled={busy || generating} value="EXISTING">
              {t("existingBranch")}
            </TabsTrigger>
            <TabsTrigger disabled={busy || generating} value="TICKET">
              {t("fromTicket")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {mode === "NEW" && (
        <div>
          <Label className="mb-1.5 block" htmlFor={`${id}-branch`}>
            {t("branchName")}
          </Label>
          <Input
            autoComplete="off"
            id={`${id}-branch`}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder="feature/TICKET-123-ticket-title"
            value={branchName}
          />
        </div>
      )}

      {mode === "EXISTING" && (
        <div>
          <Label className="mb-1.5 block">{t("existingBranch")}</Label>
          <SearchableSelect
            ariaLabel={t("existingBranch")}
            emptyMessage={t("noMatchingBranches")}
            onValueChange={setExistingBranch}
            options={existingOptions}
            placeholder={t("selectExistingBranch")}
            searchPlaceholder={t("searchBranches")}
            value={existingBranch}
          />
        </div>
      )}

      {mode === "TICKET" && (
        <div className="space-y-2">
          <div>
            <Label className="mb-1.5 block" htmlFor={`${id}-ticket`}>
              {t("ticketKey")}
            </Label>
            <Input
              autoComplete="off"
              disabled={busy || generating}
              id={`${id}-ticket`}
              onChange={(event) => {
                setTicketKey(event.target.value);
                setPreview(null);
                setPreviewLoading(false);
                setError(null);
              }}
              placeholder="TICKET-123"
              readOnly={Boolean(fixedTicketKey)}
              value={ticketKey}
            />
          </div>
          {previewLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("loadingTicketBranch")}
            </p>
          )}
          {currentPreview && (
            <Item variant="muted">
              <ItemContent>
                <ItemTitle className="w-full flex-wrap">
                  <span>{currentPreview.ticketKey}</span>
                  {currentPreview.ticketType && (
                    <Badge variant="secondary">
                      {currentPreview.ticketType}
                    </Badge>
                  )}
                </ItemTitle>
                <ItemDescription>{currentPreview.ticketTitle}</ItemDescription>
                {currentPreview.branchNamingMode === "AI" ? (
                  <div className="space-y-2 pt-2">
                    <Label htmlFor={`${id}-generated-branch`}>
                      {t("branchName")}
                    </Label>
                    <Input
                      autoComplete="off"
                      disabled={busy || generating}
                      id={`${id}-generated-branch`}
                      onChange={(event) => setGeneratedName(event.target.value)}
                      value={generatedName}
                      placeholder={t("aiBranchPlaceholder")}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("aiBranchSubmitHelp")}
                    </p>
                    <Button
                      disabled={busy || generating}
                      onClick={() => void generate()}
                      type="button"
                      variant="outline"
                    >
                      {generating && <Spinner />}
                      {generating
                        ? t("generatingBranchName")
                        : generatedName
                          ? t("regenerateBranchName")
                          : t("generateBranchName")}
                    </Button>
                  </div>
                ) : (
                  <ItemDescription className="break-all font-mono text-xs text-foreground">
                    {currentPreview.branchName}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
          )}
        </div>
      )}

      <div>
        <Label className="mb-1.5 block">{t("baseBranch")}</Label>
        <SearchableSelect
          ariaLabel={t("baseBranch")}
          emptyMessage={t("noMatchingBranches")}
          onValueChange={setBaseBranch}
          options={baseOptions}
          placeholder={t("selectBaseBranch")}
          searchPlaceholder={t("searchBranches")}
          value={baseBranch}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {recovery}
      <div className="flex justify-end">
        <Button disabled={submitDisabled} type="submit">
          {busy && <Spinner />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
