"use client";

import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

import { useMergeOperation } from "./merge-operation-state";

export function MergeOperationError({
  operationKey,
  onOpen,
}: {
  operationKey: string;
  onOpen: () => void;
}) {
  const t = useTranslations("pullRequests");
  const { error } = useMergeOperation(operationKey);
  if (!error) return null;
  return (
    <Button
      aria-label={t("mergeNeedsAttention")}
      className="text-destructive"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      size="icon-sm"
      title={error}
      variant="ghost"
    >
      <CircleAlert />
    </Button>
  );
}
