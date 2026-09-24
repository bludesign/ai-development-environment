"use client";

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
import { FileDropZone } from "@/components/common/file-drop-zone";
import { Spinner } from "@/components/ui/spinner";

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
      <FileDropZone compact={compact} disabled={uploading} onFiles={onFiles}>
        {uploading ? <Spinner /> : <Upload />}
        <span>{t("attachFiles")}</span>
        <span className="hidden text-xs sm:inline">
          · {t("attachmentLimits")}
        </span>
      </FileDropZone>
    </div>
  );
}
