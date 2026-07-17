"use client";

import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Check,
  GitCompareArrows,
  Play,
  SkipForward,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import type { SkillGroupSummary, SkillSyncItem, SkillSyncRun } from "./types";
import { SKILL_SYNC_RUN_FIELDS } from "./types";

type PackageFile = NonNullable<
  NonNullable<SkillSyncItem["candidatePackage"]>["package"]
>["files"][number];

const NO_SKILL_GROUP_VALUE = "__none__";

const AGENT_PHASE_RANK: Record<string, number> = { SCAN: 0, READ: 1, APPLY: 2 };

function bytes(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function textContents(file: PackageFile | undefined): string | null {
  if (!file) return null;
  const contents = bytes(file.contentsBase64);
  if (contents.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    return null;
  }
}

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 32_768) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 32_768));
  }
  return window.btoa(binary);
}

function directionIcon(direction: string) {
  if (direction === "IMPORT") return <ArrowDownToLine />;
  if (direction === "EXPORT") return <ArrowUpFromLine />;
  if (direction === "DELETE_REDUNDANT") return <Trash2 />;
  if (direction === "CONFLICT") return <GitCompareArrows />;
  return <Check />;
}

function displayEnum(value: string): string {
  return value
    .toLocaleLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}

function FilePreview({
  file,
  missingLabel,
  binaryLabel,
  executableLabel,
}: {
  file: PackageFile | undefined;
  missingLabel: string;
  binaryLabel: string;
  executableLabel: string;
}) {
  if (!file) {
    return <p className="text-sm text-muted-foreground">{missingLabel}</p>;
  }
  const text = textContents(file);
  if (text === null) {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{binaryLabel}</p>
        <p>{bytes(file.contentsBase64).byteLength.toLocaleString()} B</p>
        {file.executable && <Badge variant="outline">{executableLabel}</Badge>}
      </div>
    );
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
      {text}
    </pre>
  );
}

