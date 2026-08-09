"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { CustomCliHealthCheck } from "./types";

export function CliHealthSettingsDialog({
  checks,
  open,
  onOpenChange,
  onSave,
}: {
  checks: CustomCliHealthCheck[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (checks: CustomCliHealthCheck[]) => Promise<void>;
}) {
  const t = useTranslations("systemStatus");
  const [drafts, setDrafts] = useState(checks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, patch: Partial<CustomCliHealthCheck>) =>
    setDrafts((current) =>
      current.map((check, item) =>
        item === index ? { ...check, ...patch } : check,
      ),
    );
  const save = async () => {
    setSaving(true);
    try {
      await onSave(drafts);
      setError(null);
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      onOpenChange={(value) => !saving && onOpenChange(value)}
      open={open}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        <Alert>
          <AlertDescription>{t("shellWarning")}</AlertDescription>
        </Alert>
        <div className="space-y-4">
          {drafts.map((check, index) => (
            <div
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_2fr_auto]"
              key={check.id || `new-${index}`}
            >
              <div className="space-y-2">
                <Label htmlFor={`check-name-${index}`}>{t("checkName")}</Label>
                <Input
                  id={`check-name-${index}`}
                  maxLength={100}
                  onChange={(event) =>
                    update(index, { name: event.target.value })
                  }
                  value={check.name}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`check-command-${index}`}>{t("command")}</Label>
                <Input
                  className="font-mono"
                  id={`check-command-${index}`}
                  maxLength={4096}
                  onChange={(event) =>
                    update(index, { command: event.target.value })
                  }
                  value={check.command}
                />
              </div>
              <div className="flex items-end gap-3 pb-2">
                <Label className="flex items-center gap-2">
                  <Checkbox
                    checked={check.enabled}
                    onCheckedChange={(value) =>
                      update(index, { enabled: value === true })
                    }
                  />
                  {t("enabled")}
                </Label>
                <Button
                  aria-label={t("deleteCheck", {
                    name: check.name || t("newCheck"),
                  })}
                  onClick={() =>
                    setDrafts((current) =>
                      current.filter((_, item) => item !== index),
                    )
                  }
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
          {drafts.length < 20 && (
            <Button
              onClick={() =>
                setDrafts((current) => [
                  ...current,
                  { id: "", name: "", command: "", enabled: true },
                ])
              }
              type="button"
              variant="outline"
            >
              <Plus />
              {t("addCheck")}
            </Button>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            disabled={
              saving ||
              drafts.some(
                (check) => !check.name.trim() || !check.command.trim(),
              )
            }
            onClick={() => void save()}
          >
            {saving && <Spinner />}
            {t("saveSettings")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
