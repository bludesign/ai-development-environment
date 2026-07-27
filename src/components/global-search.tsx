"use client";

import {
  Bot,
  Boxes,
  BriefcaseBusiness,
  ChevronRight,
  CircleDot,
  Cpu,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Hammer,
  History,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  TicketCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useRouter } from "@/i18n/navigation";
import {
  APP_DESTINATIONS,
  destinationVisible,
  type NavigationFeatures,
} from "@/lib/app-destinations";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

type SearchGroup =
  | "PAGES"
  | "WORKTREES"
  | "TICKETS"
  | "PULL_REQUESTS"
  | "REPOSITORIES"
  | "CODEBASES"
  | "WORKFLOWS"
  | "GITHUB_ACTIONS"
  | "BUILDS"
  | "AGENTS_JOBS"
  | "PLANS_SESSIONS"
  | "COMMANDS_RUNS"
  | "SKILLS"
  | "DEVICES_PROFILES";

type SearchKind =
  | "PAGE"
  | "WORKTREE"
  | "JIRA_TICKET"
  | "GITHUB_PULL_REQUEST"
  | "REPOSITORY"
  | "CODEBASE"
  | "WORKFLOW"
  | "WORKFLOW_RUN"
  | "GITHUB_ACTIONS_RUN"
  | "BUILD"
  | "AGENT"
  | "AGENT_JOB"
  | "PLAN"
  | "SESSION"
  | "COMMAND"
  | "COMMAND_RUN"
  | "SKILL"
  | "SKILL_GROUP"
  | "DEVICE"
  | "PROVISIONING_PROFILE";

type SearchItem = {
  key: string;
  kind: SearchKind;
  group: SearchGroup;
  title: string;
  subtitle: string | null;
  href: string;
  status: string | null;
  updatedAt: string | null;
  children: SearchItem[];
};

type StoredRecentItem = Pick<
  SearchItem,
  "key" | "kind" | "title" | "subtitle" | "href"
>;

const RECENTS_KEY = "aide:global-search:recent:v1";
const MAX_RECENTS = 8;
const SEARCH_DELAY_MS = 150;
const GROUP_ORDER: SearchGroup[] = [
  "PAGES",
  "WORKTREES",
  "TICKETS",
  "PULL_REQUESTS",
  "REPOSITORIES",
  "CODEBASES",
  "WORKFLOWS",
  "GITHUB_ACTIONS",
  "BUILDS",
  "AGENTS_JOBS",
  "PLANS_SESSIONS",
  "COMMANDS_RUNS",
  "SKILLS",
  "DEVICES_PROFILES",
];

const KIND_ICONS: Record<SearchKind, LucideIcon> = {
  PAGE: FileCode2,
  WORKTREE: GitBranch,
  JIRA_TICKET: TicketCheck,
  GITHUB_PULL_REQUEST: GitPullRequest,
  REPOSITORY: BriefcaseBusiness,
  CODEBASE: Boxes,
  WORKFLOW: Waypoints,
  WORKFLOW_RUN: CircleDot,
  GITHUB_ACTIONS_RUN: CircleDot,
  BUILD: Hammer,
  AGENT: Cpu,
  AGENT_JOB: Bot,
  PLAN: FileCode2,
  SESSION: Bot,
  COMMAND: Terminal,
  COMMAND_RUN: Terminal,
  SKILL: Sparkles,
  SKILL_GROUP: Boxes,
  DEVICE: Smartphone,
  PROVISIONING_PROFILE: ShieldCheck,
};

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/i.test(
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
  );
}

function readRecents(): StoredRecentItem[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECENTS_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is StoredRecentItem =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof item.key === "string" &&
          typeof item.kind === "string" &&
          typeof item.title === "string" &&
          typeof item.href === "string" &&
          item.href.startsWith("/") &&
          !item.href.startsWith("//") &&
          (item.subtitle === null || typeof item.subtitle === "string"),
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecent(item: SearchItem): StoredRecentItem[] {
  const current = readRecents();
  const next = [
    {
      key: item.key,
      kind: item.kind,
      title: item.title,
      subtitle: item.subtitle,
      href: item.href,
    },
    ...current.filter((recent) => recent.href !== item.href),
  ].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Search remains fully functional when browser storage is unavailable.
  }
  return next;
}

function pageMatches(query: string, values: string[]): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const corpus = values.join(" ").toLocaleLowerCase();
  return tokens.every((token) => corpus.includes(token));
}

