"use client";

import { CheckCircle2, KeyRound, Save, Trash2, Unplug } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { SettingsHelpLink } from "@/components/settings-help-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraSettingsView } from "@/services/jira/types";

const SETTINGS_FIELDS =
  "siteUrl email tokenConfigured cacheTtlSeconds updatedAt";

type ConnectionResult = {
  accountId: string | null;
  displayName: string;
  emailAddress: string | null;
};

export function JiraSettingsPage({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const t = useTranslations("jiraSettings");
  const tc = useTranslations("common");
  const [settings, setSettings] = useState<JiraSettingsView | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmSiteChangeOpen, setConfirmSiteChangeOpen] = useState(false);

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

  const persistSettings = async (siteChanged: boolean) => {
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

  const save = (event: FormEvent) => {
    event.preventDefault();
    const siteChanged = Boolean(
      settings?.siteUrl &&
      settings.siteUrl !== siteUrl.trim().replace(/\/$/, ""),
    );
    if (siteChanged) {
      setConfirmSiteChangeOpen(true);
      return;
    }
    void persistSettings(false);
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
    <section
      className={
        embedded
          ? "flex w-full flex-col gap-6"
          : "mx-auto flex w-full max-w-3xl flex-col gap-6"
      }
    >
      {!embedded && (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      ) : (
        <form onSubmit={save}>
          <Card>
            <CardContent className="space-y-5">
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
                  {settings?.tokenConfigured
                    ? t("configured")
                    : t("notConfigured")}
                </Badge>
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
              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="jira-site-url"
                >
                  {t("siteUrl")}
                </Label>
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
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="jira-email"
                >
                  {t("email")}
                </Label>
                <Input
                  autoComplete="username"
                  id="jira-email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("accountHelp")}
                </p>
              </div>
              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="jira-token"
                >
                  {t("apiToken")}
                </Label>
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
                  {settings?.tokenConfigured
                    ? t("tokenKeepHelp")
                    : t("tokenHelp")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("tokenAcquireHelp")}{" "}
                  <SettingsHelpLink href="https://id.atlassian.com/manage-profile/security/api-tokens">
                    {t("createToken")}
                  </SettingsHelpLink>
                </p>
              </div>
              {connection && (
                <Alert className="bg-muted">
                  <div>
                    <p className="font-medium">{connection.displayName}</p>
                    <p className="text-muted-foreground">
                      {connection.emailAddress ?? connection.accountId}
                    </p>
                  </div>
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <ConfirmationDialog
                  actionLabel={t("remove")}
                  cancelLabel={tc("cancel")}
                  description={tc("cannotBeUndone")}
                  onConfirm={clearCredentials}
                  title={t("confirmRemove")}
                  trigger={
                    <Button
                      disabled={busy || !settings?.tokenConfigured}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                      {t("remove")}
                    </Button>
                  }
                />
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
                  {busy ? <Spinner /> : <Save />}
                  {t("save")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </form>
      )}
      <ConfirmationDialog
        actionLabel={tc("continue")}
        cancelLabel={tc("cancel")}
        description={tc("cannotBeUndone")}
        onConfirm={() => persistSettings(true)}
        onOpenChange={setConfirmSiteChangeOpen}
        open={confirmSiteChangeOpen}
        title={t("confirmSiteChange")}
      />
    </section>
  );
}
