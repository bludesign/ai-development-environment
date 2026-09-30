"use client";

import { Check, Copy, Download, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { FileDropZone } from "@/components/common/file-drop-zone";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { copyText } from "@/lib/browser-utils";
import type { ToolCatalogSummaryGroup } from "@/services/tools/types";
import {
  MCP_PRESET_EXPORT_FORMAT,
  mcpPresetJsonSchema,
  type McpPresetDocument,
} from "@/services/tools/mcp-preset-format";

import type { McpToolPresetView } from "./mcp-preset-picker";

export type McpDocumentExport = {
  filename: string;
  contentType: string;
  content: string;
};
export function downloadMcpDocument(document: McpDocumentExport) {
  const url = URL.createObjectURL(
    new Blob([document.content], { type: document.contentType }),
  );
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = document.filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportPresetFiles(ids: string[]) {
  const result = await controlPlaneRequest<{
    exportMcpToolPresets: McpDocumentExport;
  }>(
    `query ExportMcpToolPresets($ids: [ID!]!) { exportMcpToolPresets(ids: $ids) { filename contentType content } }`,
    { ids },
  );
  downloadMcpDocument(result.exportMcpToolPresets);
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const UNSELECTED = "__unselected";

const AI_PRESET_EXAMPLE = {
  format: MCP_PRESET_EXPORT_FORMAT,
  schemaVersion: 1,
  externalServers: [],
  presets: [
    {
      name: "Investigation",
      description: "Inspect registered codebases.",
      iconKey: "wrench",
      enabledForPlans: true,
      enabledForSessions: true,
      tools: [{ source: "BUILTIN", name: "get_codebases" }],
    },
  ],
} satisfies McpPresetDocument;

function McpPresetAiPrompt() {
  const t = useTranslations("mcpPresets");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const prompt = useMemo(
    () =>
      [
        t("aiPromptInstructions"),
        t("aiPromptExample"),
        JSON.stringify(AI_PRESET_EXAMPLE, null, 2),
        t("aiPromptSchema"),
        JSON.stringify(mcpPresetJsonSchema(), null, 2),
      ].join("\n\n"),
    [t],
  );
  const copy = async () => {
    setError(false);
    setCopied(false);
    try {
      await copyText(prompt);
      setCopied(true);
    } catch {
      setError(true);
    }
  };
  return (
    <Accordion type="single" collapsible className="rounded-md border px-3">
      <AccordionItem value="ai-prompt">
        <AccordionTrigger className="hover:no-underline">
          {t("aiPromptTitle")}
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("aiPromptHelp")}</p>
          <Textarea
            aria-label={t("aiPromptText")}
            className="h-56 resize-none overflow-y-auto font-mono text-xs"
            readOnly
            value={prompt}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t("aiPromptCopied") : t("copyAiPrompt")}
          </Button>
          <span role="status" className="sr-only">
            {copied ? t("aiPromptCopied") : ""}
          </span>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t("aiPromptCopyFailed")}
            </p>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function McpCatalogExport({
  groups,
}: {
  groups: ToolCatalogSummaryGroup[];
}) {
  const t = useTranslations("mcpPresets");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState("MARKDOWN");
  const [source, setSource] = useState("ALL");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flatten = (
    items: ToolCatalogSummaryGroup[],
    depth = 0,
  ): Array<{ group: ToolCatalogSummaryGroup; depth: number }> =>
    items.flatMap((group) => [
      { group, depth },
      ...flatten(group.children, depth + 1),
    ]);
  const choices = flatten(
    groups.filter((group) => source === "ALL" || group.source === source),
  );
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await controlPlaneRequest<{
        exportMcpToolCatalog: McpDocumentExport;
      }>(
        `query ExportMcpToolCatalog($format: McpToolExportFormat!, $source: McpToolCatalogSource, $groupIds: [ID!]) {
          exportMcpToolCatalog(format: $format, source: $source, groupIds: $groupIds) { filename contentType content }
        }`,
        { format, source, groupIds: groupIds.length ? groupIds : null },
      );
      downloadMcpDocument(result.exportMcpToolCatalog);
      setOpen(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)} type="button" variant="outline">
        <Download />
        {t("exportCatalog")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("exportCatalog")}</DialogTitle>
            <DialogDescription>
              {t("exportCatalogDescription")}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <fieldset disabled={busy} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mcp-export-format">{t("format")}</Label>
                <Select
                  value={format}
                  onValueChange={setFormat}
                  disabled={busy}
                >
                  <SelectTrigger id="mcp-export-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MARKDOWN">Markdown</SelectItem>
                    <SelectItem value="JSON">JSON</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-export-source">{t("source")}</Label>
                <Select
                  value={source}
                  disabled={busy}
                  onValueChange={(value) => {
                    setSource(value);
                    setGroupIds([]);
                  }}
                >
                  <SelectTrigger id="mcp-export-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t("allTools")}</SelectItem>
                    <SelectItem value="BUILTIN">{t("builtInTools")}</SelectItem>
                    <SelectItem value="EXTERNAL">
                      {t("externalTools")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("catalogGroupsHelp")}
            </p>
            <ScrollArea className="h-56 rounded-md border">
              <div className="space-y-2 p-3">
                {choices.map(({ group, depth }) => (
                  <Label
                    className="flex items-start gap-2 text-sm"
                    style={{ marginLeft: depth * 16 }}
                    key={group.id}
                  >
                    <Checkbox
                      disabled={busy}
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(checked) =>
                        setGroupIds(
                          checked
                            ? [...groupIds, group.id]
                            : groupIds.filter((id) => id !== group.id),
                        )
                      }
                    />
                    <span>
                      {group.name}
                      {group.error && (
                        <span className="block text-destructive">
                          {t("unavailableSelection")}
                        </span>
                      )}
                    </span>
                  </Label>
                ))}
              </div>
            </ScrollArea>
          </fieldset>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setOpen(false)}
              variant="outline"
            >
              {tc("cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void download()}>
              {busy ? <Spinner /> : <Download />}
              {t("download")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ImportDecision = {
  index: number;
  action: "CREATE" | "REPLACE" | "SKIP";
  name?: string;
  targetId?: string;
};
type ImportMapping = { serverKey: string; serverId: string };
export type McpImportPreview = {
  token: string;
  canImport: boolean;
  errors: string[];
  entries: Array<{
    index: number;
    name: string;
    action: ImportDecision["action"];
    targetId: string | null;
    toolCount: number;
    errors: string[];
    warnings: string[];
  }>;
  externalServers: Array<{
    key: string;
    name: string;
    transport: string | null;
    selectedServerId: string | null;
    suggestedServerId: string | null;
    candidates: Array<{ id: string; name: string }>;
  }>;
};

const PREVIEW_FIELDS = `token canImport errors entries { index name action targetId toolCount errors warnings } externalServers { key name transport selectedServerId suggestedServerId candidates { id name } }`;

function presetDetails(document: string, index: number): string {
  try {
    const parsed = JSON.parse(document);
    return JSON.stringify(parsed.presets?.[index], null, 2) ?? "";
  } catch {
    return "";
  }
}

export function McpPresetImportDialog({
  open,
  onOpenChange,
  presets,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: McpToolPresetView[];
  onImported: () => Promise<void>;
}) {
  const t = useTranslations("mcpPresets");
  const tc = useTranslations("common");
  const [document, setDocument] = useState("");
  const [decisions, setDecisions] = useState<ImportDecision[]>([]);
  const [serverMappings, setServerMappings] = useState<ImportMapping[]>([]);
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const [current, setCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const input = { document, decisions, serverMappings };
  const replaceDocument = (value: string) => {
    requestVersion.current++;
    setDocument(value);
    setDecisions([]);
    setServerMappings([]);
    setPreview(null);
    setCurrent(false);
    setError(null);
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    setCurrent(false);
    const version = ++requestVersion.current;
    if (file.size > MAX_IMPORT_BYTES) {
      setError(t("fileTooLarge"));
      return;
    }
    try {
      const text = await file.text();
      if (version === requestVersion.current) replaceDocument(text);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const review = async () => {
    if (new Blob([document]).size > MAX_IMPORT_BYTES) {
      setError(t("fileTooLarge"));
      return;
    }
    const version = ++requestVersion.current;
    setBusy(true);
    setError(null);
    setCurrent(false);
    try {
      const result = await controlPlaneRequest<{
        previewMcpToolPresetImport: McpImportPreview;
      }>(
        `query PreviewMcpToolPresetImport($input: McpToolPresetImportInput!) { previewMcpToolPresetImport(input: $input) { ${PREVIEW_FIELDS} } }`,
        { input },
      );
      if (requestVersion.current === version) {
        setPreview(result.previewMcpToolPresetImport);
        setCurrent(true);
      }
    } catch (value) {
      if (requestVersion.current === version)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!current || !preview?.canImport) return;
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation ImportMcpToolPresets($input: McpToolPresetImportInput!, $previewToken: String!) { importMcpToolPresets(input: $input, previewToken: $previewToken) { id } }`,
        { input, previewToken: preview.token },
      );
      replaceDocument("");
      await onImported();
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setCurrent(false);
    } finally {
      setBusy(false);
    }
  };
  const decide = (index: number, patch: Partial<ImportDecision>) => {
    const old = decisions.find((decision) => decision.index === index) ?? {
      index,
      action: "CREATE" as const,
    };
    setDecisions([
      ...decisions.filter((decision) => decision.index !== index),
      { ...old, ...patch },
    ]);
    setCurrent(false);
    requestVersion.current++;
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
          <DialogDescription>{t("importDescription")}</DialogDescription>
        </DialogHeader>
        <McpPresetAiPrompt />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-import-file">{t("chooseFile")}</Label>
            <FileDropZone
              id="mcp-import-file"
              aria-label={t("chooseFile")}
              accept=".json,application/json,text/plain"
              className="rounded-md border-input"
              disabled={busy}
              multiple={false}
              onFiles={(files) => readFile(files[0])}
            >
              <Upload className="size-4 shrink-0" aria-hidden="true" />
              <span>{t("dropJsonFile")}</span>
            </FileDropZone>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-import-json">{t("pasteJson")}</Label>
            <Textarea
              className="max-h-48 min-h-40 overflow-y-auto font-mono text-xs"
              id="mcp-import-json"
              value={document}
              onChange={(event) => replaceDocument(event.target.value)}
              spellCheck={false}
            />
          </div>
          {preview && (
            <div className="space-y-4" aria-live="polite">
              {!current && (
                <p className="text-sm text-muted-foreground">
                  {t("reviewAgain")}
                </p>
              )}
              {preview.errors.map((message, index) => (
                <p className="text-sm text-destructive" key={index}>
                  {message}
                </p>
              ))}
              {preview.externalServers.map((server) => (
                <Card className="gap-2 p-3" key={server.key}>
                  <Label htmlFor={`mcp-map-${server.key}`}>
                    {t("mapServer", { name: server.name })}
                  </Label>
                  <Select
                    disabled={busy}
                    value={
                      serverMappings.find(
                        (mapping) => mapping.serverKey === server.key,
                      )?.serverId ?? UNSELECTED
                    }
                    onValueChange={(value) => {
                      setServerMappings([
                        ...serverMappings.filter(
                          (mapping) => mapping.serverKey !== server.key,
                        ),
                        ...(value !== UNSELECTED
                          ? [
                              {
                                serverKey: server.key,
                                serverId: value,
                              },
                            ]
                          : []),
                      ]);
                      setCurrent(false);
                      requestVersion.current++;
                    }}
                  >
                    <SelectTrigger
                      id={`mcp-map-${server.key}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSELECTED}>
                        {t("chooseServer")}
                      </SelectItem>
                      {server.candidates.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name}
                          {candidate.id === server.suggestedServerId
                            ? ` (${t("suggested")})`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!server.candidates.length && (
                    <p className="text-sm text-muted-foreground">
                      {t("noConfiguredServers")}
                    </p>
                  )}
                </Card>
              ))}
              {preview.entries.map((entry) => {
                const decision = decisions.find(
                  (value) => value.index === entry.index,
                );
                const action = decision?.action ?? entry.action;
                return (
                  <Card className="gap-3 p-3" key={entry.index}>
                    <p className="font-medium">
                      {entry.name}{" "}
                      <span className="text-sm font-normal text-muted-foreground">
                        ({t("reviewToolCount", { count: entry.toolCount })})
                      </span>
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`mcp-action-${entry.index}`}>
                          {t("importAction")}
                        </Label>
                        <Select
                          disabled={busy}
                          value={action}
                          onValueChange={(value) =>
                            decide(entry.index, {
                              action: value as ImportDecision["action"],
                              targetId: undefined,
                            })
                          }
                        >
                          <SelectTrigger
                            id={`mcp-action-${entry.index}`}
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="CREATE">
                              {t("createNew")}
                            </SelectItem>
                            <SelectItem value="REPLACE">
                              {t("replaceExisting")}
                            </SelectItem>
                            <SelectItem value="SKIP">{t("skip")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {action === "REPLACE" ? (
                        <div className="space-y-2">
                          <Label htmlFor={`mcp-target-${entry.index}`}>
                            {t("replaceTarget")}
                          </Label>
                          <Select
                            disabled={busy}
                            value={decision?.targetId ?? UNSELECTED}
                            onValueChange={(value) =>
                              decide(entry.index, {
                                targetId:
                                  value === UNSELECTED ? undefined : value,
                              })
                            }
                          >
                            <SelectTrigger
                              id={`mcp-target-${entry.index}`}
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSELECTED}>
                                {t("choosePreset")}
                              </SelectItem>
                              {presets.map((preset) => (
                                <SelectItem key={preset.id} value={preset.id}>
                                  {preset.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        action === "CREATE" && (
                          <div className="space-y-2">
                            <Label htmlFor={`mcp-name-${entry.index}`}>
                              {t("name")}
                            </Label>
                            <Input
                              id={`mcp-name-${entry.index}`}
                              maxLength={80}
                              value={decision?.name ?? entry.name}
                              onChange={(event) =>
                                decide(entry.index, {
                                  name: event.target.value,
                                })
                              }
                            />
                          </div>
                        )
                      )}
                    </div>
                    {entry.errors.map((message, index) => (
                      <p key={index} className="text-sm text-destructive">
                        {message}
                      </p>
                    ))}
                    {entry.warnings.map((message, index) => (
                      <p key={index} className="text-sm text-muted-foreground">
                        {message}
                      </p>
                    ))}
                    <Accordion type="single" collapsible>
                      <AccordionItem value="details">
                        <AccordionTrigger>
                          {t("reviewDetails")}
                        </AccordionTrigger>
                        <AccordionContent>
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                            {presetDetails(document, entry.index)}
                          </pre>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </Card>
                );
              })}
            </div>
          )}
        </fieldset>
        <DialogFooter className="flex-wrap">
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {tc("cancel")}
          </Button>
          <Button
            disabled={busy || !document.trim()}
            onClick={() => void review()}
            variant="outline"
          >
            {busy && <Spinner />}
            {t("reviewImport")}
          </Button>
          <Button
            disabled={busy || !current || !preview?.canImport}
            onClick={() => void apply()}
          >
            <Upload />
            {t("importReviewed")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
