"use client";

import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyText } from "@/lib/browser-utils";

import type { WorktreeDetail } from "./types";

export type WorktreeChangeCopyTarget = {
  file?: { folder: string; path: string };
  commit?: WorktreeDetail["commits"][number];
};

export function WorktreeChangeContextMenu({
  children,
  file,
  commit,
}: WorktreeChangeCopyTarget & { children: ReactNode }) {
  const t = useTranslations("worktrees");
  const [open, setOpen] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = (value: string) => {
    setCopyFailed(false);
    void copyText(value)
      .then(() => setOpen(false))
      .catch(() => setCopyFailed(true));
  };
  const separator = file?.folder.includes("\\") ? "\\" : "/";
  const filePath = file
    ? `${file.folder.replace(/[\\/]+$/, "")}${separator}${file.path.replaceAll("/", separator)}`
    : "";

  return (
    <ContextMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setCopyFailed(false);
      }}
      open={open}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-64"
        data-worktree-navigation-ignore="true"
        onClick={(event) => event.stopPropagation()}
      >
        {file && (
          <>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                copy(filePath);
              }}
            >
              <Copy /> {t("copyFilePath")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                copy(file.path);
              }}
            >
              <Copy /> {t("copyRelativeFilePath")}
            </ContextMenuItem>
          </>
        )}
        {file && commit && <ContextMenuSeparator />}
        {commit && (
          <>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                copy(commit.sha.slice(0, 8));
              }}
            >
              <Copy /> {t("copyShortCommitHash")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                copy(commit.sha);
              }}
            >
              <Copy /> {t("copyFullCommitHash")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                copy(commit.message ?? commit.subject);
              }}
            >
              <Copy /> {t("copyCommitMessage")}
            </ContextMenuItem>
          </>
        )}
        {copyFailed && (
          <p className="px-2 py-1 text-xs text-destructive" role="alert">
            {t("copyChangeFailed")}
          </p>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
