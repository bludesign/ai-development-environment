"use client";

import {
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DragEvent, FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { SettingsHelpLink } from "@/components/settings-help-link";
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
import { Textarea } from "@/components/ui/textarea";
import { useCredentialStoreReadOnly } from "@/hooks/use-credential-store-read-only";
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
  const tCredentials = useTranslations("credentials");
  const credentialsReadOnly = useCredentialStoreReadOnly();
  const locale = useLocale();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [draggingP8, setDraggingP8] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [environment, setEnvironment] = useState("SANDBOX");
  const [p12Base64, setP12Base64] = useState("");
  const [p12Filename, setP12Filename] = useState("");
  const [draggingP12, setDraggingP12] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const formatDate = (value: string) =>
    formatDateValue(value, "short", { locale });

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
      setNotice(t("tokenSaved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const loadP8File = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".p8")) {
      setError(t("p8Invalid"));
      setNotice(null);
      return;
    }
    try {
      const contents = await file.text();
      if (
        !contents.includes("-----BEGIN PRIVATE KEY-----") ||
        !contents.includes("-----END PRIVATE KEY-----")
      ) {
        setError(t("p8Invalid"));
        setNotice(null);
        return;
      }
      setPrivateKey(contents);
      setError(null);
      setNotice(t("p8Loaded", { filename: file.name }));
    } catch {
      setError(t("p8ReadError"));
      setNotice(null);
    }
  };

  const dropP8File = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingP8(false);
    if (credentialsReadOnly) return;
    const file = event.dataTransfer.files.item(0);
    if (file) void loadP8File(file);
  };

  const loadP12File = async (file: File) => {
    const filename = file.name.toLowerCase();
    if (!filename.endsWith(".p12") && !filename.endsWith(".pfx")) {
      setError(t("p12Invalid"));
      setNotice(null);
      return;
    }
    try {
      setP12Base64(await toBase64(file));
      setP12Filename(file.name);
      setError(null);
      setNotice(t("p12Loaded", { filename: file.name }));
    } catch {
      setError(t("p12ReadError"));
      setNotice(null);
    }
  };

  const dropP12File = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingP12(false);
    if (credentialsReadOnly) return;
    const file = event.dataTransfer.files.item(0);
    if (file) void loadP12File(file);
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
      setP12Filename("");
      setPassphrase("");
      setError(null);
      setNotice(t("certificateAdded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
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
        {notice && (
          <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 />
            <AlertDescription className="text-current">
              {notice}
            </AlertDescription>
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
          <p className="text-xs text-muted-foreground">
            {t("tokenSetupHelp")}{" "}
            <SettingsHelpLink href="https://developer.apple.com/account/resources/authkeys/add">
              {t("createTokenKey")}
            </SettingsHelpLink>
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="apns-team">{t("teamId")}</Label>
              <Input
                disabled={credentialsReadOnly}
                id="apns-team"
                onChange={(event) => setTeamId(event.target.value)}
                value={teamId}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apns-key">{t("keyId")}</Label>
              <Input
                disabled={credentialsReadOnly}
                id="apns-key"
                onChange={(event) => setKeyId(event.target.value)}
                value={keyId}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("teamIdHelp")}{" "}
            <SettingsHelpLink href="https://developer.apple.com/account#MembershipDetailsCard">
              {t("openMembership")}
            </SettingsHelpLink>
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="apns-private-key">{t("privateKey")}</Label>
            <div
              aria-label={t("p8DropZone")}
              className={`rounded-md border border-dashed p-2 transition-colors ${
                draggingP8 ? "border-primary bg-primary/5" : "border-input"
              }`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDraggingP8(true);
              }}
              onDragLeave={() => setDraggingP8(false)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggingP8(true);
              }}
              onDrop={dropP8File}
              role="group"
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Upload className="size-3.5" />{" "}
                {credentialsReadOnly
                  ? tCredentials("readOnlyNotice")
                  : t("p8DropHint")}
              </p>
              <Textarea
                autoComplete="new-password"
                className="min-h-36 border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                disabled={credentialsReadOnly}
                id="apns-private-key"
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder={
                  settings?.tokenConfigured
                    ? t("privateKeyConfiguredPlaceholder")
                    : t("privateKeyPlaceholder")
                }
                required={!settings?.tokenConfigured && !credentialsReadOnly}
                value={privateKey}
              />
              <Input
                accept=".p8,application/pkcs8,text/plain"
                aria-label={t("chooseP8")}
                className="mt-2 h-auto text-xs"
                disabled={credentialsReadOnly}
                onChange={(event) => {
                  const file = event.target.files?.item(0);
                  if (file) void loadP8File(file);
                  event.target.value = "";
                }}
                type="file"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {settings?.tokenConfigured
                ? t("privateKeyKeepHelp")
                : t("privateKeyHelp")}
            </p>
          </div>

          {(settings?.tokenConfiguredAt ||
            settings?.tokenPrivateKeyFingerprint ||
            settings?.tokenLastError) && (
            <Alert
              variant={settings.tokenLastError ? "destructive" : "default"}
            >
              <AlertDescription>
                {settings.tokenConfiguredAt && (
                  <p className="font-medium">
                    {t("tokenConfiguredOn", {
                      date: formatDate(settings.tokenConfiguredAt),
                    })}
                  </p>
                )}
                {settings.tokenLastUsedAt && (
                  <p className="mt-1 text-xs">
                    {t("tokenLastUsed", {
                      date: formatDate(settings.tokenLastUsedAt),
                    })}
                  </p>
                )}
                {settings.tokenLastError && (
                  <p className="mt-1 text-xs">{settings.tokenLastError}</p>
                )}
                {settings.tokenPrivateKeyFingerprint && (
                  <p className="mt-1 break-all font-mono text-xs">
                    SHA-256 {settings.tokenPrivateKeyFingerprint}
                  </p>
                )}
              </AlertDescription>
            </Alert>
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
                setPrivateKey("");
                setError(null);
                setNotice(t("tokenRemoved"));
              }}
              title={t("removeToken")}
              trigger={
                <Button
                  disabled={
                    busy || !settings?.tokenConfigured || credentialsReadOnly
                  }
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
                (!privateKey && !settings?.tokenConfigured) ||
                credentialsReadOnly
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
            <p className="mt-1 text-xs text-muted-foreground">
              {t("certificateSetupHelp")}{" "}
              <SettingsHelpLink href="https://developer.apple.com/account/resources/certificates/add">
                {t("createCertificate")}
              </SettingsHelpLink>
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="apns-certificate-name">{t("name")}</Label>
              <Input
                disabled={credentialsReadOnly}
                id="apns-certificate-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apns-certificate-topic">{t("topic")}</Label>
              <Input
                disabled={credentialsReadOnly}
                id="apns-certificate-topic"
                onChange={(event) => setTopic(event.target.value)}
                value={topic}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apns-certificate-environment">
                {t("environment")}
              </Label>
              <Select
                disabled={credentialsReadOnly}
                onValueChange={setEnvironment}
                value={environment}
              >
                <SelectTrigger id="apns-certificate-environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SANDBOX">Sandbox</SelectItem>
                  <SelectItem value="PRODUCTION">Production</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apns-certificate-bundle">{t("certificate")}</Label>
            <div
              aria-label={t("p12DropZone")}
              className={`rounded-md border border-dashed p-2 transition-colors ${
                draggingP12 ? "border-primary bg-primary/5" : "border-input"
              }`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDraggingP12(true);
              }}
              onDragLeave={() => setDraggingP12(false)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDraggingP12(true);
              }}
              onDrop={dropP12File}
              role="group"
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="size-3.5" />{" "}
                {credentialsReadOnly
                  ? tCredentials("readOnlyNotice")
                  : p12Filename
                    ? t("p12Selected", { filename: p12Filename })
                    : t("p12DropHint")}
              </p>
              <Textarea
                autoComplete="new-password"
                className="min-h-36 border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                disabled={credentialsReadOnly}
                id="apns-certificate-bundle"
                onChange={(event) => {
                  setP12Base64(event.target.value.trim());
                  setP12Filename("");
                }}
                placeholder={t("p12Placeholder")}
                required={!credentialsReadOnly}
                value={p12Base64}
              />
              <Input
                accept=".p12,.pfx,application/x-pkcs12"
                aria-label={t("chooseP12")}
                className="mt-2 h-auto text-xs"
                disabled={credentialsReadOnly}
                onChange={(event) => {
                  const file = event.target.files?.item(0);
                  if (file) void loadP12File(file);
                  event.target.value = "";
                }}
                type="file"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("certificateHelp")}
            </p>
          </div>
          <div className="space-y-2 sm:max-w-sm">
            <Label htmlFor="apns-certificate-passphrase">
              {t("passphrase")}
            </Label>
            <Input
              autoComplete="new-password"
              disabled={credentialsReadOnly}
              id="apns-certificate-passphrase"
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              value={passphrase}
            />
          </div>
          <div className="flex justify-end">
            <Button
              disabled={
                busy || !name || !topic || !p12Base64 || credentialsReadOnly
              }
              type="submit"
            >
              {busy ? <Spinner /> : <Save />} {t("addCertificate")}
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
                  <Button
                    disabled={credentialsReadOnly}
                    size="icon-sm"
                    variant="ghost"
                  >
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
