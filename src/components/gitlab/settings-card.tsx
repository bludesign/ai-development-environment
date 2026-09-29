"use client";

import {
  CheckCircle2,
  ExternalLink,
  GitFork,
  Save,
  Trash2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useCredentialStoreReadOnly } from "@/hooks/use-credential-store-read-only";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitLabSettingsView } from "@/services/gitlab";

const SETTINGS_FIELDS =
  "configured tokenConfigured baseUrl version revision pipelinePollIntervalSeconds cacheTtlSeconds memberProjectsOnly defaultSquash defaultMoveTicketToDone defaultDeleteWorktree verifiedAt updatedAt viewer { id username name avatarUrl webUrl }";

function announceChange() {
  window.dispatchEvent(new Event("source-control-settings-changed"));
}

export function GitLabSettingsCard() {
  const t = useTranslations("gitlabSettings");
  const common = useTranslations("common");
  const credentialsReadOnly = useCredentialStoreReadOnly();
  const [settings, setSettings] = useState<GitLabSettingsView | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [pollInterval, setPollInterval] = useState(60);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applySettings = useCallback((next: GitLabSettingsView) => {
    setSettings(next);
    setBaseUrl(next.baseUrl ?? "https://gitlab.com");
    setPollInterval(next.pipelinePollIntervalSeconds);
    setToken("");
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        gitlabSettings: GitLabSettingsView;
      }>(`query GitLabSettingsCard {
        gitlabSettings { ${SETTINGS_FIELDS} }
      }`);
      applySettings(data.gitlabSettings);
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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveGitLabSettings: GitLabSettingsView;
      }>(
        `mutation SaveGitLabSettings($input: SaveGitLabSettingsInput!) {
          saveGitLabSettings(input: $input) { ${SETTINGS_FIELDS} }
        }`,
        {
          input: {
            baseUrl: baseUrl.trim(),
            accessToken: token || null,
            pipelinePollIntervalSeconds: pollInterval,
          },
        },
      );
      applySettings(data.saveGitLabSettings);
      setError(null);
      setNotice(t("saved"));
      announceChange();
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
        testGitLabConnection: GitLabSettingsView;
      }>(
        `mutation TestGitLabConnection { testGitLabConnection { ${SETTINGS_FIELDS} } }`,
      );
      applySettings(data.testGitLabConnection);
      setError(null);
      setNotice(t("connectionSucceeded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        clearGitLabCredentials: GitLabSettingsView;
      }>(
        `mutation ClearGitLabCredentials { clearGitLabCredentials { ${SETTINGS_FIELDS} } }`,
      );
      applySettings(data.clearGitLabCredentials);
      setError(null);
      setNotice(t("removed"));
      announceChange();
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
              <GitFork className="size-5" />
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
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t("loading")}
            </p>
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
                <Label className="mb-1.5 block" htmlFor="gitlab-base-url">
                  {t("baseUrl")}
                </Label>
                <Input
                  disabled={credentialsReadOnly}
                  id="gitlab-base-url"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://gitlab.com"
                  required
                  type="url"
                  value={baseUrl}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("baseUrlHelp")}
                </p>
              </div>
              <div>
                <Label className="mb-1.5 block" htmlFor="gitlab-token">
                  {t("accessToken")}
                </Label>
                <Input
                  autoComplete="new-password"
                  disabled={credentialsReadOnly}
                  id="gitlab-token"
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={
                    settings?.tokenConfigured
                      ? t("tokenConfiguredPlaceholder")
                      : t("tokenPlaceholder")
                  }
                  required={!settings?.tokenConfigured && !credentialsReadOnly}
                  type="password"
                  value={token}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("tokenHelp")}
                </p>
              </div>
              <div>
                <Label className="mb-1.5 block" htmlFor="gitlab-poll-interval">
                  {t("pollInterval")}
                </Label>
                <Input
                  id="gitlab-poll-interval"
                  max={3600}
                  min={30}
                  onChange={(event) =>
                    setPollInterval(Number(event.target.value))
                  }
                  required
                  type="number"
                  value={pollInterval}
                />
              </div>
              {settings?.viewer && (
                <Alert>
                  <AlertDescription>
                    <a
                      className="font-medium text-primary hover:underline"
                      href={settings.viewer.webUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {settings.viewer.name} (@{settings.viewer.username}){" "}
                      <ExternalLink className="inline size-3" />
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {t("version", { version: settings.version ?? "—" })}
                    </p>
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <ConfirmationDialog
                  actionLabel={t("remove")}
                  cancelLabel={common("cancel")}
                  description={t("confirmRemoveDescription")}
                  onConfirm={clear}
                  title={t("confirmRemove")}
                  trigger={
                    <Button
                      disabled={
                        busy || !settings?.configured || credentialsReadOnly
                      }
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
                <Button disabled={busy || credentialsReadOnly} type="submit">
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
