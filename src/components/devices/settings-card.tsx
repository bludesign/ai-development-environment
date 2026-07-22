"use client";

import {
  Apple,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";

import type { IosDeviceSettings } from "./types";
import { IOS_DEVICE_SETTINGS_FIELDS } from "./types";

export function IosDeviceSettingsCard() {
  const t = useTranslations("iosDeviceSettings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [settings, setSettings] = useState<IosDeviceSettings | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [profileIdentifier, setProfileIdentifier] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [draggingP8, setDraggingP8] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileBusy, setProfileBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = useCallback((next: IosDeviceSettings) => {
    setSettings(next);
    setOrganizationName(next.organizationName);
    setProfileIdentifier(next.profileIdentifier);
    setIssuerId(next.appStoreConnectIssuerId ?? "");
    setKeyId(next.appStoreConnectKeyId ?? "");
    setPrivateKey("");
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        iosDeviceSettings: IosDeviceSettings;
      }>(
        `query IosDeviceSettings {
          iosDeviceSettings { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.iosDeviceSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const formatDate = (value: string | null) =>
    formatDateValue(value, "short", {
      locale,
      fallback: t("unavailable"),
    });

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveIosProfileSettings: IosDeviceSettings;
      }>(
        `mutation SaveIosProfileSettings($input: SaveIosProfileSettingsInput!) {
          saveIosProfileSettings(input: $input) { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
        { input: { organizationName, profileIdentifier } },
      );
      applySettings(data.saveIosProfileSettings);
      setError(null);
      setNotice(t("profileSaved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setProfileBusy(false);
    }
  };

  const regenerateSigner = async () => {
    setProfileBusy(true);
    try {
      const data = await controlPlaneRequest<{
        regenerateIosProfileSigner: IosDeviceSettings;
      }>(
        `mutation RegenerateIosProfileSigner {
          regenerateIosProfileSigner { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.regenerateIosProfileSigner);
      setError(null);
      setNotice(t("signerRegenerated"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setProfileBusy(false);
    }
  };

  const saveApple = async (event: FormEvent) => {
    event.preventDefault();
    setAppleBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveAppStoreConnectSettings: IosDeviceSettings;
      }>(
        `mutation SaveAppStoreConnectSettings($input: SaveAppStoreConnectSettingsInput!) {
          saveAppStoreConnectSettings(input: $input) { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
        {
          input: {
            issuerId: issuerId.trim(),
            keyId: keyId.trim(),
            privateKey: privateKey || null,
          },
        },
      );
      applySettings(data.saveAppStoreConnectSettings);
      setError(null);
      setNotice(t("appleSaved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setAppleBusy(false);
    }
  };

  const testApple = async () => {
    setAppleBusy(true);
    try {
      const data = await controlPlaneRequest<{
        testAppStoreConnectSettings: IosDeviceSettings;
      }>(
        `mutation TestAppStoreConnectSettings {
          testAppStoreConnectSettings { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.testAppStoreConnectSettings);
      setError(null);
      setNotice(t("appleTestSucceeded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
      void load();
    } finally {
      setAppleBusy(false);
    }
  };

  const clearApple = async () => {
    setAppleBusy(true);
    try {
      const data = await controlPlaneRequest<{
        clearAppStoreConnectSettings: IosDeviceSettings;
      }>(
        `mutation ClearAppStoreConnectSettings {
          clearAppStoreConnectSettings { ${IOS_DEVICE_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.clearAppStoreConnectSettings);
      setError(null);
      setNotice(t("appleCleared"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setAppleBusy(false);
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
    const file = event.dataTransfer.files.item(0);
    if (file) void loadP8File(file);
  };

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <Apple className="size-5" />
          <div>
            <h2 className="font-semibold">{t("title")}</h2>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
        </div>

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

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loading")}
          </p>
        ) : (
          <>
            <form className="space-y-4" onSubmit={saveProfile}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 font-medium">
                    <ShieldCheck className="size-4" /> {t("profileTitle")}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("profileDescription")}
                  </p>
                </div>
                <Badge variant="outline">
                  {settings?.signerConfigured
                    ? t("signerReady")
                    : t("signerNotGenerated")}
                </Badge>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ios-organization-name">
                    {t("organizationName")}
                  </Label>
                  <Input
                    id="ios-organization-name"
                    maxLength={100}
                    onChange={(event) =>
                      setOrganizationName(event.target.value)
                    }
                    required
                    value={organizationName}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("profileOrganizationHelp")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ios-profile-identifier">
                    {t("profileIdentifier")}
                  </Label>
                  <Input
                    autoCapitalize="none"
                    className="font-mono text-sm"
                    id="ios-profile-identifier"
                    maxLength={200}
                    onChange={(event) =>
                      setProfileIdentifier(event.target.value)
                    }
                    required
                    spellCheck={false}
                    value={profileIdentifier}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("profileIdentifierHelp")}
                  </p>
                </div>
              </div>

              {settings?.signerConfigured && (
                <div className="rounded-md border bg-muted/30 p-3 text-xs">
                  <p>
                    {t("signerCreated", {
                      date: formatDate(settings.signerCreatedAt),
                    })}
                  </p>
                  <p>
                    {t("signerExpires", {
                      date: formatDate(settings.signerExpiresAt),
                    })}
                  </p>
                  <p className="mt-1 break-all font-mono text-muted-foreground">
                    {settings.signerFingerprint}
                  </p>
                  <p className="mt-2 text-amber-700 dark:text-amber-300">
                    {t("unverifiedWarning")}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                <ConfirmationDialog
                  actionLabel={t("regenerateSigner")}
                  cancelLabel={tc("cancel")}
                  description={t("regenerateDescription")}
                  onConfirm={regenerateSigner}
                  title={t("regenerateTitle")}
                  trigger={
                    <Button
                      disabled={profileBusy}
                      type="button"
                      variant="outline"
                    >
                      <RefreshCw /> {t("regenerateSigner")}
                    </Button>
                  }
                />
                <Button disabled={profileBusy} type="submit">
                  {profileBusy ? <Spinner /> : <Save />} {t("saveProfile")}
                </Button>
              </div>
            </form>

            <form className="space-y-4 border-t pt-6" onSubmit={saveApple}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 font-medium">
                    <KeyRound className="size-4" /> {t("appleTitle")}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("appleDescription")}
                  </p>
                </div>
                <Badge
                  className={
                    settings?.appStoreConnectConfigured
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : undefined
                  }
                >
                  {settings?.appStoreConnectConfigured
                    ? t("verified")
                    : t("notVerified")}
                </Badge>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <p className="sm:col-span-2 text-xs text-muted-foreground">
                  {t("appleSetupHelp")}{" "}
                  <SettingsHelpLink href="https://appstoreconnect.apple.com/access/integrations/api">
                    {t("openApiKeys")}
                  </SettingsHelpLink>
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="app-store-issuer-id">{t("issuerId")}</Label>
                  <Input
                    autoCapitalize="none"
                    id="app-store-issuer-id"
                    maxLength={100}
                    onChange={(event) => setIssuerId(event.target.value)}
                    required
                    spellCheck={false}
                    value={issuerId}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-store-key-id">{t("keyId")}</Label>
                  <Input
                    autoCapitalize="characters"
                    id="app-store-key-id"
                    maxLength={100}
                    onChange={(event) => setKeyId(event.target.value)}
                    required
                    spellCheck={false}
                    value={keyId}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="app-store-private-key">{t("privateKey")}</Label>
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
                    <Upload className="size-3.5" /> {t("p8DropHint")}
                  </p>
                  <Textarea
                    autoComplete="new-password"
                    className="min-h-36 border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                    id="app-store-private-key"
                    onChange={(event) => setPrivateKey(event.target.value)}
                    placeholder={
                      settings?.appStoreConnectPrivateKeyConfigured
                        ? t("privateKeyConfiguredPlaceholder")
                        : t("privateKeyPlaceholder")
                    }
                    required={!settings?.appStoreConnectPrivateKeyConfigured}
                    value={privateKey}
                  />
                  <Input
                    accept=".p8,application/pkcs8,text/plain"
                    aria-label={t("chooseP8")}
                    className="mt-2 h-auto text-xs"
                    onChange={(event) => {
                      const file = event.target.files?.item(0);
                      if (file) void loadP8File(file);
                      event.target.value = "";
                    }}
                    type="file"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {settings?.appStoreConnectPrivateKeyConfigured
                    ? t("privateKeyKeepHelp")
                    : t("privateKeyHelp")}
                </p>
              </div>

              {(settings?.appStoreConnectLastTestedAt ||
                settings?.appStoreConnectPrivateKeyFingerprint) && (
                <Alert
                  variant={
                    settings.appStoreConnectVerificationError
                      ? "destructive"
                      : "default"
                  }
                >
                  <AlertDescription>
                    <p className="font-medium">
                      {settings.appStoreConnectVerificationError
                        ? t("lastTestFailed", {
                            date: formatDate(
                              settings.appStoreConnectLastTestedAt,
                            ),
                          })
                        : t("lastVerified", {
                            date: formatDate(
                              settings.appStoreConnectVerifiedAt,
                            ),
                          })}
                    </p>
                    {settings.appStoreConnectVerificationError && (
                      <p className="mt-1 text-xs">
                        {settings.appStoreConnectVerificationError}
                      </p>
                    )}
                    {settings.appStoreConnectPrivateKeyFingerprint && (
                      <p className="mt-1 break-all font-mono text-xs">
                        {settings.appStoreConnectPrivateKeyFingerprint}
                      </p>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                <ConfirmationDialog
                  actionLabel={t("clear")}
                  cancelLabel={tc("cancel")}
                  description={t("clearDescription")}
                  onConfirm={clearApple}
                  title={t("clearTitle")}
                  trigger={
                    <Button
                      disabled={
                        appleBusy ||
                        !settings?.appStoreConnectPrivateKeyConfigured
                      }
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 /> {t("clear")}
                    </Button>
                  }
                />
                <Button
                  disabled={
                    appleBusy || !settings?.appStoreConnectPrivateKeyConfigured
                  }
                  onClick={() => void testApple()}
                  type="button"
                  variant="outline"
                >
                  <RefreshCw /> {t("retest")}
                </Button>
                <Button disabled={appleBusy} type="submit">
                  {appleBusy ? <Spinner /> : <Save />} {t("saveAndVerify")}
                </Button>
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
