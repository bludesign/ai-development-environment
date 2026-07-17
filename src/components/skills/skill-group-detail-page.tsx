"use client";

import { ArrowLeft, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type {
  RepositorySummary,
  SkillGroupSummary,
  SkillSummary,
  SkillSyncRun,
} from "./types";

export function SkillGroupDetailPage({ groupId }: { groupId: string }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const [group, setGroup] = useState<SkillGroupSummary | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [name, setName] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [repositorySearch, setRepositorySearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        skillsOverview: {
          groups: SkillGroupSummary[];
          skills: SkillSummary[];
          repositories: RepositorySummary[];
        };
      }>(`query SkillGroupDetail { skillsOverview {
        groups {
          id name
          skills { id name description }
          repositories { id name displayOrigin }
        }
        skills { id name description syncGlobally packageHash updatedAt files { id path } groups { id name } }
        repositories { id name displayOrigin }
      } }`);
      const selected = data.skillsOverview.groups.find(
        (value) => value.id === groupId,
      );
      if (!selected) throw new Error(t("groupNotFound"));
      setGroup(selected);
      setName(selected.name);
      setSkillIds(selected.skills?.map((skill) => skill.id) ?? []);
      setRepositoryIds(
        selected.repositories?.map((repository) => repository.id) ?? [],
      );
      setSkills(data.skillsOverview.skills);
      setRepositories(data.skillsOverview.repositories);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [groupId, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const filteredSkills = useMemo(
    () =>
      skills.filter((skill) =>
        `${skill.name} ${skill.description}`
          .toLocaleLowerCase()
          .includes(skillSearch.toLocaleLowerCase()),
      ),
    [skillSearch, skills],
  );
  const filteredRepositories = useMemo(
    () =>
      repositories.filter((repository) =>
        `${repository.name} ${repository.displayOrigin}`
          .toLocaleLowerCase()
          .includes(repositorySearch.toLocaleLowerCase()),
      ),
    [repositories, repositorySearch],
  );

  const save = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation SaveSkillGroup($input: SaveSkillGroupInput!) {
          saveSkillGroup(input: $input) { id name }
        }`,
        { input: { id: groupId, name, skillIds, repositoryIds } },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        prepareSkillSync: SkillSyncRun;
      }>(
        `mutation SyncSkillGroup($groupId: ID!) {
          prepareSkillSync(kind: GROUP, groupId: $groupId) { id }
        }`,
        { groupId },
      );
      router.push(`/skills/sync/${data.prepareSkillSync.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation DeleteSkillGroup($id: ID!) { deleteSkillGroup(id: $id) }`,
        { id: groupId },
      );
      router.push("/skills/groups");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  if (loading || !group) {
    return (
      <div className="flex gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> {t("loadingGroup")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost">
            <Link aria-label={t("backToGroups")} href="/skills/groups">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{group.name}</h1>
            <p className="text-sm text-muted-foreground">
              {t("groupSettingsDescription")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <ConfirmationDialog
            actionLabel={t("delete")}
            cancelLabel={t("cancel")}
            description={t("deleteGroupDescription", { name: group.name })}
            onConfirm={remove}
            title={t("deleteGroup")}
            trigger={
              <Button disabled={busy} variant="ghost">
                <Trash2 /> {t("delete")}
              </Button>
            }
          />
          <Button disabled={busy} onClick={() => void sync()} variant="outline">
            <RefreshCw /> {t("syncGroup")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : <Save />} {t("saveGroup")}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="skill-group-name">{t("name")}</Label>
            <Input
              id="skill-group-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("groupSkills")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(event) => setSkillSearch(event.target.value)}
                placeholder={t("searchSkills")}
                value={skillSearch}
              />
            </div>
            <div className="max-h-96 space-y-1 overflow-auto">
              {filteredSkills.map((skill) => (
                <label
                  className="flex items-start gap-3 rounded-md border p-3"
                  key={skill.id}
                >
                  <Checkbox
                    checked={skillIds.includes(skill.id)}
                    onCheckedChange={(checked) =>
                      setSkillIds((current) =>
                        checked === true
                          ? [...new Set([...current, skill.id])]
                          : current.filter((id) => id !== skill.id),
                      )
                    }
                  />
                  <span>
                    <span className="block font-medium">{skill.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("groupRepositories")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(event) => setRepositorySearch(event.target.value)}
                placeholder={t("searchRepositories")}
                value={repositorySearch}
              />
            </div>
            <div className="max-h-96 space-y-1 overflow-auto">
              {filteredRepositories.map((repository) => (
                <label
                  className="flex items-start gap-3 rounded-md border p-3"
                  key={repository.id}
                >
                  <Checkbox
                    checked={repositoryIds.includes(repository.id)}
                    onCheckedChange={(checked) =>
                      setRepositoryIds((current) =>
                        checked === true
                          ? [...new Set([...current, repository.id])]
                          : current.filter((id) => id !== repository.id),
                      )
                    }
                  />
                  <span>
                    <span className="block font-medium">{repository.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {repository.displayOrigin}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
