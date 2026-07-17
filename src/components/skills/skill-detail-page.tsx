"use client";

import {
  ArrowLeft,
  Download,
  FilePlus2,
  PencilLine,
  Save,
  Trash2,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { SkillFile, SkillGroupSummary, SkillSummary } from "./types";
import { SKILL_FIELDS } from "./types";

type EditableFile = Pick<SkillFile, "path" | "contentsBase64" | "executable">;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function textContents(file: EditableFile): string | null {
  const bytes = base64ToBytes(file.contentsBase64);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeText(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\nAdd skill instructions here.\n`;
}

function replaceMetadata(
  contents: string,
  name: string,
  description: string,
): string {
  const normalized = contents.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return skillMarkdown(name, description);
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return skillMarkdown(name, description);
  const frontmatter = normalized.slice(4, end).split("\n");
  const next: string[] = [];
  let foundName = false;
  let foundDescription = false;
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index] ?? "";
    if (/^name:/.test(line)) {
      next.push(`name: ${name}`);
      foundName = true;
      continue;
    }
    if (/^description:/.test(line)) {
      next.push(`description: ${JSON.stringify(description)}`);
      foundDescription = true;
      if (/^description:\s*[|>]/.test(line)) {
        while (
          index + 1 < frontmatter.length &&
          /^\s/.test(frontmatter[index + 1] ?? "")
        ) {
          index += 1;
        }
      }
      continue;
    }
    next.push(line);
  }
  if (!foundName) next.unshift(`name: ${name}`);
  if (!foundDescription)
    next.push(`description: ${JSON.stringify(description)}`);
  return `---\n${next.join("\n")}\n---${normalized.slice(end + 4)}`;
}

export function SkillDetailPage({ skillId }: { skillId: string }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const creating = skillId === "new";
  const [name, setName] = useState(creating ? "new-skill" : "");
  const [description, setDescription] = useState(
    creating ? "Describe when this skill should be used." : "",
  );
  const [syncGlobally, setSyncGlobally] = useState(true);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<SkillGroupSummary[]>([]);
  const [files, setFiles] = useState<EditableFile[]>(() =>
    creating
      ? [
          {
            path: "SKILL.md",
            contentsBase64: encodeText(
              skillMarkdown(
                "new-skill",
                "Describe when this skill should be used.",
              ),
            ),
            executable: false,
          },
        ]
      : [],
  );
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [renamePath, setRenamePath] = useState("SKILL.md");
  const [loading, setLoading] = useState(!creating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (creating) return;
    try {
      const data = await controlPlaneRequest<{
        skill: SkillSummary | null;
        skillsOverview: { groups: SkillGroupSummary[] };
      }>(
        `query SkillDetail($id: ID!) {
          skill(id: $id) { ${SKILL_FIELDS} }
          skillsOverview { groups { id name } }
        }`,
        { id: skillId },
      );
      if (!data.skill) throw new Error(t("skillNotFound"));
      setName(data.skill.name);
      setDescription(data.skill.description);
      setSyncGlobally(data.skill.syncGlobally);
      setGroupIds(data.skill.groups.map((group) => group.id));
      setFiles(data.skill.files);
      setGroups(data.skillsOverview.groups);
      setSelectedPath("SKILL.md");
      setRenamePath("SKILL.md");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [creating, skillId, t]);

  useEffect(() => {
    if (creating) {
      void controlPlaneRequest<{
        skillsOverview: { groups: SkillGroupSummary[] };
      }>(`query SkillGroups { skillsOverview { groups { id name } } }`).then(
        (data) => setGroups(data.skillsOverview.groups),
      );
      return;
    }
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [creating, load]);

  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const selectedText = useMemo(
    () => (selected ? textContents(selected) : null),
    [selected],
  );

  const updateMetadata = (nextName: string, nextDescription: string) => {
    setFiles((current) =>
      current.map((file) => {
        if (file.path !== "SKILL.md") return file;
        const text =
          textContents(file) ?? skillMarkdown(nextName, nextDescription);
        return {
          ...file,
          contentsBase64: encodeText(
            replaceMetadata(text, nextName, nextDescription),
          ),
        };
      }),
    );
  };

  const save = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{ saveSkill: SkillSummary }>(
        `mutation SaveSkill($input: SaveSkillInput!) {
          saveSkill(input: $input) { id name }
        }`,
        {
          input: {
            id: creating ? null : skillId,
            name,
            description,
            syncGlobally,
            groupIds,
            files: files.map(({ path, contentsBase64, executable }) => ({
              path,
              contentsBase64,
              executable,
            })),
          },
        },
      );
      router.replace(`/skills/${data.saveSkill.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const deleteSkill = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation DeleteSkill($id: ID!) { deleteSkill(id: $id) }`,
        { id: skillId },
      );
      router.push("/skills");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setBusy(false);
    }
  };

  const uploadFiles = async (list: FileList | null) => {
    if (!list) return;
    const additions = await Promise.all(
      [...list].map(async (file) => ({
        path: file.name,
        contentsBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        executable: false,
      })),
    );
    setFiles((current) => [
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

  const renameSelected = () => {
    const path = renamePath.trim().replaceAll("\\", "/");
    if (!selected || selected.path === "SKILL.md" || !path) return;
    if (files.some((file) => file.path === path)) {
      setError(t("duplicateFile"));
      return;
    }
    setFiles((current) =>
      current.map((file) =>
        file.path === selected.path ? { ...file, path } : file,
      ),
    );
    setSelectedPath(path);
  };

  const downloadSelected = () => {
    if (!selected) return;
    const bytes = base64ToBytes(selected.contentsBase64);
    const contents = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([contents]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selected.path.split("/").at(-1) ?? selected.path;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> {t("loadingSkill")}
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
            <h1 className="text-2xl font-semibold">
              {creating ? t("newSkill") : name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("editorDescription")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {!creating && (
            <ConfirmationDialog
              actionLabel={t("delete")}
              cancelLabel={t("cancel")}
              description={t("deleteSkillDescription", { name })}
              onConfirm={deleteSkill}
              title={t("deleteSkill")}
              trigger={
                <Button disabled={busy} variant="ghost">
                  <Trash2 /> {t("delete")}
                </Button>
              }
            />
          )}
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : <Save />} {t("saveSkill")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="grid gap-4 pt-1 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="skill-name">{t("name")}</Label>
            <Input
              id="skill-name"
              maxLength={64}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                updateMetadata(next, description);
              }}
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-description">{t("skillDescription")}</Label>
            <Input
              id="skill-description"
              maxLength={1024}
              onChange={(event) => {
                const next = event.target.value;
                setDescription(next);
                updateMetadata(name, next);
              }}
              value={description}
            />
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-3 md:col-span-2">
            <Checkbox
              checked={syncGlobally}
              id="skill-global"
              onCheckedChange={(checked) => setSyncGlobally(checked === true)}
            />
            <div>
              <Label htmlFor="skill-global">{t("syncGlobally")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("syncGloballyHelp")}
              </p>
            </div>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>{t("groups")}</Label>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <label
                  className="flex items-center gap-2 rounded-md border px-3 py-2"
                  key={group.id}
                >
                  <Checkbox
                    checked={groupIds.includes(group.id)}
                    onCheckedChange={(checked) =>
                      setGroupIds((current) =>
                        checked === true
                          ? [...new Set([...current, group.id])]
                          : current.filter((id) => id !== group.id),
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
              {!groups.length && (
                <span className="text-sm text-muted-foreground">
                  {t("noGroups")}
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid min-h-[32rem] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("packageFiles")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              aria-label={t("addFiles")}
              multiple
              onChange={(event) => void uploadFiles(event.target.files)}
              type="file"
            />
            <div className="space-y-1">
              {[...files]
                .sort((first, second) => first.path.localeCompare(second.path))
                .map((file) => (
                  <button
                    className={`block w-full rounded-md px-2 py-1.5 text-left font-mono text-xs ${
                      selectedPath === file.path
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                    key={file.path}
                    onClick={() => {
                      setSelectedPath(file.path);
                      setRenamePath(file.path);
                    }}
                    type="button"
                  >
                    {file.path}
                  </button>
                ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2">
              <span>{selected?.path ?? t("selectFile")}</span>
              {selected && (
                <div className="flex gap-2">
                  <Button
                    onClick={downloadSelected}
                    size="sm"
                    variant="outline"
                  >
                    <Download /> {t("download")}
                  </Button>
                  {selected.path !== "SKILL.md" && (
                    <Button
                      onClick={() => {
                        setFiles((current) =>
                          current.filter((file) => file.path !== selected.path),
                        );
                        setSelectedPath("SKILL.md");
                        setRenamePath("SKILL.md");
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <Trash2 /> {t("removeFile")}
                    </Button>
                  )}
                </div>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected && selected.path !== "SKILL.md" && (
              <div className="flex gap-2">
                <Input
                  onChange={(event) => setRenamePath(event.target.value)}
                  value={renamePath}
                />
                <Button onClick={renameSelected} variant="outline">
                  <PencilLine /> {t("rename")}
                </Button>
              </div>
            )}
            {selected && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.executable}
                  onCheckedChange={(checked) =>
                    setFiles((current) =>
                      current.map((file) =>
                        file.path === selected.path
                          ? { ...file, executable: checked === true }
                          : file,
                      ),
                    )
                  }
                />
                {t("executable")}
              </label>
            )}
            {selected && selectedText !== null ? (
              <Textarea
                className="min-h-[28rem] font-mono text-xs"
                onChange={(event) => {
                  const contentsBase64 = encodeText(event.target.value);
                  setFiles((current) =>
                    current.map((file) =>
                      file.path === selected.path
                        ? { ...file, contentsBase64 }
                        : file,
                    ),
                  );
                }}
                spellCheck={false}
                value={selectedText}
              />
            ) : selected ? (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                <FilePlus2 className="mx-auto mb-2" />
                {t("binaryFile")}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
