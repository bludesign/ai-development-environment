"use client";

import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Save,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraSettingsView } from "@/services/jira/types";

const SETTINGS_FIELDS =
  "siteUrl email tokenConfigured cacheTtlSeconds updatedAt";

type ConnectionResult = {
  accountId: string | null;
  displayName: string;
  emailAddress: string | null;
};

export function JiraSettingsPage() {
  const t = useTranslations("jiraSettings");
  const [settings, setSettings] = useState<JiraSettingsView | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = (next: JiraSettingsView) => {
    setSettings(next);
    setSiteUrl(next.siteUrl ?? "");
    setEmail(next.email ?? "");
    setApiToken("");
  };

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        jiraSettings: JiraSettingsView;
      }>(`query { jiraSettings { ${SETTINGS_FIELDS} } }`);
      applySettings(data.jiraSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const siteChanged = Boolean(
      settings?.siteUrl &&
      settings.siteUrl !== siteUrl.trim().replace(/\/$/, ""),
    );
    if (siteChanged && !window.confirm(t("confirmSiteChange"))) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveJiraSettings: JiraSettingsView;
      }>(
        `mutation SaveJiraSettings($input: SaveJiraSettingsInput!) { saveJiraSettings(input: $input) { ${SETTINGS_FIELDS} } }`,
        {
          input: {
            siteUrl,
            email,
            apiToken: apiToken || null,
            resetSite: siteChanged,
          },
        },
      );
      applySettings(data.saveJiraSettings);
      setConnection(null);
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
        testJiraConnection: ConnectionResult;
      }>(
        "mutation { testJiraConnection { accountId displayName emailAddress } }",
      );
      setConnection(data.testJiraConnection);
      setError(null);
      setNotice(t("connectionSucceeded"));
    } catch (value) {
      setConnection(null);
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const clearCredentials = async () => {
    if (!window.confirm(t("confirmRemove"))) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        clearJiraCredentials: JiraSettingsView;
      }>(`mutation { clearJiraCredentials { ${SETTINGS_FIELDS} } }`);
      applySettings(data.clearJiraCredentials);
      setConnection(null);
      setError(null);
      setNotice(t("removed"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {t("loading")}
        </div>
      ) : (
        <form
          className="space-y-5 rounded-xl border bg-card p-5 shadow-sm"
          onSubmit={(event) => void save(event)}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="size-5" />
              <h2 className="font-semibold">{t("credentials")}</h2>
            </div>
            <Badge
              className={
                settings?.tokenConfigured
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : undefined
              }
            >
              {settings?.tokenConfigured ? t("configured") : t("notConfigured")}
            </Badge>
          </div>
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-4" />
              {notice}
            </div>
          )}
          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              htmlFor="jira-site-url"
            >
              {t("siteUrl")}
            </label>
            <Input
              autoComplete="url"
              id="jira-site-url"
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder="https://example.atlassian.net"
              required
              type="url"
              value={siteUrl}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("siteUrlHelp")}
            </p>
          </div>
          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              htmlFor="jira-email"
            >
              {t("email")}
            </label>
            <Input
              autoComplete="username"
              id="jira-email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </div>
          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              htmlFor="jira-token"
            >
              {t("apiToken")}
            </label>
            <Input
              autoComplete="new-password"
              id="jira-token"
              onChange={(event) => setApiToken(event.target.value)}
              placeholder={
                settings?.tokenConfigured
                  ? t("tokenPlaceholderConfigured")
                  : t("tokenPlaceholder")
              }
              required={!settings?.tokenConfigured}
              type="password"
              value={apiToken}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {settings?.tokenConfigured ? t("tokenKeepHelp") : t("tokenHelp")}
            </p>
          </div>
          {connection && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-medium">{connection.displayName}</p>
              <p className="text-muted-foreground">
                {connection.emailAddress ?? connection.accountId}
              </p>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              disabled={busy || !settings?.tokenConfigured}
              onClick={() => void clearCredentials()}
              type="button"
              variant="ghost"
            >
              <Trash2 />
              {t("remove")}
            </Button>
            <Button
              disabled={busy || !settings?.tokenConfigured}
              onClick={() => void testConnection()}
              type="button"
              variant="outline"
            >
              <Unplug />
              {t("test")}
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? <LoaderCircle className="animate-spin" /> : <Save />}
              {t("save")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
