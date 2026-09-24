"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

import type { CrashReportStatus, DsymUploadStatus } from "./types";

const CRASH_VARIANTS: Record<
  CrashReportStatus,
  "success" | "secondary" | "destructive" | "outline"
> = {
  PENDING: "secondary",
  WAITING_FOR_AGENT: "outline",
  SYMBOLICATING: "secondary",
  SYMBOLICATED: "success",
  PARTIALLY_SYMBOLICATED: "outline",
  MISSING_DSYMS: "outline",
  FAILED: "destructive",
};

export function CrashStatusBadge({
  status,
  title,
}: {
  status: CrashReportStatus;
  title?: string | null;
}) {
  const t = useTranslations("crashes");
  return (
    <Badge title={title ?? undefined} variant={CRASH_VARIANTS[status]}>
      {status === "SYMBOLICATING" ? <Spinner className="size-3" /> : null}
      {t(`statuses.${status}`)}
    </Badge>
  );
}

const UPLOAD_VARIANTS: Record<
  DsymUploadStatus,
  "success" | "secondary" | "destructive" | "outline"
> = {
  UPLOADING: "secondary",
  PENDING_TRANSFER: "outline",
  PROCESSING: "secondary",
  READY: "success",
  FAILED: "destructive",
};

export function DsymUploadStatusBadge({
  status,
}: {
  status: DsymUploadStatus;
}) {
  const t = useTranslations("crashes");
  return (
    <Badge variant={UPLOAD_VARIANTS[status]}>
      {status === "PROCESSING" || status === "UPLOADING" ? (
        <Spinner className="size-3" />
      ) : null}
      {t(`uploadStatuses.${status}`)}
    </Badge>
  );
}
