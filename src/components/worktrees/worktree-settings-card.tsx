"use client";

import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type Settings = {
  autoAssignHighlightColor: boolean;
  highlightColorMode: "SPREAD" | "RANDOM";
};
const FIELDS = "autoAssignHighlightColor highlightColorMode";
export function WorktreeSettingsCard() {
  const t = useTranslations("worktreeSettings");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void controlPlaneRequest<{ worktreeSettings: Settings }>(
      `query WorktreeColorSettings { worktreeSettings { ${FIELDS} } }`,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setSettings(data.worktreeSettings);
      })
      .catch((value: unknown) => {
        if (!controller.signal.aborted) setError(String(value));
      });
    return () => controller.abort();
  }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await controlPlaneRequest(
        `mutation SaveWorktreeColors($enabled: Boolean!, $mode: WorktreeHighlightColorMode!) { saveWorktreeSettings(autoAssignHighlightColor: $enabled, highlightColorMode: $mode) { ${FIELDS} } }`,
        {
          enabled: settings.autoAssignHighlightColor,
          mode: settings.highlightColorMode,
        },
      );
      setSaved(true);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-5" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && <p role="status">{t("saved")}</p>}
        <div className="flex items-start gap-2">
          <Checkbox
            id="worktree-auto-color"
            disabled={!settings || busy}
            checked={settings?.autoAssignHighlightColor ?? true}
            onCheckedChange={(checked) =>
              setSettings(
                (current) =>
                  current && {
                    ...current,
                    autoAssignHighlightColor: checked === true,
                  },
              )
            }
          />
          <div className="space-y-1">
            <Label htmlFor="worktree-auto-color">{t("autoColor")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("autoColorHelp")}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="worktree-color-mode">{t("colorMode")}</Label>
          <Select
            disabled={!settings || busy || !settings.autoAssignHighlightColor}
            value={settings?.highlightColorMode ?? "SPREAD"}
            onValueChange={(mode) =>
              setSettings(
                (current) =>
                  current && {
                    ...current,
                    highlightColorMode: mode as Settings["highlightColorMode"],
                  },
              )
            }
          >
            <SelectTrigger id="worktree-color-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SPREAD">{t("spread")}</SelectItem>
              <SelectItem value="RANDOM">{t("random")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button disabled={!settings || busy} onClick={() => void save()}>
          {t("save")}
        </Button>
      </CardContent>
    </Card>
  );
}
