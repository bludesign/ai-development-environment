"use client";

import { Braces, Check, Copy, Eye, FileCode2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AdfRenderer } from "@/components/jira/adf-renderer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  detectJiraTextFormat,
  isAdfDocument,
  jiraWikiToMarkdown,
  rawJiraText,
  stripAdfMarkdownMetadata,
} from "@/lib/jira-markup";
import { copyText } from "@/lib/browser-utils";
import type {
  JiraRichText,
  JiraTextFormat,
  JiraTextInput,
} from "@/services/jira/types";
import { cn } from "@/lib/utils";

type CopyState = "IDLE" | "COPIED" | "FAILED";
type ViewMode = "RENDERED" | "MARKDOWN" | "RAW";

function normalizedContent(
  content: JiraRichText | null | undefined,
  value: unknown,
): JiraRichText | null {
  if (content) return content;
  if (value === null || value === undefined) return null;
  const format = detectJiraTextFormat(value);
  const rawText = rawJiraText(value);
  return {
    format,
    raw: value,
    rawText,
    markdown: format === "JIRA_WIKI" ? jiraWikiToMarkdown(rawText) : rawText,
    wikiMarkup: rawText,
  };
}

function safeUrl(value: string): string {
  if (value === "jira-underline:") return value;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("/") || value.startsWith("#")) return value;
  return "";
}

function displayMarkdown(value: string): string {
  return value.replace(
    /<ins>([^<]*)<\/ins>/g,
    (_match, text: string) => `[${text}](jira-underline:)`,
  );
}

