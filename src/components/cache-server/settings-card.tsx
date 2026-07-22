"use client";

import {
  CheckCircle2,
  DatabaseZap,
  Plus,
  Save,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  CACHE_SERVER_SETTINGS_FIELDS,
  type CacheServerSettingsView,
} from "@/services/cache-server/types";

type CacheServerHeaderDraft = {
  name: string;
  value: string;
  valueConfigured: boolean;
};

export function CacheServerSettingsCard() {
  const t = useTranslations("cacheServerSettings");
  const tc = useTranslations("common");
  const [settings, setSettings] = useState<CacheServerSettingsView | null>(
    null,
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<CacheServerHeaderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = useCallback((next: CacheServerSettingsView) => {
    setSettings(next);
    setBaseUrl(next.baseUrl ?? "");
    setApiKey("");
    setHeaders(next.headers.map((header) => ({ ...header, value: "" })));
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        cacheServerSettings: CacheServerSettingsView;
      }>(
        `query CacheServerSettings { cacheServerSettings { ${CACHE_SERVER_SETTINGS_FIELDS} } }`,
      );
      applySettings(data.cacheServerSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const addHeader = () =>
    setHeaders((current) => [
      ...current,
      { name: "", value: "", valueConfigured: false },
    ]);

  const updateHeader = (
    index: number,
    field: "name" | "value",
    value: string,
  ) =>
    setHeaders((current) =>
      current.map((header, position) =>
        position === index
          ? {
              ...header,
              [field]: value,
              ...(field === "name" && value !== header.name
                ? { valueConfigured: false }
                : {}),
            }
          : header,
      ),
    );

  const removeHeader = (index: number) =>
    setHeaders((current) =>
      current.filter((_header, position) => position !== index),
    );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const cleanedHeaders = headers
        .map((header) => ({
          name: header.name.trim(),
          value: header.value || null,
        }))
        .filter((header) => header.name);
      const data = await controlPlaneRequest<{
        saveCacheServerSettings: CacheServerSettingsView;
      }>(
        `mutation SaveCacheServerSettings($input: SaveCacheServerSettingsInput!) {
          saveCacheServerSettings(input: $input) { ${CACHE_SERVER_SETTINGS_FIELDS} }
        }`,
        {
          input: {
            baseUrl: baseUrl.trim(),
            apiKey: apiKey || null,
            headers: cleanedHeaders,
          },
        },
      );
      applySettings(data.saveCacheServerSettings);
      setError(null);
      setNotice(t("saved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        testCacheServerConnection: CacheServerSettingsView;
      }>(
        `mutation TestCacheServerConnection {
          testCacheServerConnection { ${CACHE_SERVER_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.testCacheServerConnection);
      setError(null);
      setNotice(t("connectionSucceeded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const clearSettings = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        clearCacheServerSettings: CacheServerSettingsView;
      }>(
        `mutation ClearCacheServerSettings {
          clearCacheServerSettings { ${CACHE_SERVER_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.clearCacheServerSettings);
      setError(null);
      setNotice(t("removed"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <DatabaseZap className="size-5" />
              <div>
                <h2 className="font-semibold">{t("title")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("description")}
                </p>
              </div>
            </div>
            <Badge
              className={
                settings?.configured
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : undefined
              }
            >
              {settings?.configured ? t("configured") : t("notConfigured")}
            </Badge>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              {t("loading")}
            </div>
          ) : (
            <>
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
              <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                {t("setupHelp")}
              </p>
              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="cache-server-base-url"
                >
                  {t("baseUrl")}
                </Label>
                <Input
                  autoComplete="url"
                  id="cache-server-base-url"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://cache-server.internal:3006/management-api"
                  required
                  type="url"
                  value={baseUrl}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("baseUrlHelp")}
                </p>
              </div>
              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="cache-server-api-key"
                >
                  {t("apiKey")}
                </Label>
                <Input
                  autoComplete="new-password"
                  id="cache-server-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    settings?.apiKeyConfigured
                      ? t("apiKeyPlaceholderConfigured")
                      : t("apiKeyPlaceholder")
                  }
                  required={!settings?.apiKeyConfigured}
                  type="password"
                  value={apiKey}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {settings?.apiKeyConfigured
                    ? t("apiKeyKeepHelp")
                    : t("apiKeyHelp")}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t("headers")}</Label>
                  <Button
                    onClick={addHeader}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus />
                    {t("addHeader")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("headersHelp")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("headersSetupHelp")}
                </p>
                {headers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("noHeaders")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {headers.map((header, index) => (
                      <div className="flex items-center gap-2" key={index}>
                        <Input
                          aria-label={t("headerName")}
                          className="flex-1"
                          onChange={(event) =>
                            updateHeader(index, "name", event.target.value)
                          }
                          placeholder={t("headerName")}
                          value={header.name}
                        />
                        <Input
                          aria-label={t("headerValue")}
                          autoComplete="new-password"
                          className="flex-1"
                          onChange={(event) =>
                            updateHeader(index, "value", event.target.value)
                          }
                          placeholder={
                            header.valueConfigured
                              ? t("headerValuePlaceholderConfigured")
                              : t("headerValue")
                          }
                          required={!header.valueConfigured}
                          type="password"
                          value={header.value}
                        />
                        <Button
                          aria-label={t("removeHeader")}
                          onClick={() => removeHeader(index)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <ConfirmationDialog
                  actionLabel={t("remove")}
                  cancelLabel={tc("cancel")}
                  description={t("confirmRemoveDescription")}
                  onConfirm={clearSettings}
                  title={t("confirmRemove")}
                  trigger={
                    <Button
                      disabled={busy || !settings?.configured}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                      {t("remove")}
                    </Button>
                  }
                />
                <Button
                  disabled={busy || !settings?.configured}
                  onClick={() => void testConnection()}
                  type="button"
                  variant="outline"
                >
                  <Unplug />
                  {t("test")}
                </Button>
                <Button disabled={busy} type="submit">
                  {busy ? <Spinner /> : <Save />}
                  {t("save")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
