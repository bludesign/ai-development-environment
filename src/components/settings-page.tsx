"use client";

import {
  CheckCircle2,
  Code2,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  RotateCw,
  Save,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { DragEvent, FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { JiraSettingsPage } from "@/components/jira/settings-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitHubAppSettingsView,
  GitHubSettingsView,
  GitHubViewer,
} from "@/services/github/types";

const SETTINGS_FIELDS = "tokenConfigured defaultJiraKeyRegex updatedAt";
const APP_SETTINGS_FIELDS =
  "configured appId installationId privateKeyConfigured keyFingerprint appSlug accountLogin repositorySelection actionsPermission verifiedAt updatedAt";

export function SettingsPage() {
  const t = useTranslations("settings");
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <EditorSettingsCard />
      <JiraSettingsPage embedded />
      <GitHubSettingsCard />
      <GitHubAppSettingsCard />
    </section>
  );
}

function EditorSettingsCard() {
  const t = useTranslations("editorSettings");
  const [editorVariant, setEditorVariant] = useState<
    "CODE" | "CODE_INSIDERS" | "NONE"
  >("CODE");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void controlPlaneRequest<{
        worktreeSettings: {
          editorVariant: "CODE" | "CODE_INSIDERS" | "NONE";
        };
      }>("query EditorSettings { worktreeSettings { editorVariant } }")
        .then((data) => setEditorVariant(data.worktreeSettings.editorVariant))
        .catch((value) =>
          setError(value instanceof Error ? value.message : String(value)),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        `mutation SaveEditorSettings($editorVariant: WorktreeEditorVariant!) {
          saveWorktreeSettings(editorVariant: $editorVariant) { editorVariant }
        }`,
        { editorVariant },
      );
      setNotice(t("saved"));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="size-5" />
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
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loading")}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1 space-y-2">
              <Label htmlFor="editor-variant">{t("label")}</Label>
              <Select
                onValueChange={(value) =>
                  setEditorVariant(value as "CODE" | "CODE_INSIDERS" | "NONE")
                }
                value={editorVariant}
              >
                <SelectTrigger className="w-full" id="editor-variant">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CODE">{t("code")}</SelectItem>
                  <SelectItem value="CODE_INSIDERS">{t("insiders")}</SelectItem>
                  <SelectItem value="NONE">{t("none")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? <Spinner /> : <Save />} {t("save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GitHubAppSettingsCard() {
  const t = useTranslations("githubAppSettings");
  const tc = useTranslations("common");
  const [settings, setSettings] = useState<GitHubAppSettingsView | null>(null);
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [draggingPem, setDraggingPem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applySettings = useCallback((next: GitHubAppSettingsView) => {
    setSettings(next);
    setAppId(next.appId ?? "");
    setInstallationId(next.installationId ?? "");
    setPrivateKey("");
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        githubAppSettings: GitHubAppSettingsView;
      }>(
        `query GitHubAppSettings { githubAppSettings { ${APP_SETTINGS_FIELDS} } }`,
      );
      applySettings(data.githubAppSettings);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDeploymentUrl(window.location.origin);
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveGitHubAppSettings: GitHubAppSettingsView;
      }>(
        `mutation SaveGitHubAppSettings($input: SaveGitHubAppSettingsInput!) {
          saveGitHubAppSettings(input: $input) { ${APP_SETTINGS_FIELDS} }
        }`,
        {
          input: {
            appId: appId.trim(),
            installationId: installationId.trim(),
            privateKey: privateKey || null,
          },
        },
      );
      applySettings(data.saveGitHubAppSettings);
      setError(null);
      setNotice(privateKey && settings?.configured ? t("rotated") : t("saved"));
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
        testGitHubAppConnection: GitHubAppSettingsView;
      }>(
        `mutation TestGitHubAppConnection {
          testGitHubAppConnection { ${APP_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.testGitHubAppConnection);
      setError(null);
      setNotice(t("connectionSucceeded"));
    } catch (value) {
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
        clearGitHubAppCredentials: GitHubAppSettingsView;
      }>(
        `mutation ClearGitHubAppCredentials {
          clearGitHubAppCredentials { ${APP_SETTINGS_FIELDS} }
        }`,
      );
      applySettings(data.clearGitHubAppCredentials);
      setError(null);
      setNotice(t("removed"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const loadPemFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pem")) {
      setError(t("pemFileInvalid"));
      setNotice(null);
      return;
    }
    try {
      const contents = await file.text();
      if (
        !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(contents) ||
        !/-----END (?:RSA )?PRIVATE KEY-----/.test(contents)
      ) {
        setError(t("pemFileInvalid"));
        setNotice(null);
        return;
      }
      setPrivateKey(contents);
      setError(null);
      setNotice(t("pemFileLoaded", { filename: file.name }));
    } catch {
      setError(t("pemFileReadError"));
      setNotice(null);
    }
  };

  const dropPemFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingPem(false);
    const file = event.dataTransfer.files.item(0);
    if (file) void loadPemFile(file);
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5" />
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
              {settings?.configured ? t("verified") : t("notConfigured")}
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

              <div className="rounded-lg border bg-muted/30 p-4">
                <h3 className="font-medium">{t("setupTitle")}</h3>
                <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
                  <li>
                    {t("stepRegister")}{" "}
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href="https://github.com/settings/apps/new"
                      rel="noreferrer"
                      target="_blank"
                    >
                      {t("registerLink")}
                      <ExternalLink className="size-3" />
                    </a>
                  </li>
                  <li>
                    {t("stepHomepage")}{" "}
                    <code className="break-all rounded bg-muted px-1 py-0.5 text-xs text-foreground">
                      {deploymentUrl}
                    </code>
                    {t("stepHomepageSuffix")}
                  </li>
                  <li>{t("stepPermissions")}</li>
                  <li>{t("stepInstall")}</li>
                  <li>
                    {t("stepInstallationId")}{" "}
                    <code className="break-all rounded bg-muted px-1 py-0.5 text-xs text-foreground">
                      https://github.com/organizations/&lt;Organization-name&gt;/settings/installations/&lt;ID&gt;
                    </code>
                    {t("stepInstallationIdSuffix")}
                  </li>
                  <li>{t("stepCredentials")}</li>
                </ol>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label
                    className="mb-1.5 block text-sm font-medium"
                    htmlFor="github-app-id"
                  >
                    {t("appId")}
                  </Label>
                  <Input
                    id="github-app-id"
                    inputMode="numeric"
                    onChange={(event) => setAppId(event.target.value)}
                    placeholder={t("appIdPlaceholder")}
                    required
                    value={appId}
                  />
                </div>
                <div>
                  <Label
                    className="mb-1.5 block text-sm font-medium"
                    htmlFor="github-installation-id"
                  >
                    {t("installationId")}
                  </Label>
                  <Input
                    id="github-installation-id"
                    inputMode="numeric"
                    onChange={(event) => setInstallationId(event.target.value)}
                    placeholder={t("installationIdPlaceholder")}
                    required
                    value={installationId}
                  />
                </div>
              </div>

              <div>
                <Label
                  className="mb-1.5 block text-sm font-medium"
                  htmlFor="github-app-private-key"
                >
                  {t("privateKey")}
                </Label>
                <div
                  aria-label={t("privateKeyDropZone")}
                  className={`rounded-md border border-dashed p-2 transition-colors ${
                    draggingPem ? "border-primary bg-primary/5" : "border-input"
                  }`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDraggingPem(true);
                  }}
                  onDragLeave={() => setDraggingPem(false)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDraggingPem(true);
                  }}
                  onDrop={dropPemFile}
                  role="group"
                >
                  <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Upload className="size-3.5" />
                    {t("pemDropHint")}
                  </p>
                  <Textarea
                    autoComplete="new-password"
                    className="min-h-40 border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                    id="github-app-private-key"
                    onChange={(event) => setPrivateKey(event.target.value)}
                    placeholder={
                      settings?.privateKeyConfigured
                        ? t("privateKeyPlaceholderConfigured")
                        : t("privateKeyPlaceholder")
                    }
                    required={!settings?.privateKeyConfigured}
                    value={privateKey}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {settings?.privateKeyConfigured
                    ? t("privateKeyKeepHelp")
                    : t("privateKeyHelp")}
                </p>
              </div>

              {settings?.configured && (
                <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  <KeyRound />
                  <AlertDescription className="text-emerald-700 dark:text-emerald-300">
                    <p className="font-medium">
                      {t("connectedAs", {
                        app: settings.appSlug ?? "—",
                        account: settings.accountLogin ?? "—",
                      })}
                    </p>
                    <p className="mt-1 text-xs">
                      {t("connectionDetails", {
                        permission: settings.actionsPermission ?? "—",
                        selection: settings.repositorySelection ?? "—",
                      })}
                    </p>
                    {settings.verifiedAt && (
                      <p className="mt-1 text-xs">
                        {t("lastVerified", {
                          date: new Date(settings.verifiedAt).toLocaleString(),
                        })}
                      </p>
                    )}
                    {settings.keyFingerprint && (
                      <p className="mt-1 break-all font-mono text-xs">
                        {settings.keyFingerprint}
                      </p>
                    )}
                  </AlertDescription>
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
                  {busy ? (
                    <Spinner />
                  ) : privateKey && settings?.configured ? (
                    <RotateCw />
                  ) : (
                    <Save />
                  )}
                  {privateKey && settings?.configured ? t("rotate") : t("save")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </form>
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
