"use client";

import { RefreshCw, Save, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { SearchableSelect } from "@/components/common/searchable-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { ReviewerPerson } from "./reviewer-person";
import {
  REPOSITORY_CODE_REVIEWERS_FIELDS,
  toggleReviewer,
  type RepositoryCodeReviewers,
} from "./types";

type ReviewerDrafts = Record<string, string[]>;

function poolDrafts(value: RepositoryCodeReviewers): ReviewerDrafts {
  return Object.fromEntries(
    value.pools.map((pool) => [pool.key, pool.selectedReviewerIds]),
  );
}

export function CodeReviewersSettings({
  repositoryId,
}: {
  repositoryId: string;
}) {
  const t = useTranslations("reviewers");
  const [data, setData] = useState<RepositoryCodeReviewers | null>(null);
  const [drafts, setDrafts] = useState<ReviewerDrafts>({});
  const [ref, setRef] = useState<string>();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestOwner = useRef<AbortController | null>(null);
  const dirtyPools = useRef(new Set<string>());

  const load = useCallback(
    async (refresh = false, preserveDrafts = false) => {
      requestOwner.current?.abort();
      const owner = new AbortController();
      requestOwner.current = owner;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const result = await controlPlaneRequest<{
          repositoryCodeReviewers: RepositoryCodeReviewers;
        }>(
          `query RepositoryCodeReviewers($repositoryId: ID!, $ref: String, $refresh: Boolean) {
            repositoryCodeReviewers(repositoryId: $repositoryId, ref: $ref, refresh: $refresh) {
              ${REPOSITORY_CODE_REVIEWERS_FIELDS}
            }
          }`,
          { repositoryId, ref: ref ?? null, refresh },
          { signal: owner.signal },
        );
        if (owner.signal.aborted) return;
        const next = result.repositoryCodeReviewers;
        setData(next);
        setDrafts((previous) =>
          preserveDrafts
            ? {
                ...poolDrafts(next),
                ...Object.fromEntries(
                  Object.entries(previous).filter(([key]) =>
                    dirtyPools.current.has(key),
                  ),
                ),
              }
            : poolDrafts(next),
        );
        if (!preserveDrafts) dirtyPools.current.clear();
      } catch (value) {
        if (!owner.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!owner.signal.aborted) setLoading(false);
      }
    },
    [repositoryId, ref],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const recovery = onControlPlaneRecovery(() => void load(false, true));
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      codebaseOverviewChanged: { repositoryId: string | null };
    }>(
      {
        query:
          "subscription RepositoryReviewersChanged { codebaseOverviewChanged { repositoryId } }",
      },
      {
        next: (value) => {
          const changed = value.data?.codebaseOverviewChanged;
          if (!changed?.repositoryId || changed.repositoryId === repositoryId)
            void load(false, true);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      recovery();
      unsubscribe();
      requestOwner.current?.abort();
    };
  }, [load, repositoryId]);

  const editPool = (key: string, update: (ids: string[]) => string[]) => {
    dirtyPools.current.add(key);
    setDrafts((previous) => ({
      ...previous,
      [key]: update(previous[key] ?? []),
    }));
  };

  const save = async () => {
    if (!data || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await controlPlaneRequest<{
        saveRepositoryCodeReviewers: RepositoryCodeReviewers;
      }>(
        `mutation SaveRepositoryCodeReviewers($input: SaveRepositoryCodeReviewersInput!) {
          saveRepositoryCodeReviewers(input: $input) { ${REPOSITORY_CODE_REVIEWERS_FIELDS} }
        }`,
        {
          input: {
            repositoryId,
            ref: data.ref,
            pools: data.pools.map((pool) => ({
              key: pool.key,
              reviewerIds: drafts[pool.key] ?? [],
            })),
          },
        },
      );
      setData(result.saveRepositoryCodeReviewers);
      setDrafts(poolDrafts(result.saveRepositoryCodeReviewers));
      dirtyPools.current.clear();
      setNotice(t("saved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };

  const query = search.trim().toLocaleLowerCase();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" /> {t("title")}
        </CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {data && (
            <div className="min-w-48 flex-1 space-y-2">
              <Label>{t("branch")}</Label>
              <SearchableSelect
                ariaLabel={t("branch")}
                disabled={loading || saving}
                emptyMessage={t("noBranches")}
                onValueChange={(value) => setRef(value)}
                options={[...new Set([data.ref, ...data.refs])].map(
                  (branch) => ({
                    value: branch,
                    label: branch,
                  }),
                )}
                placeholder={t("branch")}
                searchPlaceholder={t("searchBranches")}
                value={data.ref}
              />
            </div>
          )}
          <Button
            disabled={loading || saving}
            onClick={() => void load(true, true)}
            type="button"
            variant="outline"
          >
            {loading ? <Spinner /> : <RefreshCw />} {t("refresh")}
          </Button>
        </div>
        {!data && loading && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner />
            {t("loading")}
          </p>
        )}
        {data && (
          <>
            {(!data.discoveryComplete || data.issues.length > 0) && (
              <Alert>
                <AlertDescription className="space-y-1">
                  {!data.discoveryComplete && <p>{t("incompleteDiscovery")}</p>}
                  {data.issues.map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                </AlertDescription>
              </Alert>
            )}
            <Input
              aria-label={t("searchPeople")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchPeople")}
              type="search"
              value={search}
            />
            {!data.pools.length && (
              <p className="text-sm text-muted-foreground">{t("noGroups")}</p>
            )}
            {data.pools.map((pool) => {
              const selected = drafts[pool.key] ?? [];
              const people = pool.candidates.filter((person) =>
                `${person.name} ${person.username}`
                  .toLocaleLowerCase()
                  .includes(query),
              );
              return (
                <section
                  aria-label={pool.name}
                  className="space-y-2 rounded-lg border p-3"
                  key={pool.key}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{pool.name}</h3>
                    <Badge variant="secondary">
                      {t("poolSelected", { count: selected.length })}
                    </Badge>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {people.map((person) => (
                      <label
                        className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted"
                        key={person.id}
                      >
                        <Checkbox
                          aria-label={t("choosePerson", {
                            name: person.username,
                            group: pool.name,
                          })}
                          checked={selected.includes(person.id)}
                          disabled={saving || loading}
                          onCheckedChange={() =>
                            editPool(pool.key, (ids) =>
                              toggleReviewer(ids, person.id),
                            )
                          }
                        />
                        <ReviewerPerson person={person} />
                      </label>
                    ))}
                    {!people.length && (
                      <p className="p-2 text-sm text-muted-foreground">
                        {t("noPeople")}
                      </p>
                    )}
                    {pool.unavailableReviewerIds
                      .filter((id) => selected.includes(id))
                      .map((id) => (
                        <label
                          className="flex items-center gap-3 rounded-md p-2 text-sm text-muted-foreground"
                          key={id}
                        >
                          <Checkbox
                            aria-label={t("removeUnavailable", { id })}
                            checked
                            disabled={saving || loading}
                            onCheckedChange={() =>
                              editPool(pool.key, (ids) =>
                                ids.filter((value) => value !== id),
                              )
                            }
                          />
                          {t("unavailablePerson", { id })}
                        </label>
                      ))}
                  </div>
                </section>
              );
            })}
            <div className="flex justify-end">
              <Button
                disabled={saving || loading}
                onClick={() => void save()}
                type="button"
              >
                {saving ? <Spinner /> : <Save />} {t("save")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
