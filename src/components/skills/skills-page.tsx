"use client";

import {
  ArrowDownToLine,
  Check,
  Database,
  FolderTree,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type {
  SkillInstallation,
  SkillSettings,
  SkillTool,
  SkillsOverview,
  SkillSyncRun,
} from "./types";

const TOOL_LABELS: Record<SkillTool, string> = {
  CURSOR: "Cursor",
  GITHUB_COPILOT: "GitHub Copilot",
  CODEX: "OpenAI Codex",
  CLAUDE: "Claude Code",
  OPENCODE: "OpenCode",
};

const OVERVIEW_QUERY = `
  query SkillsOverview($search: String) {
    skillsOverview(search: $search) {
      skills {
        id name description syncGlobally packageHash updatedAt
        files { id path }
        groups { id name }
      }
      groups { id name }
      observations {
        tool configured homePath checkedAt
        agent { id name hostname connectionStatus }
      }
      installations {
        id scope rootKind rootPath skillName description packageHash fileCount totalBytes tracked consumers lastSeenAt
        agent { id name hostname connectionStatus }
        codebase { id folder repository { id name displayOrigin } }
        worktree { id folder }
        skill { id name packageHash }
      }
      settings {
        autoSyncProjectGroups cursorEnabled githubCopilotEnabled codexEnabled claudeEnabled openCodeEnabled updatedAt
      }
      repositories { id name displayOrigin }
    }
  }
`;

function enabled(settings: SkillSettings, tool: SkillTool): boolean {
  if (tool === "CURSOR") return settings.cursorEnabled;
  if (tool === "GITHUB_COPILOT") return settings.githubCopilotEnabled;
  if (tool === "CODEX") return settings.codexEnabled;
  if (tool === "CLAUDE") return settings.claudeEnabled;
  return settings.openCodeEnabled;
}

function direction(installation: SkillInstallation) {
  if (!installation.skill) return "IMPORT";
  if (installation.skill.packageHash === installation.packageHash)
    return "UNCHANGED";
  return "CONFLICT";
}

export function SkillsPage() {
  const t = useTranslations("skills");
  const router = useRouter();
  const [overview, setOverview] = useState<SkillsOverview | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<string>("DATABASE");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        skillsOverview: SkillsOverview;
      }>(OVERVIEW_QUERY, { search });
      setOverview(data.skillsOverview);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const configuredTools = useMemo(() => {
    if (!overview) return [];
    return Object.keys(TOOL_LABELS).filter((value): value is SkillTool => {
      const tool = value as SkillTool;
      return (
        enabled(overview.settings, tool) &&
        overview.observations.some(
          (observation) => observation.tool === tool && observation.configured,
        )
      );
    });
  }, [overview]);
  const configuredCounts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(TOOL_LABELS) as SkillTool[]).map((tool) => [
          tool,
          overview?.observations.filter(
            (observation) =>
              observation.tool === tool && observation.configured,
          ).length ?? 0,
        ]),
      ) as Record<SkillTool, number>,
    [overview],
  );

  const activeTab =
    tab === "DATABASE" || configuredTools.includes(tab as SkillTool)
      ? tab
      : "DATABASE";

  const syncAll = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        prepareSkillSync: SkillSyncRun;
      }>(`mutation PrepareSkillSync { prepareSkillSync(kind: ALL) { id } }`);
      router.push(`/skills/sync/${data.prepareSkillSync.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/skills/groups">
              <FolderTree /> {t("manageGroups")}
            </Link>
          </Button>
          <Button onClick={() => setSettingsOpen(true)} variant="outline">
            <Settings /> {t("settings")}
          </Button>
          <Button asChild variant="outline">
            <Link href="/skills/new">
              <Plus /> {t("addSkill")}
            </Link>
          </Button>
          <Button disabled={busy} onClick={() => void syncAll()}>
            {busy ? <Spinner /> : <RefreshCw />} {t("syncAll")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="relative max-w-xl">
        <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          aria-label={t("search")}
          className="pl-9"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchPlaceholder")}
          value={search}
        />
      </div>

      <Tabs onValueChange={setTab} value={activeTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="DATABASE">
            <Database /> {t("database")}
          </TabsTrigger>
          {configuredTools.map((tool) => (
            <TabsTrigger key={tool} value={tool}>
              {TOOL_LABELS[tool]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading || !overview ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </div>
      ) : activeTab === "DATABASE" ? (
        <DatabaseTable overview={overview} />
      ) : (
        <InstallationTable
          installations={overview.installations.filter((installation) =>
            installation.consumers.includes(activeTab as SkillTool),
          )}
        />
      )}

      {overview && (
        <SkillSettingsDialog
          key={`${overview.settings.updatedAt}-${settingsOpen ? "open" : "closed"}`}
          configuredCounts={configuredCounts}
          onOpenChange={setSettingsOpen}
          onSaved={load}
          open={settingsOpen}
          settings={overview.settings}
        />
      )}
    </div>
  );
}

function DatabaseTable({ overview }: { overview: SkillsOverview }) {
  const t = useTranslations("skills");
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{t("databaseSkills")}</CardTitle>
        <CardDescription>{t("databaseSkillsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("skillDescription")}</TableHead>
              <TableHead>{t("scope")}</TableHead>
              <TableHead>{t("groups")}</TableHead>
              <TableHead>{t("files")}</TableHead>
              <TableHead>{t("updated")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.skills.map((skill) => (
              <TableRow key={skill.id}>
                <TableCell>
                  <Link
                    className="font-medium text-primary hover:underline"
                    href={`/skills/${skill.id}`}
                  >
                    {skill.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-lg whitespace-normal text-muted-foreground">
                  {skill.description}
                </TableCell>
                <TableCell>
                  <Badge variant={skill.syncGlobally ? "default" : "secondary"}>
                    {skill.syncGlobally ? t("global") : t("projectOnly")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {skill.groups.length
                      ? skill.groups.map((group) => (
                          <Badge key={group.id} variant="outline">
                            {group.name}
                          </Badge>
                        ))
                      : "—"}
                  </div>
                </TableCell>
                <TableCell>{skill.files.length}</TableCell>
                <TableCell>
                  {new Date(skill.updatedAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {!overview.skills.length && (
              <TableRow>
                <TableCell
                  className="py-10 text-center text-muted-foreground"
                  colSpan={6}
                >
                  {t("noSkills")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function InstallationTable({
  installations,
}: {
  installations: SkillInstallation[];
}) {
  const t = useTranslations("skills");
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{t("clientSkills")}</CardTitle>
        <CardDescription>{t("clientSkillsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("scope")}</TableHead>
              <TableHead>{t("agent")}</TableHead>
              <TableHead>{t("location")}</TableHead>
              <TableHead>{t("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {installations.map((installation) => {
              const state = direction(installation);
              return (
                <TableRow key={installation.id}>
                  <TableCell>
                    <div className="font-medium">{installation.skillName}</div>
                    <div className="max-w-md whitespace-normal text-xs text-muted-foreground">
                      {installation.description}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {installation.scope === "GLOBAL"
                        ? t("global")
                        : t("project")}
                    </Badge>
                    {installation.codebase && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {installation.codebase.repository.name}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{installation.agent.name}</TableCell>
                  <TableCell className="max-w-md whitespace-normal font-mono text-xs">
                    {installation.rootPath}
                    {installation.tracked && (
                      <Badge className="ml-2" variant="secondary">
                        {t("tracked")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {state === "UNCHANGED" ? (
                      <Badge className="gap-1" variant="secondary">
                        <Check /> {t("inSync")}
                      </Badge>
                    ) : state === "IMPORT" ? (
                      <Badge className="gap-1" variant="outline">
                        <ArrowDownToLine /> {t("toDatabase")}
                      </Badge>
                    ) : (
                      <Badge className="gap-1" variant="destructive">
                        <ShieldAlert /> {t("conflict")}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!installations.length && (
              <TableRow>
                <TableCell
                  className="py-10 text-center text-muted-foreground"
                  colSpan={5}
                >
                  {t("noClientSkills")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SkillSettingsDialog({
  configuredCounts,
  onOpenChange,
  onSaved,
  open,
  settings,
}: {
  configuredCounts: Record<SkillTool, number>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  settings: SkillSettings;
}) {
  const t = useTranslations("skills");
  const [value, setValue] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTool = (tool: SkillTool, checked: boolean) => {
    setValue((current) => ({
      ...current,
      ...(tool === "CURSOR" ? { cursorEnabled: checked } : {}),
      ...(tool === "GITHUB_COPILOT" ? { githubCopilotEnabled: checked } : {}),
      ...(tool === "CODEX" ? { codexEnabled: checked } : {}),
      ...(tool === "CLAUDE" ? { claudeEnabled: checked } : {}),
      ...(tool === "OPENCODE" ? { openCodeEnabled: checked } : {}),
    }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation SaveSkillSettings($input: SaveSkillSettingsInput!) {
          saveSkillSettings(input: $input) { updatedAt }
        }`,
        {
          input: {
            autoSyncProjectGroups: value.autoSyncProjectGroups,
            cursorEnabled: value.cursorEnabled,
            githubCopilotEnabled: value.githubCopilotEnabled,
            codexEnabled: value.codexEnabled,
            claudeEnabled: value.claudeEnabled,
            openCodeEnabled: value.openCodeEnabled,
          },
        },
      );
      await onSaved();
      onOpenChange(false);
    } catch (result) {
      setError(result instanceof Error ? result.message : String(result));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Checkbox
            checked={value.autoSyncProjectGroups}
            id="skills-auto-sync"
            onCheckedChange={(checked) =>
              setValue((current) => ({
                ...current,
                autoSyncProjectGroups: checked === true,
              }))
            }
          />
          <div>
            <Label htmlFor="skills-auto-sync">{t("autoSync")}</Label>
            <p className="text-xs text-muted-foreground">{t("autoSyncHelp")}</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t("enabledTools")}</Label>
          {(Object.keys(TOOL_LABELS) as SkillTool[]).map((tool) => {
            const checked = enabled(value, tool);
            return (
              <div
                className="flex items-center gap-3 rounded-md border px-3 py-2"
                key={tool}
              >
                <Checkbox
                  checked={checked}
                  id={`skill-tool-${tool}`}
                  onCheckedChange={(next) => setTool(tool, next === true)}
                />
                <Label
                  className="flex flex-1 justify-between"
                  htmlFor={`skill-tool-${tool}`}
                >
                  <span>{TOOL_LABELS[tool]}</span>
                  <span className="text-xs text-muted-foreground">
                    {configuredCounts[tool] > 0
                      ? t("configuredAgents", {
                          count: configuredCounts[tool],
                        })
                      : t("notDetected")}
                  </span>
                </Label>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Spinner />} {t("saveSettings")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
