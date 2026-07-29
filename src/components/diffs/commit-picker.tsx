"use client";

import { useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { cn } from "@/lib/utils";

import type { DiffCommit } from "./types";

/** The branch's commits, one of which scopes the COMMIT diff. */
export function CommitPicker({
  commits,
  onSelect,
  selectedSha,
  truncated,
}: {
  commits: DiffCommit[];
  onSelect: (sha: string) => void;
  selectedSha: string | null;
  truncated: boolean;
}) {
  const t = useTranslations("diffs");
  if (!commits.length) {
    return (
      <p className="px-2 py-4 text-sm text-muted-foreground">
        {t("noCommits")}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase">
        {t("commits")}
        {truncated ? ` · ${t("fileListTruncated")}` : ""}
      </p>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {commits.map((commit) => (
          <li key={commit.sha}>
            <button
              aria-current={commit.sha === selectedSha}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left hover:bg-accent",
                commit.sha === selectedSha && "bg-accent",
              )}
              onClick={() => onSelect(commit.sha)}
              type="button"
            >
              <span className="block truncate text-sm" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="flex items-center gap-2 text-[0.7rem] text-muted-foreground">
                <code>{commit.sha.slice(0, 7)}</code>
                <span className="truncate">{commit.authorName}</span>
                <DateTime value={commit.authoredAt} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