function ResultRow({
  item,
  nested = false,
  onSelect,
}: {
  item: SearchItem;
  nested?: boolean;
  onSelect: (item: SearchItem) => void;
}) {
  const Icon = KIND_ICONS[item.kind] ?? FileCode2;
  return (
    <CommandItem
      className={cn("min-h-11 py-2", nested && "ml-5 border-l pl-3")}
      onSelect={() => onSelect(item)}
      value={item.key}
    >
      {nested ? (
        <ChevronRight className="size-3 text-muted-foreground" />
      ) : (
        <Icon className="size-4 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.title}</span>
        {item.subtitle && (
          <span className="block truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        )}
      </span>
      {item.status && (
        <Badge className="max-w-28 truncate text-[10px]" variant="outline">
          {item.status.replaceAll("_", " ")}
        </Badge>
      )}
    </CommandItem>
  );
}

export function GlobalSearch({ features }: { features: NavigationFeatures }) {
  const t = useTranslations("globalSearch");
  const shellT = useTranslations("shell");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [recents, setRecents] = useState<StoredRecentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState("⌘K");
  const requestSequence = useRef(0);
  const openRef = useRef(false);

  const updateQuery = useCallback((value: string) => {
    requestSequence.current += 1;
    setQuery(value);
    setItems([]);
    setError(null);
    setLoading(Boolean(value.trim()));
  }, []);

  const changeOpen = useCallback(
    (next: boolean) => {
      openRef.current = next;
      if (next) setRecents(readRecents());
      setOpen(next);
      if (!next) updateQuery("");
    },
    [updateQuery],
  );

  useEffect(() => {
    const platformUpdate = window.setTimeout(
      () => setShortcut(isApplePlatform() ? "⌘K" : "Ctrl K"),
      0,
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        changeOpen(!openRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(platformUpdate);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [changeOpen]);

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = requestSequence.current;
    if (!open || !trimmed) return;
    const timeout = window.setTimeout(() => {
      void controlPlaneRequest<{ globalSearch: { items: SearchItem[] } }>(
        `query GlobalSearch($query: String!) {
          globalSearch(query: $query) {
            items {
              key kind group title subtitle href status updatedAt
              children { key kind group title subtitle href status updatedAt children { key } }
            }
          }
        }`,
        { query: trimmed },
      )
        .then((data) => {
          if (sequence !== requestSequence.current) return;
          setItems(data.globalSearch.items);
          setError(null);
        })
        .catch((value) => {
          if (sequence !== requestSequence.current) return;
          setItems([]);
          setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (sequence === requestSequence.current) setLoading(false);
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [open, query]);

  const pageItems = useMemo(
    () =>
      APP_DESTINATIONS.filter((destination) =>
        destinationVisible(destination, features),
      )
        .filter((destination) => Boolean(query.trim()) || destination.common)
        .filter(
          (destination) =>
            Boolean(query.trim()) ||
            !recents.some((recent) => recent.href === destination.href),
        )
        .filter((destination) =>
          pageMatches(query, [
            shellT(destination.labelKey),
            destination.href,
            destination.section,
            ...destination.aliases,
          ]),
        )
        .map<SearchItem>((destination) => ({
          key: `page:${destination.key}`,
          kind: "PAGE",
          group: "PAGES",
          title: shellT(destination.labelKey),
          subtitle: destination.href,
          href: destination.href,
          status: null,
          updatedAt: null,
          children: [],
        })),
    [features, query, recents, shellT],
  );

  const groupedItems = useMemo(() => {
    const grouped = new Map<SearchGroup, SearchItem[]>();
    for (const item of [...pageItems, ...items]) {
      const group = grouped.get(item.group) ?? [];
      group.push(item);
      grouped.set(item.group, group);
    }
    return GROUP_ORDER.flatMap((group) => {
      const groupItems = grouped.get(group);
      return groupItems?.length ? [{ group, items: groupItems }] : [];
    });
  }, [items, pageItems]);

  const recentItems = useMemo<SearchItem[]>(
    () =>
      recents.map((recent) => ({
        ...recent,
        group: "PAGES",
        status: null,
        updatedAt: null,
        children: [],
      })),
    [recents],
  );

  const selectItem = (item: SearchItem) => {
    setRecents(writeRecent(item));
    changeOpen(false);
    router.push(item.href);
  };

  const hasResults = groupedItems.length > 0;

  return (
    <>
      <Button
        aria-label={t("open")}
        className="h-10 w-10 justify-center gap-2 px-0 @xl:w-48 @xl:justify-start @xl:px-3 @3xl:w-64"
        onClick={() => changeOpen(true)}
        title={`${t("open")} (${shortcut})`}
        type="button"
        variant="outline"
      >
        <Search className="size-4 shrink-0" />
        <span className="hidden min-w-0 flex-1 truncate text-left text-muted-foreground @xl:inline">
          {t("button")}
        </span>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground @3xl:inline">
          {shortcut}
        </kbd>
      </Button>
      <CommandDialog
        className="sm:max-w-2xl"
        description={t("description")}
        onOpenChange={changeOpen}
        open={open}
        title={t("title")}
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            onValueChange={updateQuery}
            placeholder={t("placeholder")}
            value={query}
          />
          <CommandList className="max-h-[min(60vh,32rem)]">
            {loading && (
              <div
                aria-live="polite"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                {t("loading")}
              </div>
            )}
            {error && (
              <div className="mx-2 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {t("error")}
              </div>
            )}
            {!query.trim() && recentItems.length > 0 && (
              <CommandGroup heading={t("groups.recent")}>
                {recentItems.map((item) => (
                  <ResultRow item={item} key={item.key} onSelect={selectItem} />
                ))}
              </CommandGroup>
            )}
            {!loading && !error && !hasResults && (
              <CommandEmpty>{t("empty")}</CommandEmpty>
            )}
            {groupedItems.map(({ group, items: groupItems }) => (
              <CommandGroup heading={t(`groups.${group}`)} key={group}>
                {groupItems.map((item) => (
                  <div key={item.key}>
                    <ResultRow item={item} onSelect={selectItem} />
                    {item.children.length > 0 && (
                      <div>
                        {item.children.map((child, index) => {
                          const previous = item.children[index - 1];
                          const showHeading =
                            index === 0 || previous?.kind !== child.kind;
                          return (
                            <div key={child.key}>
                              {showHeading && (
                                <div className="ml-10 px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                                  {child.kind === "BUILD"
                                    ? t("recentBuilds")
                                    : t("recentWorkflowRuns")}
                                </div>
                              )}
                              <ResultRow
                                item={child}
                                nested
                                onSelect={selectItem}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </CommandGroup>
            ))}
            {!query.trim() && recentItems.length === 0 && (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                <History className="size-3.5" />
                {t("noRecents")}
              </div>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
