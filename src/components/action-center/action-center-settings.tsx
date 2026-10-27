"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

const FIELDS =
  "maximumRequestAgeDays showMyRequestsInSidebar showReviewRequestsInSidebar";
type Settings = {
  maximumRequestAgeDays: number;
  showMyRequestsInSidebar: boolean;
  showReviewRequestsInSidebar: boolean;
};
export function ActionCenterSettingsCard() {
  const t = useTranslations("actionCenter");
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [age, setAge] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void controlPlaneRequest<{ actionCenterSettings: Settings }>(
      `query ActionCenterSettings { actionCenterSettings { ${FIELDS} } }`,
    )
      .then((data) => {
        if (active) {
          setSettings(data.actionCenterSettings);
          setAge(String(data.actionCenterSettings.maximumRequestAgeDays));
        }
      })
      .catch((value: unknown) => {
        if (active) setError(String(value));
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation SaveActionCenterSettings($input: SaveActionCenterSettingsInput!) { saveActionCenterSettings(input: $input) { ${FIELDS} } }`,
        { input: { ...settings, maximumRequestAgeDays: Number(age) } },
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card id="action-center-settings">
      <CardHeader>
        <CardTitle>{t("settingsTitle")}</CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor={`${id}-age`}>{t("maximumAge")}</Label>
          <Input
            id={`${id}-age`}
            type="number"
            min={0}
            step={1}
            value={age}
            disabled={!settings || busy}
            onChange={(event) => setAge(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("maximumAgeHelp")}</p>
        </div>
        {(
          ["showMyRequestsInSidebar", "showReviewRequestsInSidebar"] as const
        ).map((key) => (
          <div className="flex items-center gap-2" key={key}>
            <Checkbox
              id={`${id}-${key}`}
              checked={settings?.[key] ?? true}
              disabled={!settings || busy}
              onCheckedChange={(checked) =>
                setSettings(
                  (current) =>
                    current && { ...current, [key]: checked === true },
                )
              }
            />
            <Label htmlFor={`${id}-${key}`}>{t(key)}</Label>
          </div>
        ))}
        <Button
          onClick={() => void save()}
          disabled={
            !settings ||
            busy ||
            age.trim() === "" ||
            !Number.isInteger(Number(age)) ||
            Number(age) < 0
          }
        >
          {t("saveSettings")}
        </Button>
      </CardContent>
    </Card>
  );
}
