"use client";

import { FilePlus2, Plus, Save, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { ChangeEvent, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { CodebaseRepository, RepositoryPreparation } from "./types";

type DraftPreparation = RepositoryPreparation & {
  localId: string;
  fileName?: string;
  textContent: string | null;
  contentChanged: boolean;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function textFromBase64(value: string | null): string | null {
  if (value === null) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      base64ToBytes(value),
    );
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

async function contentDetails(bytes: Uint8Array): Promise<{
  contentBase64: string;
  contentSha256: string;
  byteCount: number;
}> {
  const digestBytes = Uint8Array.from(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestBytes.buffer),
  );
  return {
    contentBase64: bytesToBase64(bytes),
    contentSha256: [...digest]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
    byteCount: bytes.byteLength,
  };
}

async function uploaded(file: File): Promise<{
  contentBase64: string;
  contentSha256: string;
  byteCount: number;
  textContent: string | null;
  contentChanged: boolean;
}> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Each uploaded file must be 10 MiB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    ...(await contentDetails(bytes)),
    textContent: textFromBase64(bytesToBase64(bytes)),
    contentChanged: true,
  };
}

function draftFrom(value: RepositoryPreparation): DraftPreparation {
  return {
    ...value,
    localId: value.id,
    textContent:
      value.kind === "WRITE" ? textFromBase64(value.contentBase64) : null,
    contentChanged: false,
  };
}

function empty(kind: RepositoryPreparation["kind"]): DraftPreparation {
  return {
    id: "",
    localId: crypto.randomUUID(),
    kind,
    path: "",
    contentSha256:
      kind === "WRITE"
        ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        : null,
    byteCount: kind === "WRITE" ? 0 : null,
    contentBase64: kind === "WRITE" ? "" : null,
    definitionHash: "",
    textContent: kind === "WRITE" ? "" : null,
    contentChanged: kind === "WRITE",
  };
}

function validPath(path: string): boolean {
  const parts = path.split("/");
  return Boolean(
    path &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:\//.test(path) &&
    !/[\\\0\r\n*?[\]]/.test(path) &&
    parts.every((part) => part && part !== "." && part !== "..") &&
    parts.every((part) => part.toLowerCase() !== ".git"),
  );
}

