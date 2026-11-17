"use client";

import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

export const LIVE_ACTIVITY_SETTINGS_FIELDS = `
  includePlans includeSessions includeBuilds includeWorkflows includeCommands
  includeGitHubActions includeGitLabPipelines updatedAt
`;

export type LiveActivitySettingsView = {
  includePlans: boolean;
  includeSessions: boolean;
  includeBuilds: boolean;
  includeWorkflows: boolean;
  includeCommands: boolean;
  includeGitHubActions: boolean;
  includeGitLabPipelines: boolean;
  updatedAt: string;
};

export const LIVE_ACTIVITY_SETTING_KEYS = [
  "includePlans",
  "includeSessions",
  "includeBuilds",
  "includeWorkflows",
  "includeCommands",
  "includeGitHubActions",
  "includeGitLabPipelines",
] as const;

export type LiveActivitySettingKey =
  (typeof LIVE_ACTIVITY_SETTING_KEYS)[number];

export function LiveActivitySettingsCard({
  settings,
  saving,
  loading,
  error,
  onChange,
  onRetry,
}: {
  settings: LiveActivitySettingsView | null;
  saving: LiveActivitySettingKey | null;
  loading: boolean;
  error: string | null;
  onChange: (key: LiveActivitySettingKey, enabled: boolean) => void;
  onRetry: () => void;
}) {
  const t = useTranslations("notifications");
  return (
    <Card aria-busy={loading || saving !== null} id="live-activity-settings">
      <CardHeader>
        <CardTitle>{t("liveActivity.title")}</CardTitle>
        <CardDescription>{t("liveActivity.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{error}</span>
              <Button
                disabled={loading || saving !== null}
                onClick={onRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("liveActivity.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {settings ? (
          <div className="grid gap-3 md:grid-cols-2">
            {LIVE_ACTIVITY_SETTING_KEYS.map((key) => {
              const id = `live-activity-${key}`;
              return (
                <div
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  key={key}
                >
                  <Label
                    className="flex-1 cursor-pointer leading-5"
                    htmlFor={id}
                  >
                    {t(`liveActivity.items.${key}`)}
                  </Label>
                  {saving === key && (
                    <Spinner aria-label={t("liveActivity.saving")} />
                  )}
                  <Switch
                    checked={settings[key]}
                    disabled={loading || saving !== null}
                    id={id}
                    onCheckedChange={(enabled) => onChange(key, enabled)}
                  />
                </div>
              );
            })}
          </div>
        ) : loading ? (
          <div
            aria-label={t("liveActivity.loading")}
            className="grid gap-3 md:grid-cols-2"
            role="status"
          >
            {LIVE_ACTIVITY_SETTING_KEYS.map((key) => (
              <Skeleton className="h-12 w-full" key={key} />
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("liveActivity.scope")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("liveActivity.attention")}
        </p>
      </CardContent>
    </Card>
  );
}
