"use client";

import { Check, Copy, Eye, FileCode } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  headerClassName,
}: {
  body: string;
  bodyHtml: string;
  emptyLabel: string;
  header?: ReactNode;
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

  const modes = [
    { value: "RENDERED", label: t("rendered"), icon: Eye },
    { value: "MARKDOWN", label: t("markdown"), icon: FileCode },
  ] as const;
  const active = modes.find((mode) => mode.value === viewMode)!;
  const ActiveIcon = active.icon;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          headerClassName,
        )}
      >
        <div>{header}</div>
        {body && (
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" type="button" variant="outline">
                  <ActiveIcon /> {active.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  onValueChange={(value) => setViewMode(value as ViewMode)}
                  value={viewMode}
                >
                  {modes.map(({ value, label, icon: Icon }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      <Icon /> {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
