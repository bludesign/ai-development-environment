"use client";

import { ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraAvailableProject,
  JiraAvailableProjectPage,
} from "@/services/jira/types";

/** Mounted for each manager session so discovery starts before the picker opens. */
export function JiraAvailableProjectSelect({
  value,
  onValueChange,
  managedProjectIds,
  disabled = false,
}: {
  value: JiraAvailableProject | null;
  onValueChange: (project: JiraAvailableProject) => void;
  managedProjectIds: string[];
  disabled?: boolean;
}) {
  const t = useTranslations("jiraTickets");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<JiraAvailableProject[]>([]);
  const [nextStartAt, setNextStartAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failedStartAt, setFailedStartAt] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestPending = useRef(false);
  const search = query.trim();

  const load = useCallback(async (startAt: number, search: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    requestPending.current = true;
    setLoading(true);
    setFailedStartAt(null);
    try {
      const data = await controlPlaneRequest<{
        jiraAvailableProjectPage: JiraAvailableProjectPage;
      }>(
        `query JiraAvailableProjectPage($search: String, $startAt: Int!, $maxResults: Int!) {
          jiraAvailableProjectPage(search: $search, startAt: $startAt, maxResults: $maxResults) {
            items { jiraId key name avatarUrl }
            total startAt maxResults nextStartAt
          }
        }`,
        { search: search || null, startAt, maxResults: 25 },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || controllerRef.current !== controller)
        return;
      setItems((previous) => [
        ...new Map(
          [
            ...(startAt === 0 ? [] : previous),
            ...data.jiraAvailableProjectPage.items,
          ].map((project) => [project.jiraId, project]),
        ).values(),
      ]);
      setNextStartAt(data.jiraAvailableProjectPage.nextStartAt);
    } catch {
      if (!controller.signal.aborted && controllerRef.current === controller)
        setFailedStartAt(startAt);
    } finally {
      if (!controller.signal.aborted && controllerRef.current === controller) {
        requestPending.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => void load(0, search),
      search ? 300 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
      requestPending.current = false;
    };
  }, [search, load]);

  // A chosen project's label must survive searches and pagination.
  const options = useMemo(() => {
    const managed = new Set(managedProjectIds);
    const retained =
      value &&
      `${value.key} ${value.name}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase())
        ? [value]
        : [];
    return [
      ...new Map(
        [...retained, ...items].map((project) => [project.jiraId, project]),
      ).values(),
    ].filter((project) => !managed.has(project.jiraId));
  }, [items, managedProjectIds, search, value]);
  const selectedLabel = value
    ? `${value.key} · ${value.name}`
    : t("selectProject");
  // Sheets/dialogs lock scroll outside their overlay; allow this portaled list to scroll.
  const popoverRef = useCallback((node: HTMLDivElement | null) => {
    if (node)
      node.addEventListener("wheel", (event) => event.stopPropagation());
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          role="combobox"
          aria-label={t("availableProjects")}
          aria-expanded={open}
          aria-busy={loading}
          disabled={disabled}
          variant="outline"
          className="w-full min-w-0 justify-between font-normal"
          title={selectedLabel}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedLabel}
          </span>
          {loading && (
            <Spinner
              aria-hidden={false}
              aria-label={t("loading")}
              className="shrink-0"
            />
          )}
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={popoverRef}
        align="start"
        className="z-70 max-h-[min(24rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <Command
          className="min-h-0"
          shouldFilter={false}
          label={t("searchProjects")}
        >
          <CommandInput
            autoFocus
            aria-label={t("searchProjects")}
            placeholder={t("searchProjects")}
            value={query}
            onValueChange={(nextQuery) => {
              setQuery(nextQuery);
              if (nextQuery.trim() === search) return;
              controllerRef.current?.abort();
              requestPending.current = false;
              setItems([]);
              setNextStartAt(null);
              setFailedStartAt(null);
              setLoading(true);
            }}
          />
          <CommandList className="min-h-0 flex-1 max-h-64 overscroll-contain">
            {!loading && failedStartAt === null && nextStartAt === null && (
              <CommandEmpty>{t("noAvailableProjects")}</CommandEmpty>
            )}
            <CommandGroup>
              {options.map((project) => (
                <CommandItem
                  key={project.jiraId}
                  value={project.jiraId}
                  aria-label={`${project.key} · ${project.name}`}
                  title={`${project.key} · ${project.name}`}
                  data-checked={project.jiraId === value?.jiraId}
                  onSelect={() => {
                    onValueChange(project);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 truncate">
                    {project.key} · {project.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {loading && (
          <p className="p-3 text-sm text-muted-foreground">{t("loading")}</p>
        )}
        {failedStartAt !== null && (
          <div role="alert" className="space-y-2 p-3 text-sm">
            <p>{t("projectSearchFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (!requestPending.current) void load(failedStartAt, search);
              }}
            >
              {t("retry")}
            </Button>
          </div>
        )}
        {nextStartAt !== null && failedStartAt === null && (
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            className="m-1"
            onClick={() => {
              if (!requestPending.current) void load(nextStartAt, search);
            }}
          >
            {t("loadMoreProjects")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