export function RichTextPreview({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-a:text-primary">
      <ReactMarkdown
        components={{
          a: ({ href, children }) =>
            href === "jira-underline:" ? (
              <u>{children}</u>
            ) : (
              <a href={href} rel="noreferrer" target="_blank">
                {children}
              </a>
            ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
      >
        {displayMarkdown(markdown)}
      </ReactMarkdown>
    </div>
  );
}

export function JiraRichTextBlock({
  bodyClassName,
  content,
  header,
  headerActions,
  headerClassName,
  value,
}: {
  bodyClassName?: string;
  content?: JiraRichText | null;
  header?: ReactNode;
  headerActions?: ReactNode;
  headerClassName?: string;
  value: unknown;
}) {
  const t = useTranslations("jiraTickets");
  const normalized = useMemo(
    () => normalizedContent(content, value),
    [content, value],
  );
  const [viewMode, setViewMode] = useState<ViewMode>("RENDERED");
  const [copyState, setCopyState] = useState<CopyState>("IDLE");
  const [formatOverride, setFormatOverride] = useState<Exclude<
    JiraTextFormat,
    "ADF"
  > | null>(null);

  useEffect(() => {
    if (copyState !== "COPIED") return;
    const timeout = window.setTimeout(() => setCopyState("IDLE"), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  if (!normalized)
    return (
      <div className="space-y-2">
        {(header || headerActions) && (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-2",
              headerClassName,
            )}
          >
            <div>{header}</div>
            <div>{headerActions}</div>
          </div>
        )}
        <p className={cn("text-muted-foreground", bodyClassName)}>—</p>
      </div>
    );
  const selectedFormat = formatOverride ?? normalized.format;
  const markdown =
    normalized.format === "ADF"
      ? normalized.markdown
      : selectedFormat === "JIRA_WIKI"
        ? jiraWikiToMarkdown(normalized.rawText)
        : normalized.rawText;
  const visibleMarkdown = stripAdfMarkdownMetadata(markdown);
  const viewModes = [
    { value: "RENDERED", label: t("rendered"), icon: Eye },
    { value: "MARKDOWN", label: t("markdown"), icon: FileCode2 },
    { value: "RAW", label: t("raw"), icon: Braces },
  ] as const;
  const activeViewMode = viewModes.find((mode) => mode.value === viewMode)!;
  const ActiveViewIcon = activeViewMode.icon;

  const copy = async () => {
    try {
      await copyText(
        viewMode === "MARKDOWN" ? visibleMarkdown : normalized.rawText,
      );
      setCopyState("COPIED");
    } catch {
      setCopyState("FAILED");
    }
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex flex-wrap items-center gap-2",
          header || headerActions ? "justify-between" : "justify-end",
          headerClassName,
        )}
      >
        {(header || headerActions) && <div>{header}</div>}
        <div className="flex flex-wrap items-center justify-end gap-1">
          {headerActions}
          {normalized.format !== "ADF" && (
            <Select
              onValueChange={(next) =>
                setFormatOverride(next as "MARKDOWN" | "JIRA_WIKI")
              }
              value={selectedFormat}
            >
              <SelectTrigger
                aria-label={t("renderFormat")}
                className="h-7 w-auto min-w-28 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MARKDOWN">{t("markdown")}</SelectItem>
                <SelectItem value="JIRA_WIKI">{t("jiraWiki")}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="xs"
                title={t("renderFormat")}
                type="button"
                variant="outline"
              >
                <ActiveViewIcon /> {activeViewMode.label}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                onValueChange={(mode) => setViewMode(mode as ViewMode)}
                value={viewMode}
              >
                {viewModes.map(({ icon: ViewIcon, label, value }) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    <ViewIcon /> {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            aria-label={t("copy")}
            onClick={() => void copy()}
            size="xs"
            title={copyState === "COPIED" ? t("copied") : t("copyRaw")}
            type="button"
            variant="outline"
          >
            {copyState === "COPIED" ? <Check /> : <Copy />}
            {t("copy")}
          </Button>
        </div>
      </div>
      {copyState === "FAILED" && (
        <p className="text-xs text-destructive">{t("copyFailed")}</p>
      )}
      <div className={bodyClassName}>
        {viewMode === "RAW" ? (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
            {normalized.rawText}
          </pre>
        ) : viewMode === "MARKDOWN" ? (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
            {visibleMarkdown}
          </pre>
        ) : normalized.format === "ADF" && isAdfDocument(normalized.raw) ? (
          <AdfRenderer value={normalized.raw} />
        ) : (
          <RichTextPreview markdown={visibleMarkdown} />
        )}
      </div>
    </div>
  );
}

export function JiraTextComposer({
  busy,
  error,
  initialFormat = "MARKDOWN",
  initialValue = "",
  onCancel,
  onSubmit,
  submitLabel,
}: {
  busy: boolean;
  error?: string | null;
  initialFormat?: JiraTextInput["format"];
  initialValue?: string;
  onCancel?: () => void;
  onSubmit: (input: JiraTextInput) => Promise<void>;
  submitLabel: string;
}) {
  const t = useTranslations("jiraTickets");
  const [format, setFormat] = useState<JiraTextInput["format"]>(initialFormat);
  const [value, setValue] = useState(initialValue);
  const [preview, setPreview] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    try {
      await onSubmit({ format, value });
      if (!initialValue) {
        setValue("");
        setPreview(false);
      }
    } catch {
      // The caller owns the visible error state and keeps the draft intact.
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          onValueChange={(next) => setFormat(next as JiraTextInput["format"])}
          value={format}
        >
          <SelectTrigger aria-label={t("authoringFormat")} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="MARKDOWN">{t("markdown")}</SelectItem>
            <SelectItem value="JIRA_WIKI">{t("jiraWiki")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={() => setPreview((current) => !current)}
          size="xs"
          type="button"
          variant="outline"
        >
          <Eye /> {preview ? t("hidePreview") : t("preview")}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-28 rounded-lg border p-3">
          <RichTextPreview
            markdown={
              format === "JIRA_WIKI" ? jiraWikiToMarkdown(value) : value
            }
          />
        </div>
      ) : (
        <Textarea
          aria-label={t("commentBody")}
          className="min-h-28"
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("commentPlaceholder")}
          value={value}
        />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            disabled={busy}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            {t("cancel")}
          </Button>
        )}
        <Button disabled={busy || !value.trim()} type="submit">
          {busy ? t("saving") : submitLabel}
        </Button>
      </div>
    </form>
  );
}
