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
import type { GitLabProjectCandidateView, Paginated } from "@/services/gitlab";

export type GitLabProjectOption = Pick<
  GitLabProjectCandidateView,
  "id" | "pathWithNamespace"
>;

/** Remote discovery is paged; projects seen in requests remain easy to select. */
export function GitLabAccessibleProjectSelect({
  value,
  onChange,
  knownProjects = [],
  allowAll = true,
}: {
  value: string;
  onChange: (value: string) => void;
  knownProjects?: GitLabProjectOption[];
  allowAll?: boolean;
}) {
  const t = useTranslations("gitlabPages");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<GitLabProjectOption[]>([]);
  const [selected, setSelected] = useState<GitLabProjectOption | null>(null);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestPending = useRef(false);
  const search = query.trim();

  const load = useCallback(
    async (page: number) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      requestPending.current = true;
      setBusy(true);
      setFailedPage(null);
      try {
        const data = await controlPlaneRequest<{
          gitlabAccessibleProjects: Paginated<GitLabProjectCandidateView>;
        }>(
          `query GitLabAccessibleProjects($search: String, $page: Int!, $perPage: Int!) {
          gitlabAccessibleProjects(search: $search, page: $page, perPage: $perPage) {
            items { id name pathWithNamespace webUrl defaultBranch visibility alreadyManaged }
            total page perPage nextPage
          }
        }`,
          { search: search || null, page, perPage: 25 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setItems((previous) => [
          ...new Map(
            [
              ...(page === 1 ? [] : previous),
              ...data.gitlabAccessibleProjects.items,
            ].map((project) => [project.id, project]),
          ).values(),
        ]);
        setNextPage(data.gitlabAccessibleProjects.nextPage);
      } catch {
        if (!controller.signal.aborted) setFailedPage(page);
      } finally {
        if (!controller.signal.aborted) {
          requestPending.current = false;
          setBusy(false);
        }
      }
    },
    [search],
  );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(1), search ? 300 : 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
      requestPending.current = false;
    };
  }, [open, search, load]);

  const known = useMemo(
    () =>
      new Map(
        [...knownProjects, ...(selected ? [selected] : []), ...items].map(
          (project) => [project.id, project],
        ),
      ),
    [knownProjects, selected, items],
  );
  const options = useMemo(() => {
    const retained = [...knownProjects, ...(selected ? [selected] : [])].filter(
      (project) =>
        project.pathWithNamespace
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    );
    return [
      ...new Map(
        [...retained, ...items].map((project) => [project.id, project]),
      ).values(),
    ];
  }, [knownProjects, selected, items, search]);
  const choose = (project: GitLabProjectOption | null) => {
    if (project) setSelected(project);
    onChange(project?.id ?? "");
    controllerRef.current?.abort();
    setOpen(false);
    setQuery("");
    setItems([]);
    setNextPage(null);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        controllerRef.current?.abort();
        setOpen(nextOpen);
        setQuery("");
        setItems([]);
        setNextPage(null);
        setFailedPage(null);
        setBusy(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          role="combobox"
          aria-label={t("project")}
          aria-expanded={open}
          variant="outline"
          className="h-9 w-full justify-between font-normal sm:w-80"
        >
          <span className="truncate">
            {value
              ? (known.get(value)?.pathWithNamespace ??
                t("projectWithId", { id: value }))
              : t(allowAll ? "allProjects" : "chooseProject")}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
      >
        <Command shouldFilter={false} label={t("searchProjects")}>
          <CommandInput
            aria-label={t("searchProjects")}
            placeholder={t("searchProjects")}
            value={query}
            onValueChange={(nextQuery) => {
              setQuery(nextQuery);
              if (nextQuery.trim() === search) return;
              controllerRef.current?.abort();
              setItems([]);
              setNextPage(null);
              setFailedPage(null);
              setBusy(true);
            }}
          />
          <CommandList>
            {!busy && failedPage === null && (
              <CommandEmpty>{t("noAccessibleProjects")}</CommandEmpty>
            )}
            <CommandGroup>
              {allowAll && value && (
                <CommandItem
                  value="__all_projects__"
                  onSelect={() => choose(null)}
                >
                  {t("allProjects")}
                </CommandItem>
              )}
              {options.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.id}
                  aria-label={project.pathWithNamespace}
                  data-checked={project.id === value}
                  onSelect={() => choose(project)}
                >
                  <span className="break-all">{project.pathWithNamespace}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {busy && (
            <div
              role="status"
              className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
            >
              <Spinner />
              {t("loadingProjects")}
            </div>
          )}
          {failedPage !== null && (
            <div role="alert" className="space-y-2 p-3 text-sm">
              <p>{t("projectSearchFailed")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(failedPage)}
              >
                {t("retry")}
              </Button>
            </div>
          )}
          {nextPage !== null && failedPage === null && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="m-1"
              onClick={() => {
                if (!requestPending.current) void load(nextPage);
              }}
            >
              {t("loadMoreProjects")}
            </Button>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
