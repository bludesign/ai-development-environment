"use client";

import { CircleAlert, CircleCheck, Upload } from "lucide-react";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";

import {
  collectDroppedFiles,
  dsymZipEntries,
  uploadDsymZip,
  zipDsymBundles,
  type DroppedFile,
  type DsymUploadResult,
} from "./uploads";

type Phase =
  | { kind: "idle" }
  | { kind: "zipping"; progress: number }
  | { kind: "uploading"; progress: number; name: string }
  | { kind: "done"; results: DsymUploadResult[] }
  | { kind: "error"; message: string };

function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full bg-primary transition-[width]"
        style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }}
      />
    </div>
  );
}

export function DsymUploadDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: () => void;
}) {
  const t = useTranslations("crashes");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [projectName, setProjectName] = useState("");
  const [buildId, setBuildId] = useState("");
  const [url, setUrl] = useState("");
  const busy = phase.kind === "zipping" || phase.kind === "uploading";

  async function upload(files: DroppedFile[]) {
    if (!files.length) return;
    const metadata = { projectName, buildId, url };
    try {
      const zips = files.filter(({ file }) =>
        file.name.toLowerCase().endsWith(".zip"),
      );
      const results: DsymUploadResult[] = [];
      if (zips.length === files.length) {
        for (const { file } of zips) {
          setPhase({ kind: "uploading", progress: 0, name: file.name });
          results.push(
            await uploadDsymZip(file, file.name, metadata, {
              onProgress: (progress) =>
                setPhase({ kind: "uploading", progress, name: file.name }),
            }),
          );
        }
      } else {
        const entries = dsymZipEntries(files);
        if (!entries.length) throw new Error(t("noDsymsDropped"));
        setPhase({ kind: "zipping", progress: 0 });
        const blob = await zipDsymBundles(entries, (progress) =>
          setPhase({ kind: "zipping", progress }),
        );
        const name = `${entries[0]!.name.split("/")[0]!.replace(/\.dSYM$/, "")}-dSYMs.zip`;
        setPhase({ kind: "uploading", progress: 0, name });
        results.push(
          await uploadDsymZip(blob, name, metadata, {
            onProgress: (progress) =>
              setPhase({ kind: "uploading", progress, name }),
          }),
        );
      }
      setPhase({ kind: "done", results });
      onUploaded?.();
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function close() {
    onOpenChange(false);
    setPhase({ kind: "idle" });
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (busy) return;
        if (next) onOpenChange(true);
        else close();
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("uploadDsymsTitle")}</DialogTitle>
          <DialogDescription>{t("uploadDsymsDescription")}</DialogDescription>
        </DialogHeader>
        <FieldGroup className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="dsym-project">{t("projectName")}</FieldLabel>
            <Input
              disabled={busy}
              id="dsym-project"
              onChange={(event) => setProjectName(event.target.value)}
              placeholder={t("optional")}
              value={projectName}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dsym-build">{t("buildId")}</FieldLabel>
            <Input
              disabled={busy}
              id="dsym-build"
              onChange={(event) => setBuildId(event.target.value)}
              placeholder={t("optional")}
              value={buildId}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="dsym-url">{t("url")}</FieldLabel>
            <Input
              disabled={busy}
              id="dsym-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              type="url"
              value={url}
            />
          </Field>
        </FieldGroup>
        <FileDropZone
          accept=".zip"
          className="min-h-32 flex-col text-center"
          disabled={busy}
          onDropTransfer={async (transfer) =>
            upload(await collectDroppedFiles(transfer))
          }
          onFiles={(files) =>
            upload(files.map((file) => ({ file, path: file.name })))
          }
        >
          {busy ? <Spinner /> : <Upload />}
          <span>{t("dropDsyms")}</span>
          <span className="text-xs">{t("dsymDropHint")}</span>
        </FileDropZone>
        {phase.kind === "zipping" || phase.kind === "uploading" ? (
          <div className="space-y-1.5 text-sm">
            <p className="text-muted-foreground">
              {phase.kind === "zipping"
                ? t("zippingDsyms")
                : t("uploadingFile", { name: phase.name })}
            </p>
            <Progress value={phase.progress} />
          </div>
        ) : null}
        {phase.kind === "error" ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {phase.message}
          </p>
        ) : null}
        {phase.kind === "done" ? (
          <ul className="max-h-64 space-y-3 overflow-auto text-sm">
            {phase.results.flatMap((result) =>
              result.dsyms.map((dsym) => (
                <li className="flex items-start gap-2" key={dsym.id}>
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <Link
                      className="font-medium underline"
                      href={`/crashes/dsyms/${encodeURIComponent(dsym.id)}`}
                      onClick={close}
                    >
                      {dsym.bundleName}
                    </Link>
                    {result.duplicate ? (
                      <span className="ml-2 text-muted-foreground">
                        {t("alreadyUploaded")}
                      </span>
                    ) : null}
                    {dsym.slices.map((slice) => (
                      <p
                        className="font-mono text-xs text-muted-foreground"
                        key={slice.uuid}
                      >
                        {slice.uuid} ({slice.arch})
                      </p>
                    ))}
                  </div>
                </li>
              )),
            )}
          </ul>
        ) : null}
        <DialogFooter>
          <Button disabled={busy} onClick={close} variant="outline">
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
