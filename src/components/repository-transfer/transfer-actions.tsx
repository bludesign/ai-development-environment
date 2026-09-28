"use client";

import { Download, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { RepositoryTransferDialog } from "./transfer-dialog";

export function RepositoryTransferActions({
  appId,
  repositoryId,
  hasUnsavedChanges = false,
  onImported,
}: {
  appId?: string;
  repositoryId?: string;
  hasUnsavedChanges?: boolean;
  onImported?: () => void | Promise<void>;
}) {
  const t = useTranslations("repositoryTransfer");
  const [direction, setDirection] = useState<"import" | "export" | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={hasUnsavedChanges}
          onClick={() => setDirection("import")}
          variant="outline"
        >
          <Upload /> {t("import")}
        </Button>
        {(appId || repositoryId) && (
          <Button
            disabled={hasUnsavedChanges}
            onClick={() => setDirection("export")}
            variant="outline"
          >
            <Download /> {t("export")}
          </Button>
        )}
      </div>
      {hasUnsavedChanges && (
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("unsavedChanges")}
        </p>
      )}
      {direction && (
        <RepositoryTransferDialog
          appId={appId}
          repositoryId={repositoryId}
          direction={direction}
          onClose={() => setDirection(null)}
          onImported={onImported}
        />
      )}
    </div>
  );
}
