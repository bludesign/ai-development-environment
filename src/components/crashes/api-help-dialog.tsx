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

import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import {
  EndpointUrls,
  ServerUrlPicker,
} from "@/components/server-urls/server-url-controls";
import { serverUrlOptions, type ServerUrlKind } from "@/lib/server-urls";
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
  const { settings: serverUrls } = useServerUrlSettings();
  const [selectedKind, setSelectedKind] = useState<ServerUrlKind | null>(null);
  const documentation = serverUrls
    ? crashApiDocumentation(
        serverUrlOptions(serverUrls).find(
          (option) =>
            option.kind === (selectedKind ?? serverUrls.defaultServerUrlKind),
        )?.url ?? "",
      )
    : "";
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
        <ServerUrlPicker value={selectedKind} onValueChange={setSelectedKind} />
        <EndpointUrls path="/api/public/crashes" />
        <EndpointUrls path="/api/dsyms" />
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
