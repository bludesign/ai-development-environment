"use client";

import {
  CheckCircle2,
  GitPullRequest,
  Save,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { JiraSettingsPage } from "@/components/jira/settings-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubSettingsView, GitHubViewer } from "@/services/github/types";

const SETTINGS_FIELDS = "tokenConfigured updatedAt";

export function SettingsPage() {
  const t = useTranslations("settings");
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <JiraSettingsPage embedded />
      <GitHubSettingsCard />
    </section>
  );
}

function GitHubSettingsCard() {
  const t = useTranslations("githubSettings");
  const tc = useTranslations("common");
  const [settings, setSettings] = useState<GitHubSettingsView | null>(null);
  const [apiToken, setApiToken] = useState("");
  const [connection, setConnection] = useState<GitHubViewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = (next: GitHubSettingsView) => {
    setSettings(next);
    setApiToken("");
  };

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        githubSettings: GitHubSettingsView;
      }>(`query GitHubSettings { githubSettings { ${SETTINGS_FIELDS} } }`);
      applySettings(data.githubSettings);
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
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveGitHubSettings: GitHubSettingsView;
      }>(
        `mutation SaveGitHubSettings($input: SaveGitHubSettingsInput!) {
          saveGitHubSettings(input: $input) { ${SETTINGS_FIELDS} }
        }`,
        { input: { apiToken: apiToken || null } },
      );
      applySettings(data.saveGitHubSettings);
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
        testGitHubConnection: GitHubViewer;
      }>(
        "mutation TestGitHubConnection { testGitHubConnection { login name avatarUrl url } }",
      );
      setConnection(data.testGitHubConnection);
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
        clearGitHubCredentials: GitHubSettingsView;
      }>(
        `mutation ClearGitHubCredentials {
          clearGitHubCredentials { ${SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.clearGitHubCredentials);
      setConnection(null);
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
              <GitPullRequest className="size-5" />
              <div>
                <h2 className="font-semibold">{t("title")}</h2>
                <p className="text-xs text-muted-foreground">
                  {t("description")}
                </p>
              </div>
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
              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="github-token"
                >
                  {t("apiToken")}
                </Label>
                <Input
                  autoComplete="new-password"
                  id="github-token"
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
              </div>
              {connection && (
                <Alert className="bg-muted">
                  <div>
                    <p className="font-medium">
                      {connection.name ?? connection.login}
                    </p>
                    <a
                      className="text-sm text-primary hover:underline"
                      href={connection.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      @{connection.login}
                    </a>
                  </div>
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <ConfirmationDialog
                  actionLabel={t("remove")}
                  cancelLabel={tc("cancel")}
                  description={t("confirmRemoveDescription")}
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
            </>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
