"use client";

import { diffLines, type Change } from "diff";
import { ChevronDown, GitCompareArrows, History } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { JiraUser } from "@/components/jira/jira-user";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { rawJiraText, stripAdfMarkdownMetadata } from "@/lib/jira-markup";
import type {
  JiraChange,
  JiraPerson,
  JiraTicketDetail,
} from "@/services/jira/types";

import type { JiraTicketHistoryState } from "./ticket-history";

export type JiraDescriptionVersion = {
  author: JiraPerson | null;
  createdAt: string | null;
  id: string;
  kind: "CURRENT" | "AFTER" | "BEFORE";
  value: string;
};

function currentDescription(ticket: JiraTicketDetail): string {
  const markdown =
    ticket.descriptionContent?.markdown ?? rawJiraText(ticket.description);
  return stripAdfMarkdownMetadata(markdown);
}

export function buildDescriptionVersions(
  ticket: JiraTicketDetail,
  changes: JiraChange[],
): JiraDescriptionVersion[] {
  const versions: JiraDescriptionVersion[] = [
    {
      author: null,
      createdAt: ticket.updatedAt,
      id: "current",
      kind: "CURRENT",
      value: currentDescription(ticket),
    },
  ];
  const seen = new Set([versions[0].value]);

  for (const change of changes) {
    const descriptionItems = change.items.filter(
      (item) =>
        item.fieldId?.toLowerCase() === "description" ||
        item.field.toLowerCase() === "description",
    );
    descriptionItems.forEach((item, index) => {
      const snapshots: Array<{
        kind: "AFTER" | "BEFORE";
        value: string;
      }> = [
        { kind: "AFTER", value: item.to ?? "" },
        { kind: "BEFORE", value: item.from ?? "" },
      ];
      snapshots.forEach(({ kind, value }) => {
        const visibleValue = stripAdfMarkdownMetadata(value);
        if (seen.has(visibleValue)) return;
        seen.add(visibleValue);
        versions.push({
          author: change.author,
          createdAt: change.createdAt,
          id: `${change.id}:${index}:${kind.toLowerCase()}`,
          kind,
          value: visibleValue,
        });
      });
    });
  }

  return versions;
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function JiraDescriptionHistory({
  history,
  ticket,
}: {
  history: JiraTicketHistoryState;
  ticket: JiraTicketDetail;
}) {
  const t = useTranslations("jiraTicketDetail");
  const [open, setOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const versions = useMemo(
    () => buildDescriptionVersions(ticket, history.changes),
    [history.changes, ticket],
  );
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("current");
  const hasMore =
    history.total !== null && history.changes.length < history.total;
  const effectiveFromId = versions.some((version) => version.id === fromId)
    ? fromId
    : (versions[1]?.id ?? "");
  const effectiveToId = versions.some((version) => version.id === toId)
    ? toId
    : (versions[0]?.id ?? "");
  const fromVersion = versions.find(
    (version) => version.id === effectiveFromId,
  );
  const toVersion = versions.find((version) => version.id === effectiveToId);
  const differences = useMemo(
    () =>
      fromVersion && toVersion
        ? diffLines(fromVersion.value, toVersion.value)
        : [],
    [fromVersion, toVersion],
  );

  const versionLabel = (version: JiraDescriptionVersion) => {
    if (version.kind === "CURRENT") return t("currentVersion");
    return date(version.createdAt);
  };

  return (
    <>
      <Popover
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen && history.total === null) void history.load();
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          <Button
            aria-label={t("descriptionHistory")}
            size="xs"
            type="button"
            variant="outline"
          >
            <History /> {t("history")} <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(32rem,calc(100vw-2rem))] space-y-4"
        >
          <div>
            <h4 className="font-medium">{t("descriptionHistory")}</h4>
            <p className="text-xs text-muted-foreground">
              {t("descriptionHistoryDescription")}
            </p>
          </div>
          {history.error && (
            <Alert variant="destructive">
              <AlertDescription>{history.error}</AlertDescription>
            </Alert>
          )}
          {history.loading && history.changes.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("loadingHistory")}
            </div>
          ) : (
            <>
              {versions.length < 2 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noDescriptionHistory")}
                </p>
              ) : (
                <div className="space-y-3">
                  <VersionSelect
                    label={t("compareFrom")}
                    onChange={setFromId}
                    value={effectiveFromId}
                    versionLabel={versionLabel}
                    versions={versions}
                  />
                  <VersionSelect
                    label={t("compareTo")}
                    onChange={setToId}
                    value={effectiveToId}
                    versionLabel={versionLabel}
                    versions={versions}
                  />
                </div>
              )}
              {(hasMore || versions.length >= 2) && (
                <div className="flex flex-wrap justify-end gap-2">
                  {hasMore && (
                    <Button
                      disabled={history.loading}
                      onClick={() => void history.load()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {history.loading ? t("loadingHistory") : t("loadMore")}
                    </Button>
                  )}
                  {versions.length >= 2 && (
                    <Button
                      disabled={
                        !fromVersion ||
                        !toVersion ||
                        effectiveFromId === effectiveToId
                      }
                      onClick={() => {
                        setOpen(false);
                        setCompareOpen(true);
                      }}
                      size="sm"
                      type="button"
                    >
                      <GitCompareArrows /> {t("compareVersions")}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>

      <Dialog onOpenChange={setCompareOpen} open={compareOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t("descriptionComparison")}</DialogTitle>
            <DialogDescription>
              {fromVersion && toVersion
                ? `${versionLabel(fromVersion)} → ${versionLabel(toVersion)}`
                : t("selectVersions")}
            </DialogDescription>
          </DialogHeader>
          <DescriptionDiff changes={differences} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function VersionSelect({
  label,
  onChange,
  value,
  versionLabel,
  versions,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
  versionLabel: (version: JiraDescriptionVersion) => string;
  versions: JiraDescriptionVersion[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{versionLabel(version)}</span>
                {version.author && (
                  <JiraUser
                    avatarUrl={version.author.avatarUrl}
                    compact
                    name={version.author.displayName}
                    nameClassName="truncate"
                  />
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DescriptionDiff({ changes }: { changes: Change[] }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-lg border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
      {changes.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        changes.flatMap((change, changeIndex) =>
          change.value.split("\n").flatMap((line, lineIndex, lines) => {
            if (lineIndex === lines.length - 1 && line === "") return [];
            const prefix = change.added ? "+" : change.removed ? "−" : " ";
            return [
              <span
                className={
                  change.added
                    ? "block bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
                    : change.removed
                      ? "block bg-red-500/15 text-red-800 dark:text-red-200"
                      : "block"
                }
                key={`${changeIndex}-${lineIndex}`}
              >
                <span className="mr-2 inline-block w-3 text-center select-none">
                  {prefix}
                </span>
                {line || " "}
              </span>,
            ];
          }),
        )
      )}
    </pre>
  );
}