export function SkillSyncPage({ runId }: { runId: string }) {
  const t = useTranslations("skills");
  const tStatus = useTranslations("status");
  const [run, setRun] = useState<SkillSyncRun | null>(null);
  const [groups, setGroups] = useState<SkillGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualItem, setManualItem] = useState<SkillSyncItem | null>(null);
  const [databaseFiles, setDatabaseFiles] = useState<PackageFile[]>([]);
  const [manualFiles, setManualFiles] = useState<PackageFile[]>([]);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [renamePath, setRenamePath] = useState("SKILL.md");
  const [compareLoading, setCompareLoading] = useState(false);
  const [groupChoices, setGroupChoices] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        skillSyncRun: SkillSyncRun | null;
        skillsOverview: { groups: SkillGroupSummary[] };
      }>(
        `query SkillSyncRun($id: ID!) {
          skillSyncRun(id: $id) { ${SKILL_SYNC_RUN_FIELDS} }
          skillsOverview { groups { id name } }
        }`,
        { id: runId },
      );
      if (!data.skillSyncRun) throw new Error(t("syncRunNotFound"));
      setRun(data.skillSyncRun);
      setGroups(data.skillsOverview.groups);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [runId, t]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => void load(), 10_000);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      skillSyncRunChanged: SkillSyncRun;
    }>(
      {
        query: `subscription SkillSyncRunChanged($runId: ID!) {
          skillSyncRunChanged(runId: $runId) { ${SKILL_SYNC_RUN_FIELDS} }
        }`,
        variables: { runId },
      },
      {
        next: (value) =>
          value.data?.skillSyncRunChanged &&
          setRun(value.data.skillSyncRunChanged),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      unsubscribe();
    };
  }, [load, runId]);

  const visibleItems = useMemo(
    () =>
      run?.items.filter(
        (item) => !["SCAN", "READ", "APPLY"].includes(item.direction),
      ) ?? [],
    [run],
  );
  const agentProgress = useMemo(() => {
    const latestByAgent = new Map<string, SkillSyncItem>();
    for (const item of run?.items ?? []) {
      if (!["SCAN", "READ", "APPLY"].includes(item.direction)) continue;
      const key = item.agent?.id ?? item.id;
      const current = latestByAgent.get(key);
      const rank = AGENT_PHASE_RANK[item.direction] ?? 0;
      const currentRank = current ? (AGENT_PHASE_RANK[current.direction] ?? 0) : -1;
      if (
        !current ||
        rank > currentRank ||
        (rank === currentRank && item.updatedAt > current.updatedAt)
      ) {
        latestByAgent.set(key, item);
      }
    }
    return [...latestByAgent.values()];
  }, [run]);
  const pendingAgentItems = useMemo(
    () => agentProgress.filter((item) => item.status === "PENDING"),
    [agentProgress],
  );
  const targetFiles = useMemo(
    () => manualItem?.candidatePackage?.package?.files ?? [],
    [manualItem],
  );
  const comparePaths = useMemo(
    () =>
      [
        ...new Set(
          [...databaseFiles, ...targetFiles, ...manualFiles].map(
            (file) => file.path,
          ),
        ),
      ].sort((first, second) => first.localeCompare(second)),
    [databaseFiles, manualFiles, targetFiles],
  );
  const databaseFile = databaseFiles.find((file) => file.path === selectedPath);
  const targetFile = targetFiles.find((file) => file.path === selectedPath);
  const manualFile = manualFiles.find((file) => file.path === selectedPath);

  const resolve = async (
    item: SkillSyncItem,
    resolution: "DATABASE" | "TARGET" | "MANUAL" | "DELETE" | "SKIP",
    manualPackage?: SkillSyncItem["candidatePackage"],
  ) => {
    setBusy(true);
    try {
      const packageValue = manualPackage?.package;
      const data = await controlPlaneRequest<{
        resolveSkillSyncItem: SkillSyncRun;
      }>(
        `mutation ResolveSkillSyncItem($input: ResolveSkillSyncItemInput!) {
          resolveSkillSyncItem(input: $input) { ${SKILL_SYNC_RUN_FIELDS} }
        }`,
        {
          input: {
            itemId: item.id,
            resolution,
            groupId: groupChoices[item.id] || null,
            package: packageValue
              ? {
                  name: packageValue.name,
                  description: packageValue.description,
                  files: packageValue.files,
                }
              : null,
          },
        },
      );
      setRun(data.resolveSkillSyncItem);
      setManualItem(null);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{ applySkillSync: SkillSyncRun }>(
        `mutation ApplySkillSync($runId: ID!) {
          applySkillSync(runId: $runId) { ${SKILL_SYNC_RUN_FIELDS} }
        }`,
        { runId },
      );
      setRun(data.applySkillSync);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const skipPending = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        skipPendingSkillSync: SkillSyncRun;
      }>(
        `mutation SkipPendingSkillSync($runId: ID!) {
          skipPendingSkillSync(runId: $runId) { ${SKILL_SYNC_RUN_FIELDS} }
        }`,
        { runId },
      );
      setRun(data.skipPendingSkillSync);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const openManual = async (item: SkillSyncItem) => {
    const packageValue = item.candidatePackage?.package;
    if (!packageValue) return;
    setManualItem(item);
    setManualFiles(packageValue.files.map((file) => ({ ...file })));
    setSelectedPath("SKILL.md");
    setRenamePath("SKILL.md");
    setDatabaseFiles([]);
    if (!item.skill) return;
    setCompareLoading(true);
    try {
      const data = await controlPlaneRequest<{
        skill: { files: PackageFile[] } | null;
      }>(
        `query ConflictDatabasePackage($id: ID!) {
          skill(id: $id) { files { path contentsBase64 executable } }
        }`,
        { id: item.skill.id },
      );
      setDatabaseFiles(data.skill?.files ?? []);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setCompareLoading(false);
    }
  };

  const saveManual = async () => {
    if (!manualItem?.candidatePackage?.package) return;
    const packageValue = manualItem.candidatePackage.package;
    await resolve(manualItem, "MANUAL", {
      ...manualItem.candidatePackage,
      package: {
        ...packageValue,
        files: manualFiles,
      },
    });
  };

  const uploadManualFiles = async (list: FileList | null) => {
    if (!list) return;
    const additions = await Promise.all(
      [...list].map(async (file) => ({
        path: file.name,
        contentsBase64: encodeBytes(new Uint8Array(await file.arrayBuffer())),
        executable: false,
      })),
    );
    setManualFiles((current) => [
      ...current.filter(
        (file) => !additions.some((addition) => addition.path === file.path),
      ),
      ...additions,
    ]);
    if (additions[0]) {
      setSelectedPath(additions[0].path);
      setRenamePath(additions[0].path);
    }
  };

  const renameManualFile = () => {
    const nextPath = renamePath.trim().replaceAll("\\", "/");
    if (
      !manualFile ||
      !nextPath ||
      (nextPath !== manualFile.path &&
        manualFiles.some((file) => file.path === nextPath))
    ) {
      return;
    }
    setManualFiles((current) =>
      current.map((file) =>
        file.path === manualFile.path ? { ...file, path: nextPath } : file,
      ),
    );
    setSelectedPath(nextPath);
    setRenamePath(nextPath);
  };

  if (loading || !run) {
    return (
      <div className="flex gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> {t("loadingSync")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost">
            <Link aria-label={t("backToSkills")} href="/skills">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{t("syncTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {run.group
                ? t("syncGroupName", { name: run.group.name })
                : t("syncAllDescription")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={run.status === "SUCCEEDED" ? "secondary" : "outline"}>
            {displayEnum(run.status)}
          </Badge>
          {pendingAgentItems.length > 0 && (
            <Button
              disabled={busy}
              onClick={() => void skipPending()}
              variant="outline"
            >
              {busy ? <Spinner /> : <SkipForward />} {t("skipPendingClients")}
            </Button>
          )}
          <Button
            disabled={busy || !["READY", "PARTIAL"].includes(run.status)}
            onClick={() => void apply()}
          >
            {busy ? <Spinner /> : <Play />} {t("applySync")}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {agentProgress.length > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>{t("syncAgents")}</CardTitle>
            <CardDescription>{t("syncAgentsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("agent")}</TableHead>
                  <TableHead>{t("connection")}</TableHead>
                  <TableHead>{t("operation")}</TableHead>
                  <TableHead>{t("syncStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentProgress.map((item) => {
                  const online = item.agent?.connectionStatus === "ONLINE";
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">
                        {item.agent?.name ?? t("unknownAgent")}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            online
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : undefined
                          }
                          variant={online ? "outline" : "secondary"}
                        >
                          {displayEnum(tStatus(online ? "online" : "offline"))}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {displayEnum(item.direction)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.status === "FAILED"
                              ? "destructive"
                              : item.status === "COMPLETE" ||
                                  item.status === "SUCCEEDED"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {displayEnum(item.status)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>{t("syncChanges")}</CardTitle>
          <CardDescription>{t("syncChangesDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("change")}</TableHead>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("agent")}</TableHead>
                <TableHead>{t("location")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("resolution")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleItems.map((item) => {
                const projectGroupRequired =
                  item.candidatePackage?.projectGroupRequired;
                const canDeleteClientCopy =
                  item.direction === "IMPORT" &&
                  item.installation &&
                  !item.installation.tracked;
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Badge
                        className="gap-1"
                        variant={
                          item.direction === "CONFLICT"
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {directionIcon(item.direction)}{" "}
                        {displayEnum(item.direction)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {item.skill?.name ?? item.installation?.skillName ?? "—"}
                    </TableCell>
                    <TableCell>
                      {item.agent?.name ?? item.installation?.agent.name ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal font-mono text-xs">
                      {item.installation?.rootPath ?? t("newSharedLocation")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          item.status === "BLOCKED"
                            ? "destructive"
                            : item.status === "READY" ||
                                item.status === "COMPLETE"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {displayEnum(item.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {projectGroupRequired && item.status === "BLOCKED" && (
                        <Select
                          onValueChange={(value) =>
                            setGroupChoices((current) => ({
                              ...current,
                              [item.id]:
                                value === NO_SKILL_GROUP_VALUE ? "" : value,
                            }))
                          }
                          value={groupChoices[item.id] || NO_SKILL_GROUP_VALUE}
                        >
                          <SelectTrigger
                            className="mb-1 w-full min-w-48"
                            size="sm"
                          >
                            <SelectValue placeholder={t("chooseGroup")} />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value={NO_SKILL_GROUP_VALUE}>
                              {t("chooseGroup")}
                            </SelectItem>
                            {groups.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {item.status === "BLOCKED" ? (
                        <div className="flex flex-wrap gap-1">
                          {item.skill && (
                            <Button
                              disabled={busy}
                              onClick={() => void resolve(item, "DATABASE")}
                              size="sm"
                              variant="outline"
                            >
                              {t("useDatabase")}
                            </Button>
                          )}
                          {item.candidatePackage?.package && (
                            <>
                              <Button
                                disabled={
                                  busy ||
                                  (projectGroupRequired &&
                                    !groupChoices[item.id])
                                }
                                onClick={() => void resolve(item, "TARGET")}
                                size="sm"
                                variant="outline"
                              >
                                {t("useTarget")}
                              </Button>
                              <Button
                                disabled={busy}
                                onClick={() => void openManual(item)}
                                size="sm"
                                variant="outline"
                              >
                                <GitCompareArrows /> {t("compareAndResolve")}
                              </Button>
                            </>
                          )}
                          {canDeleteClientCopy && (
                            <Button
                              disabled={busy}
                              onClick={() => void resolve(item, "DELETE")}
                              size="sm"
                              variant="destructive"
                            >
                              <Trash2 /> {t("deleteClientCopy")}
                            </Button>
                          )}
                          <Button
                            disabled={busy}
                            onClick={() => void resolve(item, "SKIP")}
                            size="sm"
                            variant="outline"
                          >
                            {t("skip")}
                          </Button>
                        </div>
                      ) : canDeleteClientCopy && item.status === "READY" ? (
                        <Button
                          disabled={busy}
                          onClick={() => void resolve(item, "DELETE")}
                          size="sm"
                          variant="destructive"
                        >
                          <Trash2 /> {t("deleteClientCopy")}
                        </Button>
                      ) : item.resolution ? (
                        displayEnum(item.resolution)
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!visibleItems.length && (
                <TableRow>
                  <TableCell
                    className="py-10 text-center text-muted-foreground"
                    colSpan={6}
                  >
                    {run.status === "PREPARING"
                      ? t("scanningAgents")
                      : t("noSyncChanges")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setManualItem(null);
            setDatabaseFiles([]);
            setManualFiles([]);
          }
        }}
        open={Boolean(manualItem)}
      >
        <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-6xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("manualResolution")}</DialogTitle>
            <DialogDescription>
              {t("manualResolutionDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              disabled={!databaseFiles.length || compareLoading}
              onClick={() =>
                setManualFiles(databaseFiles.map((file) => ({ ...file })))
              }
              size="sm"
              variant="outline"
            >
              {compareLoading ? <Spinner /> : <ArrowDownToLine />}{" "}
              {t("startFromDatabase")}
            </Button>
            <Button
              disabled={!targetFiles.length}
              onClick={() =>
                setManualFiles(targetFiles.map((file) => ({ ...file })))
              }
              size="sm"
              variant="outline"
            >
              <ArrowDownToLine /> {t("startFromTarget")}
            </Button>
            <Button asChild size="sm" variant="outline">
              <Label className="cursor-pointer" htmlFor="manual-package-upload">
                {t("addFiles")}
              </Label>
            </Button>
            <Input
              className="sr-only"
              id="manual-package-upload"
              multiple
              onChange={(event) =>
                void uploadManualFiles(event.currentTarget.files)
              }
              type="file"
            />
          </div>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-[14rem_minmax(0,1fr)]">
            <div className="space-y-1 rounded-md border p-2">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {t("packageFiles")}
              </p>
              {comparePaths.map((path) => (
                <button
                  className={`block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs ${
                    path === selectedPath
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted"
                  }`}
                  key={path}
                  onClick={() => {
                    setSelectedPath(path);
                    setRenamePath(path);
                  }}
                  type="button"
                >
                  {path}
                </button>
              ))}
            </div>
            <div className="min-w-0 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label>{t("databaseVersion")}</Label>
                  {compareLoading ? (
                    <Spinner />
                  ) : (
                    <FilePreview
                      binaryLabel={t("binaryPreview")}
                      executableLabel={t("executable")}
                      file={databaseFile}
                      missingLabel={t("missingFile")}
                    />
                  )}
                </div>
                <div className="min-w-0 space-y-2">
                  <Label>{t("targetVersion")}</Label>
                  <FilePreview
                    binaryLabel={t("binaryPreview")}
                    executableLabel={t("executable")}
                    file={targetFile}
                    missingLabel={t("missingFile")}
                  />
                </div>
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <Label>{t("resultVersion")}</Label>
                {manualFile ? (
                  <>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-64 flex-1 space-y-1">
                        <Label htmlFor="manual-file-path">
                          {t("filePath")}
                        </Label>
                        <Input
                          id="manual-file-path"
                          onChange={(event) =>
                            setRenamePath(event.target.value)
                          }
                          value={renamePath}
                        />
                      </div>
                      <Button
                        disabled={
                          !renamePath.trim() ||
                          (renamePath.trim() !== manualFile.path &&
                            manualFiles.some(
                              (file) => file.path === renamePath.trim(),
                            ))
                        }
                        onClick={renameManualFile}
                        variant="outline"
                      >
                        {t("rename")}
                      </Button>
                      <Label className="flex h-8 items-center gap-2 rounded-lg border px-3">
                        <Checkbox
                          checked={manualFile.executable}
                          onCheckedChange={(checked) =>
                            setManualFiles((current) =>
                              current.map((file) =>
                                file.path === manualFile.path
                                  ? { ...file, executable: checked === true }
                                  : file,
                              ),
                            )
                          }
                        />
                        {t("executable")}
                      </Label>
                      <Button
                        disabled={manualFile.path === "SKILL.md"}
                        onClick={() => {
                          setManualFiles((current) =>
                            current.filter(
                              (file) => file.path !== manualFile.path,
                            ),
                          );
                          const next = comparePaths.find(
                            (path) => path !== manualFile.path,
                          );
                          setSelectedPath(next ?? "SKILL.md");
                          setRenamePath(next ?? "SKILL.md");
                        }}
                        variant="destructive"
                      >
                        <Trash2 /> {t("removeFile")}
                      </Button>
                    </div>
                    {textContents(manualFile) === null ? (
                      <div className="space-y-2 rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
                        <p>{t("binaryFile")}</p>
                        <p>
                          {bytes(
                            manualFile.contentsBase64,
                          ).byteLength.toLocaleString()}{" "}
                          B
                        </p>
                      </div>
                    ) : (
                      <Textarea
                        className="min-h-48 font-mono text-xs"
                        onChange={(event) =>
                          setManualFiles((current) =>
                            current.map((file) =>
                              file.path === manualFile.path
                                ? {
                                    ...file,
                                    contentsBase64: encode(event.target.value),
                                  }
                                : file,
                            ),
                          )
                        }
                        value={textContents(manualFile) ?? ""}
                      />
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("missingResultFile")}
                  </p>
                )}
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button
              disabled={
                busy ||
                !manualFiles.some((file) => file.path === "SKILL.md") ||
                (manualItem?.candidatePackage?.projectGroupRequired === true &&
                  !groupChoices[manualItem.id])
              }
              onClick={() => void saveManual()}
            >
              {busy && <Spinner />} {t("useManualVersion")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