function size(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function RepositoryPreparations({
  repository,
  onSaved,
}: {
  repository: CodebaseRepository;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations("codebases");
  const [drafts, setDrafts] = useState<DraftPreparation[]>(() =>
    (repository.preparations ?? []).map(draftFrom),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const totalBytes = useMemo(
    () =>
      drafts.reduce(
        (total, preparation) => total + (preparation.byteCount ?? 0),
        0,
      ),
    [drafts],
  );
  const paths = drafts.map((preparation) => preparation.path.trim());
  const invalid =
    drafts.length > 500 ||
    totalBytes > MAX_TOTAL_BYTES ||
    drafts.some((preparation) =>
      preparation.byteCount === null
        ? false
        : preparation.byteCount > MAX_FILE_BYTES,
    ) ||
    paths.some((path) => !validPath(path)) ||
    new Set(paths).size !== paths.length ||
    drafts.some(
      (preparation) =>
        preparation.kind === "WRITE" &&
        !preparation.id &&
        preparation.contentBase64 === null,
    );

  const update = (localId: string, value: Partial<DraftPreparation>) =>
    setDrafts((current) =>
      current.map((item) =>
        item.localId === localId ? { ...item, ...value } : item,
      ),
    );

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    try {
      const additions: DraftPreparation[] = [];
      for (const file of [...files]) {
        additions.push({
          ...empty("WRITE"),
          path: file.name,
          fileName: file.name,
          ...(await uploaded(file)),
        });
      }
      setDrafts((current) => [...current, ...additions]);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const addTextFile = () =>
    setDrafts((current) => [...current, empty("WRITE")]);

  const updateText = (localId: string, textContent: string) => {
    const bytes = new TextEncoder().encode(textContent);
    const contentBase64 = bytesToBase64(bytes);
    update(localId, {
      textContent,
      contentBase64,
      contentSha256: null,
      byteCount: bytes.byteLength,
      contentChanged: true,
    });
    void contentDetails(bytes).then(({ contentSha256 }) => {
      setDrafts((current) =>
        current.map((item) =>
          item.localId === localId && item.contentBase64 === contentBase64
            ? { ...item, contentSha256 }
            : item,
        ),
      );
    });
  };

  const replaceFile = async (
    localId: string,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      update(localId, { fileName: file.name, ...(await uploaded(file)) });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      event.target.value = "";
    }
  };

  const save = async () => {
    if (invalid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await controlPlaneRequest<{
        saveCodebaseRepositoryPreparations: {
          preparations: RepositoryPreparation[];
        };
      }>(
        `mutation SaveRepositoryPreparations($input: SaveCodebaseRepositoryPreparationsInput!) {
          saveCodebaseRepositoryPreparations(input: $input) {
            preparations { id kind path contentSha256 byteCount contentBase64 definitionHash }
          }
        }`,
        {
          input: {
            repositoryId: repository.id,
            preparations: drafts.map((preparation) => ({
              id: preparation.id || null,
              kind: preparation.kind,
              path: preparation.path.trim(),
              ...((!preparation.id || preparation.contentChanged) &&
              preparation.contentBase64 !== null
                ? { contentBase64: preparation.contentBase64 }
                : {}),
            })),
          },
        },
      );
      setDrafts(
        result.saveCodebaseRepositoryPreparations.preparations.map(draftFrom),
      );
      await onSaved();
      setNotice(t("preparationsSaved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const section = (
    kind: RepositoryPreparation["kind"],
    title: string,
    description: string,
  ) => {
    const items = drafts.filter((preparation) => preparation.kind === kind);
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {kind === "WRITE" ? (
            <div className="flex flex-wrap gap-2">
              <Label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
                <Upload className="size-4" /> {t("uploadPreparationFiles")}
                <Input
                  className="sr-only"
                  multiple
                  onChange={(event) => void addFiles(event.target.files)}
                  type="file"
                />
              </Label>
              <Button onClick={addTextFile} type="button" variant="outline">
                <FilePlus2 /> {t("newTextPreparation")}
              </Button>
            </div>
          ) : (
            <Button
              onClick={() => setDrafts((current) => [...current, empty(kind)])}
              type="button"
              variant="outline"
            >
              <Plus /> {t("addPreparationPath")}
            </Button>
          )}
          {items.map((preparation) => (
            <div
              className="grid min-w-0 gap-3 rounded-lg border p-3 md:grid-cols-[minmax(16rem,1fr)_auto]"
              key={preparation.localId}
            >
              <div className="space-y-2">
                <Label htmlFor={`preparation-${preparation.localId}`}>
                  {t("destinationPath")}
                </Label>
                <Input
                  aria-invalid={!validPath(preparation.path)}
                  id={`preparation-${preparation.localId}`}
                  onChange={(event) =>
                    update(preparation.localId, { path: event.target.value })
                  }
                  placeholder="config/local.json"
                  value={preparation.path}
                />
                {kind === "WRITE" ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">
                        {size(preparation.byteCount)}
                      </Badge>
                      <span className="max-w-full truncate font-mono">
                        {preparation.contentSha256 ?? t("calculatingHash")}
                      </span>
                      <Label className="inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 hover:bg-muted">
                        <FilePlus2 className="size-3.5" /> {t("replaceFile")}
                        <Input
                          className="sr-only"
                          onChange={(event) =>
                            void replaceFile(preparation.localId, event)
                          }
                          type="file"
                        />
                      </Label>
                    </div>
                    <div className="space-y-2">
                      <Label
                        htmlFor={`preparation-content-${preparation.localId}`}
                      >
                        {t("fileContents")}
                      </Label>
                      {preparation.textContent !== null ? (
                        <Textarea
                          className="min-h-64 resize-y font-mono text-xs"
                          id={`preparation-content-${preparation.localId}`}
                          onChange={(event) =>
                            updateText(preparation.localId, event.target.value)
                          }
                          spellCheck={false}
                          value={preparation.textContent}
                        />
                      ) : (
                        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                          <FilePlus2 className="mx-auto mb-2" />
                          {t("binaryPreparation")}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <Button
                aria-label={t("removePreparation", { path: preparation.path })}
                onClick={() =>
                  setDrafts((current) =>
                    current.filter(
                      (item) => item.localId !== preparation.localId,
                    ),
                  )
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {!items.length ? (
            <p className="text-sm text-muted-foreground">
              {t("noPreparationPaths")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-5">
      <Alert variant="destructive">
        <AlertDescription>{t("preparationsWarning")}</AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {section("WRITE", t("writeFiles"), t("writeFilesDescription"))}
      {section("DELETE", t("deleteFiles"), t("deleteFilesDescription"))}
      {section(
        "ASSUME_UNCHANGED",
        t("assumeUnchanged"),
        t("assumeUnchangedDescription"),
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t("preparationLimits", {
            count: drafts.length,
            size: size(totalBytes),
          })}
        </p>
        <ConfirmationDialog
          actionLabel={t("savePreparations")}
          cancelLabel={t("cancel")}
          description={t("confirmPreparationsDescription")}
          onConfirm={save}
          title={t("confirmPreparationsTitle")}
          trigger={
            <Button disabled={busy || invalid} variant="destructive">
              {busy ? <Spinner /> : <Save />} {t("savePreparations")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
