"use client";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  SERVER_URL_SETTINGS_FIELDS,
  type ServerUrlKind,
  type ServerUrlSettings,
} from "@/lib/server-urls";
import { ServerUrlSelect } from "./server-url-controls";

export function ServerUrlsSettingsCard() {
  const t = useTranslations("serverUrls");
  const { settings, error, refresh } = useServerUrlSettings();
  if (settings) return <ServerUrlsSettingsForm settings={settings} />;
  return (
    <Card id="server-urls">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p>{error ?? t("loading")}</p>
        {error && (
          <Button onClick={() => void refresh()}>{t("loading")}</Button>
        )}
      </CardContent>
    </Card>
  );
}
function ServerUrlsSettingsForm({ settings }: { settings: ServerUrlSettings }) {
  const t = useTranslations("serverUrls");
  const { error: loadError, refresh } = useServerUrlSettings();
  const [local, setLocal] = useState(settings.localBaseUrlOverride ?? "");
  const [remote, setRemote] = useState(settings.remoteBaseUrlOverride ?? "");
  const [proxy, setProxy] = useState(settings.proxyBaseUrl ?? "");
  const [globalDefault, setGlobalDefault] = useState<ServerUrlKind>(
    settings.defaultServerUrlKind,
  );
  const [simulatorDefault, setSimulatorDefault] = useState<
    ServerUrlKind | "INHERIT"
  >(settings.simulatorDefaultServerUrlKind ?? "INHERIT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await controlPlaneRequest(
        `mutation SaveSharedServerUrls($input: SaveServerUrlSettingsInput!, $origin: String) { saveServerUrlSettings(input: $input, requestOrigin: $origin) { ${SERVER_URL_SETTINGS_FIELDS} } }`,
        {
          input: {
            localBaseUrlOverride: local.trim() || null,
            remoteBaseUrlOverride: remote.trim() || null,
            proxyBaseUrl: proxy.trim() || null,
            defaultServerUrlKind: globalDefault,
            simulatorDefaultServerUrlKind:
              simulatorDefault === "INHERIT" ? null : simulatorDefault,
          },
          origin: window.location.origin,
        },
      );
      await refresh();
      setSaved(true);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const draft = settings
    ? {
        ...settings,
        proxyBaseUrl: proxy.trim() || null,
        effectiveLocalBaseUrl: local.trim() || settings.detectedLocalBaseUrl,
        effectiveRemoteBaseUrl: remote.trim() || settings.detectedRemoteBaseUrl,
        defaultServerUrlKind: globalDefault,
      }
    : null;
  return (
    <Card id="server-urls">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(error ?? loadError) && (
          <Alert variant="destructive">
            <AlertDescription>{error ?? loadError}</AlertDescription>
          </Alert>
        )}
        {saved && (
          <p role="status" className="text-sm">
            {t("saved")}
          </p>
        )}
        {settings && draft ? (
          <>
            {(
              [
                {
                  kind: "local",
                  value: local,
                  set: setLocal,
                  detected: settings.detectedLocalBaseUrl,
                },
                {
                  kind: "remote",
                  value: remote,
                  set: setRemote,
                  detected: settings.detectedRemoteBaseUrl,
                },
              ] as const
            ).map((field) => (
              <div key={field.kind} className="space-y-2">
                <Label htmlFor={`server-${field.kind}`}>
                  {t(`${field.kind}Override`)}
                </Label>
                <Input
                  id={`server-${field.kind}`}
                  type="url"
                  value={field.value}
                  placeholder={field.detected}
                  onChange={(event) => field.set(event.target.value)}
                />
                <p className="break-all text-xs text-muted-foreground">
                  {t("detected", { value: field.detected })}
                </p>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="server-proxy">{t("proxyUrl")}</Label>
              <Input
                id="server-proxy"
                type="url"
                placeholder="https://my-server.ts.net"
                value={proxy}
                onChange={(event) => setProxy(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("overrideHelp")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-default">{t("default")}</Label>
              <ServerUrlSelect
                id="server-default"
                settings={draft}
                value={globalDefault}
                onValueChange={(value) => {
                  if (value !== "INHERIT") setGlobalDefault(value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-simulator-default">
                {t("simulatorDefault")}
              </Label>
              <ServerUrlSelect
                id="server-simulator-default"
                settings={draft}
                value={simulatorDefault}
                inherit
                onValueChange={setSimulatorDefault}
              />
            </div>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? t("saving") : t("save")}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
      </CardContent>
    </Card>
  );
}
