"use client";

import { Check, Code2, Copy, Eye } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/browser-utils";

export function GitLabMarkdown({
  body,
  emptyLabel,
  actions = false,
}: {
  body: string;
  emptyLabel?: string;
  actions?: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!body)
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  return (
    <div className="min-w-0 space-y-3">
      {actions && (
        <div className="flex justify-end gap-2">
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() => setRaw(!raw)}
          >
            {raw ? <Eye /> : <Code2 />}
            {raw ? t("rendered") : t("raw")}
          </Button>
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await copyText(body);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      )}
      {copyError && (
        <p role="alert" className="text-xs text-destructive">
          {t("copyFailed")}
        </p>
      )}
      {raw ? (
        <pre className="overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap break-words">
          {body}
        </pre>
      ) : (
        <div className="prose prose-sm min-w-0 max-w-none overflow-hidden break-words dark:prose-invert prose-a:text-primary [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ children, href }) => (
                <a href={href} rel="noreferrer" target="_blank">
                  {children}
                </a>
              ),
            }}
          >
            {body}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
