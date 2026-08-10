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
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { CodebaseRepository, RepositoryPreparation } from "./types";

type DraftPreparation = RepositoryPreparation & {
  localId: string;
  contentBase64?: string;
  fileName?: string;
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

async function uploaded(file: File): Promise<{
  contentBase64: string;
  contentSha256: string;
  byteCount: number;
}> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Each uploaded file must be 10 MiB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    contentBase64: bytesToBase64(bytes),
    contentSha256: [...digest]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
    byteCount: bytes.byteLength,
  };
}

function draftFrom(value: RepositoryPreparation): DraftPreparation {
  return { ...value, localId: value.id };
}

function empty(kind: RepositoryPreparation["kind"]): DraftPreparation {
  return {
    id: "",
    localId: crypto.randomUUID(),
    kind,
    path: "",
    contentSha256: null,
    byteCount: null,
    definitionHash: "",
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
    paths.some((path) => !validPath(path)) ||
    new Set(paths).size !== paths.length ||
    drafts.some(
      (preparation) =>
        preparation.kind === "WRITE" &&
        !preparation.id &&
        !preparation.contentBase64,
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
            preparations { id kind path contentSha256 byteCount definitionHash }
          }
        }`,
        {
          input: {
            repositoryId: repository.id,
            preparations: drafts.map((preparation) => ({
              id: preparation.id || null,
              kind: preparation.kind,
              path: preparation.path.trim(),
              ...(preparation.contentBase64
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
            <Label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
              <Upload className="size-4" /> {t("uploadPreparationFiles")}
              <Input
                className="sr-only"
                multiple
                onChange={(event) => void addFiles(event.target.files)}
                type="file"
              />
            </Label>
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
              className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(16rem,1fr)_auto]"
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
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">
                      {size(preparation.byteCount)}
                    </Badge>
                    <span className="max-w-full truncate font-mono">
                      {preparation.contentSha256 ?? t("uploadRequired")}
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
