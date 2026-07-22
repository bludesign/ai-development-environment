"use client";

import { KeyRound, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

type Settings = {
  tokenConfigured: boolean;
  tokenTeamId: string | null;
  tokenKeyId: string | null;
  tokenPrivateKeyFingerprint: string | null;
  tokenConfiguredAt: string | null;
  tokenLastUsedAt: string | null;
  tokenLastError: string | null;
  certificates: Array<{
    id: string;
    name: string;
    topic: string;
    environment: string;
    fingerprint: string;
    expiresAt: string | null;
    lastTestedAt: string | null;
    lastError: string | null;
  }>;
};

const FIELDS = `
  tokenConfigured tokenTeamId tokenKeyId tokenPrivateKeyFingerprint
  tokenConfiguredAt tokenLastUsedAt tokenLastError
  certificates { id name topic environment fingerprint expiresAt lastTestedAt lastError }
`;

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });

export function PushNotificationSettingsCard() {
  const t = useTranslations("pushSettings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [environment, setEnvironment] = useState("SANDBOX");
  const [p12Base64, setP12Base64] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        pushNotificationSettings: Settings;
      }>(`query PushSettings { pushNotificationSettings { ${FIELDS} } }`);
      setSettings(data.pushNotificationSettings);
      setTeamId(data.pushNotificationSettings.tokenTeamId ?? "");
      setKeyId(data.pushNotificationSettings.tokenKeyId ?? "");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const saveToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveApnsTokenSettings: Settings;
      }>(
        `mutation SaveApnsToken($input: SaveApnsTokenSettingsInput!) { saveApnsTokenSettings(input: $input) { ${FIELDS} } }`,
        { input: { teamId, keyId, privateKey: privateKey || null } },
      );
      setSettings(data.saveApnsTokenSettings);
      setPrivateKey("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const addCertificate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        addApnsCertificateCredential: Settings;
      }>(
        `mutation AddApnsCertificate($input: AddApnsCertificateCredentialInput!) { addApnsCertificateCredential(input: $input) { ${FIELDS} } }`,
        { input: { name, topic, environment, p12Base64, passphrase } },
      );
      setSettings(data.addApnsCertificateCredential);
      setName("");
      setTopic("");
      setP12Base64("");
      setPassphrase("");
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form className="space-y-4" onSubmit={saveToken}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium">{t("tokenAuthentication")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("tokenDescription")}
              </p>
            </div>
            <Badge
              variant={settings?.tokenConfigured ? "default" : "secondary"}
            >
              {settings?.tokenConfigured ? t("configured") : t("notConfigured")}
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="apns-team">{t("teamId")}</Label>
              <Input
                id="apns-team"
                onChange={(event) => setTeamId(event.target.value)}
                value={teamId}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apns-key">{t("keyId")}</Label>
              <Input
                id="apns-key"
                onChange={(event) => setKeyId(event.target.value)}
                value={keyId}
              />
            </div>
          </div>
          <Label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-6">
            <Upload />{" "}
            {privateKey
              ? t("p8Ready")
              : settings?.tokenConfigured
                ? t("replaceP8")
                : t("chooseP8")}
            <Input
              accept=".p8"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(setPrivateKey);
              }}
              type="file"
            />
          </Label>
          {settings?.tokenPrivateKeyFingerprint && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              SHA-256 {settings.tokenPrivateKeyFingerprint}
            </p>
          )}
          {settings?.tokenLastError && (
            <p className="text-sm text-destructive">
              {settings.tokenLastError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <ConfirmationDialog
              actionLabel={t("remove")}
              cancelLabel={tc("cancel")}
              description={t("removeTokenDescription")}
              onConfirm={async () => {
                const data = await controlPlaneRequest<{
                  clearApnsTokenSettings: Settings;
                }>(`mutation { clearApnsTokenSettings { ${FIELDS} } }`);
                setSettings(data.clearApnsTokenSettings);
                setTeamId("");
                setKeyId("");
              }}
              title={t("removeToken")}
              trigger={
                <Button
                  disabled={busy || !settings?.tokenConfigured}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 /> {t("remove")}
                </Button>
              }
            />
            <Button
              disabled={
                busy ||
                !teamId ||
                !keyId ||
                (!privateKey && !settings?.tokenConfigured)
              }
              type="submit"
            >
              {busy ? <Spinner /> : <Save />} {t("save")}
            </Button>
          </div>
        </form>

        <div className="border-t" />
        <form className="space-y-4" onSubmit={addCertificate}>
          <div>
            <h3 className="font-medium">{t("certificateAuthentication")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("certificateDescription")}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>{t("name")}</Label>
              <Input
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("topic")}</Label>
              <Input
                onChange={(event) => setTopic(event.target.value)}
                value={topic}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("environment")}</Label>
              <Select onValueChange={setEnvironment} value={environment}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SANDBOX">Sandbox</SelectItem>
                  <SelectItem value="PRODUCTION">Production</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-5">
              <KeyRound /> {p12Base64 ? t("p12Ready") : t("chooseP12")}
              <Input
                accept=".p12,.pfx"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void toBase64(file).then(setP12Base64);
                }}
                type="file"
              />
            </Label>
            <div className="space-y-2">
              <Label>{t("passphrase")}</Label>
              <Input
                onChange={(event) => setPassphrase(event.target.value)}
                type="password"
                value={passphrase}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              disabled={busy || !name || !topic || !p12Base64}
              type="submit"
            >
              <Save /> {t("addCertificate")}
            </Button>
          </div>
        </form>
        {settings?.certificates.map((credential) => (
          <div
            className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-4"
            key={credential.id}
          >
            <div>
              <p className="font-medium">{credential.name}</p>
              <p className="font-mono text-xs">
                {credential.topic} · {credential.environment}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                SHA-256 {credential.fingerprint}
              </p>
              {credential.expiresAt && (
                <p className="text-xs text-muted-foreground">
                  {t("expires", {
                    date: formatDateValue(credential.expiresAt, "short", {
                      locale,
                      showTime: false,
                    }),
                  })}
                </p>
              )}
              {credential.lastTestedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("lastTested", {
                    date: formatDateValue(credential.lastTestedAt, "short", {
                      locale,
                    }),
                  })}
                </p>
              )}
              {credential.lastError && (
                <p className="text-xs text-destructive">
                  {credential.lastError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const data = await controlPlaneRequest<{
                        retestApnsCertificateCredential: Settings;
                      }>(
                        `mutation Retest($id: ID!) { retestApnsCertificateCredential(id: $id) { ${FIELDS} } }`,
                        { id: credential.id },
                      );
                      setSettings(data.retestApnsCertificateCredential);
                      setError(null);
                    } catch (value) {
                      setError(
                        value instanceof Error ? value.message : String(value),
                      );
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
                size="sm"
                variant="outline"
              >
                <RefreshCw /> {t("retest")}
              </Button>
              <ConfirmationDialog
                actionLabel={t("remove")}
                cancelLabel={tc("cancel")}
                description={t("removeCertificateDescription")}
                onConfirm={async () => {
                  await controlPlaneRequest(
                    `mutation Delete($id: ID!) { deleteApnsCertificateCredential(id: $id) }`,
                    { id: credential.id },
                  );
                  await load();
                }}
                title={t("removeCertificate")}
                trigger={
                  <Button size="icon-sm" variant="ghost">
                    <Trash2 />
                  </Button>
                }
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
