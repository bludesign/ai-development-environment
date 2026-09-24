"use client";

import { CircleAlert, CircleCheck, FileWarning, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FileDropZone } from "@/components/common/file-drop-zone";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";

import { uploadCrashReport } from "./uploads";

type FileResult = {
  name: string;
  state: "uploading" | "done" | "error";
  message?: string;
  crashIds?: string[];
  duplicate?: boolean;
};

export function CrashUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: () => void;
}) {
  const t = useTranslations("crashes");
  const [results, setResults] = useState<FileResult[]>([]);
  const busy = results.some((result) => result.state === "uploading");

  async function upload(files: File[]) {
    if (!files.length) return;
    const start = results.length;
    setResults((current) => [
      ...current,
      ...files.map((file) => ({
        name: file.name,
        state: "uploading" as const,
      })),
    ]);
    for (const [offset, file] of files.entries()) {
      let next: FileResult;
      try {
        const result = await uploadCrashReport(file);
        next = {
          name: file.name,
          state: "done",
          crashIds: result.crashes.map((crash) => crash.id),
          duplicate: result.duplicate,
        };
      } catch (error) {
        next = {
          name: file.name,
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      setResults((current) =>
        current.map((entry, index) =>
          index === start + offset ? next : entry,
        ),
      );
    }
    onUploaded?.();
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
        if (!next) setResults([]);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("uploadCrashesTitle")}</DialogTitle>
          <DialogDescription>{t("uploadCrashesDescription")}</DialogDescription>
        </DialogHeader>
        <FileDropZone
          accept=".crash,.ips,.json,.txt"
          className="min-h-32 flex-col"
          disabled={busy}
          onFiles={upload}
        >
          {busy ? <Spinner /> : <Upload />}
          <span>{t("dropCrashFiles")}</span>
          <span className="text-xs">{t("crashFileLimits")}</span>
        </FileDropZone>
        {results.length ? (
          <ul className="max-h-64 space-y-2 overflow-auto text-sm">
            {results.map((result, index) => (
              <li
                className="flex items-start gap-2"
                key={`${result.name}-${index}`}
              >
                {result.state === "uploading" ? (
                  <Spinner className="mt-0.5" />
                ) : result.state === "done" ? (
                  <CircleCheck className="mt-0.5 size-4 text-emerald-600" />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{result.name}</p>
                  {result.state === "error" ? (
                    <p className="text-destructive">{result.message}</p>
                  ) : null}
                  {result.state === "done" ? (
                    <p className="text-muted-foreground">
                      {result.duplicate
                        ? t("alreadyUploaded")
                        : t("crashesCreated", {
                            count: result.crashIds?.length ?? 0,
                          })}{" "}
                      {result.crashIds?.map((id, position) => (
                        <Link
                          className="mr-2 underline"
                          href={`/crashes/${encodeURIComponent(id)}`}
                          key={id}
                          onClick={() => onOpenChange(false)}
                        >
                          {t("viewCrashNumber", { number: position + 1 })}
                        </Link>
                      ))}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <FileWarning className="size-4" />
            {t("crashFormatsHint")}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
              setResults([]);
            }}
            variant="outline"
          >
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
