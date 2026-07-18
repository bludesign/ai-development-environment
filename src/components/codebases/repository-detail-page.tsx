"use client";

import { ArrowLeft, FolderGit2, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { AGENT_FIELDS, JOB_FIELDS } from "@/components/agents/graphql-fields";
import { IosProjectSection } from "@/components/builds/ios-project-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import type { CodebaseRepository } from "./types";

const REPOSITORY_FIELDS = `
  id canonicalOrigin displayOrigin name description jiraBranchRegex keepBaseBranchUpToDate createdAt updatedAt
  skillGroups { id name }
  codebases {
    id folder observedOrigin branch headSha upstream ahead behind syncState availability statusError
    defaultBranch localBranches remoteBranches lastCheckedAt lastFetchedAt lastFetchAttemptAt lastFetchError
    agent { ${AGENT_FIELDS} }
    activeJob { ${JOB_FIELDS} }
  }
`;

export function RepositoryDetailPage({
  repositoryId,
}: {
  repositoryId: string;
}) {
  const t = useTranslations("codebases");
  const buildsT = useTranslations("builds");
  const [repository, setRepository] = useState<CodebaseRepository | null>(null);
  const [skillGroups, setSkillGroups] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jiraBranchRegex, setJiraBranchRegex] = useState("");
  const [keepBaseBranchUpToDate, setKeepBaseBranchUpToDate] = useState(true);
  const [skillGroupIds, setSkillGroupIds] = useState<string[]>([]);

  const applyRepository = useCallback((value: CodebaseRepository) => {
    setRepository(value);
    setName(value.name);
    setDescription(value.description);
    setJiraBranchRegex(value.jiraBranchRegex ?? "");
    setKeepBaseBranchUpToDate(value.keepBaseBranchUpToDate);
    setSkillGroupIds(value.skillGroups?.map((group) => group.id) ?? []);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        codebaseRepository: CodebaseRepository | null;
        skillsOverview?: { groups: Array<{ id: string; name: string }> };
      }>(
        `query RepositoryDetail($id: ID!) {
          codebaseRepository(id: $id) { ${REPOSITORY_FIELDS} }
          skillsOverview { groups { id name } }
        }`,
        { id: repositoryId },
      );
      if (data.codebaseRepository) applyRepository(data.codebaseRepository);
      else setRepository(null);
      setSkillGroups(data.skillsOverview?.groups ?? []);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [applyRepository, repositoryId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      codebaseOverviewChanged: { repositoryId: string | null };
    }>(
      {
        query: `subscription RepositoryDetailChanged {
          codebaseOverviewChanged { repositoryId }
        }`,
      },
      {
        next: (value) => {
          const changed = value.data?.codebaseOverviewChanged;
          if (!changed || changed.repositoryId === repositoryId) void load();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load, repositoryId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!repository) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await controlPlaneRequest(
        `mutation UpdateCodebaseRepository($input: UpdateCodebaseRepositoryInput!) {
          updateCodebaseRepository(input: $input) { id }
        }`,
        {
          input: {
            id: repository.id,
            name,
            description,
            jiraBranchRegex: jiraBranchRegex || null,
            keepBaseBranchUpToDate,
            skillGroupIds,
          },
        },
      );
      await load();
      setNotice(t("repositorySaved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <p className="mx-auto flex max-w-6xl items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loadingRepository")}
      </p>
    );
  }
  if (!repository) {
    return (
      <Empty className="mx-auto max-w-6xl border py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderGit2 />
          </EmptyMedia>
          <EmptyTitle>{t("repositoryNotFound")}</EmptyTitle>
          <EmptyDescription>
            {t("repositoryNotFoundDescription")}
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link href="/codebases">
            <ArrowLeft /> {t("backToCodebases")}
          </Link>
        </Button>
      </Empty>
    );
  }

  const checkouts = repository.codebases.map((codebase) => ({
    codebaseId: codebase.id,
    label: `${codebase.agent.name} · ${codebase.folder}`,
    available:
      codebase.agent.connectionStatus === "ONLINE" &&
      codebase.availability === "AVAILABLE",
  }));

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button asChild className="-ml-2" size="sm" variant="ghost">
          <Link href="/codebases">
            <ArrowLeft /> {t("backToCodebases")}
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("editTitle")}
        </h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {repository.displayOrigin}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("repositorySharedDescription")}
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">{t("repositoryDetails")}</TabsTrigger>
          <TabsTrigger value="ios-app">{buildsT("iosApp")}</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <form className="space-y-5" onSubmit={save}>
            <Card>
              <CardHeader>
                <CardTitle>{t("repositoryDetails")}</CardTitle>
                <CardDescription>
                  {t("repositoryDetailsDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="repository-name">{t("name")}</Label>
                  <Input
                    id="repository-name"
                    maxLength={120}
                    onChange={(event) => setName(event.target.value)}
                    required
                    value={name}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="repository-jira-regex">
                    {t("jiraBranchRegex")}
                  </Label>
                  <Input
                    id="repository-jira-regex"
                    onChange={(event) => setJiraBranchRegex(event.target.value)}
                    placeholder={t("inheritDefaultRegex")}
                    value={jiraBranchRegex}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("jiraBranchRegexHelp")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="repository-description">
                    {t("repositoryDescription")}
                  </Label>
                  <Textarea
                    id="repository-description"
                    maxLength={2000}
                    onChange={(event) => setDescription(event.target.value)}
                    value={description}
                  />
                </div>
                <div className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    checked={keepBaseBranchUpToDate}
                    className="mt-0.5"
                    id="repository-keep-base-branch-up-to-date"
                    onCheckedChange={(checked) =>
                      setKeepBaseBranchUpToDate(checked === true)
                    }
                  />
                  <div className="space-y-1">
                    <Label htmlFor="repository-keep-base-branch-up-to-date">
                      {t("keepBaseBranchUpToDate")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("keepBaseBranchUpToDateHelp")}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t("skillGroups")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("skillGroupsHelp")}
                  </p>
                  <div className="max-h-56 space-y-1 overflow-auto rounded-lg border p-2">
                    {skillGroups.map((group) => (
                      <label
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                        key={group.id}
                      >
                        <Checkbox
                          checked={skillGroupIds.includes(group.id)}
                          onCheckedChange={(checked) =>
                            setSkillGroupIds((current) =>
                              checked === true
                                ? [...new Set([...current, group.id])]
                                : current.filter((id) => id !== group.id),
                            )
                          }
                        />
                        {group.name}
                      </label>
                    ))}
                    {!skillGroups.length && (
                      <p className="px-2 py-1 text-sm text-muted-foreground">
                        {t("noSkillGroups")}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button disabled={busy || !name.trim()} type="submit">
                    {busy ? <Spinner /> : <Save />} {t("save")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </form>
        </TabsContent>
        <TabsContent value="ios-app">
          <IosProjectSection
            checkouts={checkouts}
            codebaseId={checkouts[0]?.codebaseId ?? ""}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
