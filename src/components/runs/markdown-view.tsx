"use client";

import { useState } from "react";
import { Check, Clipboard, Code2, Eye } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";

export function MarkdownView({
  value,
  copy = false,
  showActions = true,
  raw: controlledRaw,
  onRawChange,
}: {
  value: string;
  copy?: boolean;
  showActions?: boolean;
  raw?: boolean;
  onRawChange?: (value: boolean) => void;
}) {
  const [localRaw, setLocalRaw] = useState(false);
  const raw = controlledRaw ?? localRaw;
  const setRaw = onRawChange ?? setLocalRaw;
  return (
    <div className="space-y-3">
      {showActions && (
        <MarkdownActions
          copy={copy}
          onRawChange={setRaw}
          raw={raw}
          value={value}
        />
      )}
      {raw ? (
        <pre className="max-h-[36rem] overflow-auto rounded-lg border bg-muted/40 p-4 text-xs whitespace-pre-wrap">
          {value}
        </pre>
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function MarkdownActions({
  value,
  copy = false,
  raw,
  onRawChange,
}: {
  value: string;
  copy?: boolean;
  raw: boolean;
  onRawChange: (value: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex justify-end gap-2">
      <Button
        onClick={() => onRawChange(!raw)}
        size="sm"
        type="button"
        variant="outline"
      >
        {raw ? <Eye /> : <Code2 />} {raw ? "Rendered" : "Raw"}
      </Button>
      {copy && (
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? <Check /> : <Clipboard />} {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </div>
  );
}
