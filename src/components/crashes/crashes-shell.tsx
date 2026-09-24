"use client";

import { Bug, CodeXml, FileArchive, Settings, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";

import { CrashApiHelpDialog } from "./api-help-dialog";
import { CrashSettingsDialog } from "./crash-settings-dialog";
import { CrashUploadDialog } from "./crash-upload-dialog";
import { DsymUploadDialog } from "./dsym-upload-dialog";

/**
 * Header shared by the Crashes and dSYMs tables: the two tabs and the upload,
 * API, and settings actions.
 */
export function CrashesShell({
  children,
  onChanged,
}: {
  children: ReactNode;
  onChanged?: () => void;
}) {
  const t = useTranslations("crashes");
  const pathname = usePathname();
  const [dialog, setDialog] = useState<
    "crashes" | "dsyms" | "settings" | "api" | null
  >(null);
  const onDsyms = pathname.startsWith("/crashes/dsyms");
  const tabs = [
    { href: "/crashes", label: t("crashesTab"), icon: Bug, active: !onDsyms },
    {
      href: "/crashes/dsyms",
      label: t("dsymsTab"),
      icon: FileArchive,
      active: onDsyms,
    },
  ];
  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
      <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row lg:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog("crashes")} variant="outline">
            <Upload /> {t("uploadCrashes")}
          </Button>
          <Button onClick={() => setDialog("dsyms")} variant="outline">
            <FileArchive /> {t("uploadDsyms")}
          </Button>
          <Button
            aria-label={t("apiHelpTitle")}
            onClick={() => setDialog("api")}
            size="icon"
            title={t("apiHelpTitle")}
            variant="ghost"
          >
            <CodeXml />
          </Button>
          <Button
            aria-label={t("settingsTitle")}
            onClick={() => setDialog("settings")}
            size="icon"
            title={t("settingsTitle")}
            variant="ghost"
          >
            <Settings />
          </Button>
        </div>
      </div>
      <nav
        aria-label={t("sections")}
        className="flex flex-wrap gap-2 border-b pb-3"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              asChild
              key={tab.href}
              size="sm"
              variant={tab.active ? "secondary" : "ghost"}
            >
              <Link
                aria-current={tab.active ? "page" : undefined}
                href={tab.href}
              >
                <Icon /> {tab.label}
              </Link>
            </Button>
          );
        })}
      </nav>
      {children}
      <CrashUploadDialog
        onOpenChange={(open) => setDialog(open ? "crashes" : null)}
        onUploaded={onChanged}
        open={dialog === "crashes"}
      />
      <DsymUploadDialog
        onOpenChange={(open) => setDialog(open ? "dsyms" : null)}
        onUploaded={onChanged}
        open={dialog === "dsyms"}
      />
      <CrashSettingsDialog
        onOpenChange={(open) => setDialog(open ? "settings" : null)}
        open={dialog === "settings"}
      />
      <CrashApiHelpDialog
        onOpenChange={(open) => setDialog(open ? "api" : null)}
        open={dialog === "api"}
      />
    </section>
  );
}
