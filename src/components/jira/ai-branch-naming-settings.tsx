"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  DEFAULT_JIRA_BRANCH_NAMING_PROMPT,
  JIRA_BRANCH_PROMPT_TOKENS,
} from "@ai-development-environment/agent-contract/worktrees";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ModelEffortPicker } from "@/components/runs/model-effort-picker";
import { useProviderCatalog } from "@/components/runs/use-provider-catalog";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraProjectView } from "@/services/jira/types";

export function JiraAiBranchNamingSettings({
  project,
  fields,
  onSaved,
  onError,
}: {
  project: JiraProjectView;
  fields: string;
  onSaved: (projects: JiraProjectView[]) => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("jiraTickets");
  const catalog = useProviderCatalog(null);
  const [enabled, setEnabled] = useState(project.branchNamingMode === "AI");
  const [provider, setProvider] = useState(project.branchNamingProvider ?? "");
  const [model, setModel] = useState(project.branchNamingModel ?? "");
  const [effort, setEffort] = useState(project.branchNamingEffort ?? "auto");
  const [prompt, setPrompt] = useState(
    project.branchNamingPrompt ?? DEFAULT_JIRA_BRANCH_NAMING_PROMPT,
  );
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    onError(null);
    try {
      const result = await controlPlaneRequest<{
        updateJiraProjectAiBranchNaming: JiraProjectView[];
      }>(
        `mutation UpdateJiraProjectAiBranchNaming($input: UpdateJiraProjectAiBranchNamingInput!) { updateJiraProjectAiBranchNaming(input: $input) { ${fields} } }`,
        {
          input: {
            projectId: project.id,
            mode: enabled ? "AI" : "JAVASCRIPT",
            provider: provider || null,
            model: model || null,
            effort,
            prompt,
          },
        },
      );
      onSaved(result.updateJiraProjectAiBranchNaming);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border-b pb-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="jira-ai-naming">{t("aiBranchNaming")}</Label>
        <Switch
          checked={enabled}
          disabled={busy}
          id="jira-ai-naming"
          onCheckedChange={setEnabled}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("aiBranchNamingHelp")}</p>
      {enabled && (
        <>
          <ModelEffortPicker
            catalog={catalog}
            effort={effort}
            fullWidth
            model={model}
            onEffortChange={setEffort}
            onModelChange={setModel}
            onProviderChange={setProvider}
            provider={provider}
          />
          {provider && (
            <p className="text-xs text-muted-foreground">
              {provider} · {model} · {effort}
            </p>
          )}
          <Label htmlFor="jira-ai-prompt">{t("aiBranchPrompt")}</Label>
          <Textarea
            disabled={busy}
            id="jira-ai-prompt"
            className="min-h-36 font-mono text-xs"
            onChange={(event) => setPrompt(event.target.value)}
            value={prompt}
          />
          <div className="flex flex-wrap gap-1">
            {JIRA_BRANCH_PROMPT_TOKENS.map((token) => (
              <Button
                disabled={busy}
                key={token}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setPrompt((value) => `${value} {{${token}}}`)}
              >{`{{${token}}}`}</Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("aiBranchTokensHelp")}
          </p>
        </>
      )}
      <div className="flex justify-end">
        <Button
          disabled={
            busy || (enabled && (!provider || !model || !prompt.trim()))
          }
          onClick={() => void save()}
          type="button"
        >
          {t("saveAiBranchNaming")}
        </Button>
      </div>
    </div>
  );
}
