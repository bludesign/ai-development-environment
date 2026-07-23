"use client";

import { useState } from "react";
import { File, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { RunAttachmentView } from "./types";

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPicker({
  attachments,
  uploading = false,
  onFiles,
  onRemove,
  compact = false,
}: {
  attachments: RunAttachmentView[];
  uploading?: boolean;
  onFiles: (files: File[]) => void | Promise<void>;
  onRemove: (id: string) => void;
  compact?: boolean;
}) {
  const t = useTranslations("runs");
  const [dragging, setDragging] = useState(false);

  return (
    <div className="space-y-2">
      {attachments.length > 0 && (
        <AttachmentGroup className="flex-wrap overflow-visible">
          {attachments.map((attachment) => (
            <Attachment key={attachment.id} size={compact ? "xs" : "sm"}>
              <AttachmentMedia>
                <File />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={attachment.filename}>
                  {attachment.filename}
                </AttachmentTitle>
                {!compact && (
                  <AttachmentDescription>
                    {fileSize(attachment.size)}
                  </AttachmentDescription>
                )}
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  aria-label={t("removeAttachment", {
                    name: attachment.filename,
                  })}
                  onClick={() => onRemove(attachment.id)}
                  type="button"
                >
                  <Trash2 />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      <label
        className={cn(
          "relative flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground",
          compact ? "min-h-9" : "min-h-20",
          dragging && "border-primary bg-primary/5 text-primary",
          uploading && "pointer-events-none opacity-60",
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void onFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {uploading ? <Spinner /> : <Upload />}
        <span>{t("attachFiles")}</span>
        <span className="hidden text-xs sm:inline">
          · {t("attachmentLimits")}
        </span>
        <input
          className="sr-only"
          disabled={uploading}
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void onFiles(files);
          }}
          type="file"
        />
      </label>
    </div>
  );
}
