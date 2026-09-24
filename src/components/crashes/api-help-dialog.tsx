"use client";

import { Clipboard } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/browser-utils";

import { crashApiDocumentation } from "./api-docs";

export function CrashApiHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("crashes");
  const [copied, setCopied] = useState(false);
  const documentation = crashApiDocumentation(
    typeof window === "undefined" ? "" : window.location.origin,
  );
  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setCopied(false);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("apiHelpTitle")}</DialogTitle>
          <DialogDescription>{t("apiHelpDescription")}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[65vh] overflow-auto rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed whitespace-pre-wrap">
          <code>{documentation}</code>
        </pre>
        <DialogFooter>
          <Button
            onClick={() => {
              void copyText(documentation);
              setCopied(true);
            }}
          >
            <Clipboard />
            {copied ? t("docsCopied") : t("copyDocs")}
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
