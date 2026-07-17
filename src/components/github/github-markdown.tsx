"use client";

import { Braces, Check, Copy, Eye } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/browser-utils";
import { cn } from "@/lib/utils";

type ViewMode = "RENDERED" | "MARKDOWN";
type CopyState = "IDLE" | "COPIED" | "FAILED";

export function GitHubMarkdownContent({
  bodyHtml,
  className,
}: {
  bodyHtml: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words dark:prose-invert prose-a:text-primary prose-pre:overflow-x-auto [&_details>summary]:cursor-pointer",
        className,
      )}
      // GitHub's bodyHTML field is sanitized by GitHub before it is returned.
      dangerouslySetInnerHTML={{ __html: bodyHtml }}
    />
  );
}

export function GitHubMarkdownBlock({
  body,
  bodyHtml,
  emptyLabel,
  header,
  headerActions,
  headerClassName,
}: {
  body: string;
  bodyHtml: string;
  emptyLabel: string;
  header?: ReactNode;
  headerActions?: ReactNode;
  headerClassName?: string;
}) {
  const t = useTranslations("githubComments");
  const [viewMode, setViewMode] = useState<ViewMode>("RENDERED");
  const [copyState, setCopyState] = useState<CopyState>("IDLE");

  useEffect(() => {
    if (copyState !== "COPIED") return;
    const timeout = window.setTimeout(() => setCopyState("IDLE"), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copy = async () => {
    try {
      await copyText(body);
      setCopyState("COPIED");
    } catch {
      setCopyState("FAILED");
    }
  };

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          headerClassName,
        )}
      >
        <div className="min-w-0">{header}</div>
        {(body || headerActions) && (
          <div className="flex items-center gap-1">
            {headerActions}
            {body && (
              <>
                <Button
                  onClick={() =>
                    setViewMode((current) =>
                      current === "RENDERED" ? "MARKDOWN" : "RENDERED",
                    )
                  }
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {viewMode === "RENDERED" ? <Braces /> : <Eye />}
                  {viewMode === "RENDERED" ? t("viewRaw") : t("viewRendered")}
                </Button>
                <Button
                  aria-label={t("copy")}
                  onClick={() => void copy()}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {copyState === "COPIED" ? <Check /> : <Copy />}
                  {copyState === "COPIED" ? t("copied") : t("copy")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {copyState === "FAILED" && (
        <p className="text-xs text-destructive">{t("copyFailed")}</p>
      )}
      {!body ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : viewMode === "MARKDOWN" ? (
        <pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {body}
        </pre>
      ) : (
        <GitHubMarkdownContent bodyHtml={bodyHtml} />
      )}
    </div>
  );
}
