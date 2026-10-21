"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function WorktreeErrorAlert({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  const t = useTranslations("worktrees");
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
      {onDismiss && (
        <AlertAction>
          <Button
            aria-label={t("dismissError")}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost"
          >
            <X />
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
