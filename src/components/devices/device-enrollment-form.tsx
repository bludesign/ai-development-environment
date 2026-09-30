"use client";
import { useState } from "react";
import { isLoopback } from "@/lib/public-origin";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  EndpointUrls,
  ServerUrlPicker,
} from "@/components/server-urls/server-url-controls";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import {
  serverUrlOptions,
  serverUrlKindFromLocation,
  type ServerUrlKind,
} from "@/lib/server-urls";

export function DeviceEnrollmentForm() {
  const t = useTranslations("devices");
  const { settings } = useServerUrlSettings();
  const [kind, setKind] = useState<ServerUrlKind | null>(
    serverUrlKindFromLocation,
  );
  const selectedKind = kind ?? settings?.defaultServerUrlKind;
  const base =
    settings &&
    serverUrlOptions(settings).find((option) => option.kind === selectedKind)
      ?.url;
  const enabled = Boolean(
    base && base.startsWith("https://") && !isLoopback(new URL(base).hostname),
  );
  return (
    <form
      action="/api/ios/enrollment/start"
      className="space-y-5"
      method="post"
    >
      <ServerUrlPicker value={kind} onValueChange={setKind} />
      <EndpointUrls path="/api/public/ios/enrollment-profile" />
      {!enabled && (
        <Alert variant="destructive">
          <AlertDescription>{t("httpsRequired")}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="serverUrlKind" value={selectedKind ?? ""} />
      <div className="space-y-2">
        <Label htmlFor="displayName">{t("deviceLabel")}</Label>
        <Input
          disabled={!enabled}
          id="displayName"
          maxLength={100}
          name="displayName"
          placeholder={t("deviceLabelPlaceholder")}
          required
        />
        <p className="text-xs text-muted-foreground">{t("deviceLabelHelp")}</p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input
          className="mt-1 size-4"
          disabled={!enabled}
          name="consent"
          required
          type="checkbox"
          value="yes"
        />
        <span>{t("consent")}</span>
      </label>
      <Button disabled={!enabled} type="submit">
        {t("downloadProfile")}
      </Button>
    </form>
  );
}
