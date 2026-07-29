"use client";

import {
  CheckCircle2,
  Copy,
  KeyRound,
  RefreshCw,
  Save,
  Trash2,
  Unplug,
  Webhook,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
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
import { useCredentialStoreReadOnly } from "@/hooks/use-credential-store-read-only";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { formatDateValue } from "@/lib/date-format";
import type {
  JiraSettingsView,
  JiraWebhookSecretView,
  JiraWebhookSettingsView,
} from "@/services/jira/types";

const SETTINGS_FIELDS =
  "siteUrl email tokenConfigured cacheTtlSeconds updatedAt";

const WEBHOOK_FIELDS =
  "enabled secretConfigured registered registrationId registeredUrl jql configuredAt lastReceivedAt lastOutcome lastError";

const RECOMMENDED_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "worklog_created",
  "attachment_created",
  "issuelink_created",
  "sprint_started",
  "sprint_closed",
].join(", ");

type ConnectionResult = {
  accountId: string | null;
  displayName: string;
  emailAddress: string | null;
};

function CopyField({
  label,
  value,
  copyLabel,
  copiedLabel,
  help,
  mono = false,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  help: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the value stays selectable either way.
    }
  };

  return (
    <div>
      <Label className="mb-1.5 block text-sm font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          className={mono ? "font-mono text-xs" : undefined}
          onFocus={(event) => event.target.select()}
          readOnly
          value={value}
        />
        <Button onClick={() => void copy()} type="button" variant="outline">
          {copied ? <CheckCircle2 /> : <Copy />}
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * Registers the webhook in Jira over the classic REST API, which takes the same
 * API token as every other Jira call, and falls back to minting a bare signing
 * secret for sites where that token's user is not a Jira admin.
 */
function JiraWebhookCard() {
  const t = useTranslations("jiraSettings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const credentialsReadOnly = useCredentialStoreReadOnly();
  const [webhook, setWebhook] = useState<JiraWebhookSettingsView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [jql, setJql] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        jiraWebhookSettings: JiraWebhookSettingsView;
      }>(`query { jiraWebhookSettings { ${WEBHOOK_FIELDS} } }`);
      setWebhook(data.jiraWebhookSettings);
      // Registration owns these values once it succeeds, so the fields follow
      // what Jira actually has rather than what was last typed.
      if (data.jiraWebhookSettings.registeredUrl) {
        setWebhookUrl(data.jiraWebhookSettings.registeredUrl);
      }
      setJql(data.jiraWebhookSettings.jql ?? "");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setWebhookUrl(
        `${window.location.origin.replace(/\/$/, "")}/api/public/jira/webhook`,
      );
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  // Keep the last-delivery line honest while the user is still on the page
  // wiring the webhook up in Jira.
  useEffect(() => {
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription { jiraWebhookDeliveryChanged { deliveryId } }" },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => unsubscribe();
  }, [load]);

  const run = async (
    mutation: string,
    key:
      "enableJiraWebhook" | "registerJiraWebhook" | "rotateJiraWebhookSecret",
    successMessage: string,
    variables?: Record<string, unknown>,
  ) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<
        Record<string, JiraWebhookSecretView>
      >(mutation, variables);
      const result = data[key]!;
      setWebhook(result.settings);
      setSecret(result.secret);
      setError(null);
      setNotice(successMessage);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        disableJiraWebhook: JiraWebhookSettingsView;
      }>(`mutation { disableJiraWebhook { ${WEBHOOK_FIELDS} } }`);
      setWebhook(data.disableJiraWebhook);
      setSecret(null);
      setError(null);
      setNotice(t("webhookDisabled"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const configured = webhook?.secretConfigured ?? false;
  const registered = webhook?.registered ?? false;

  const register = () =>
    run(
      `mutation Register($input: RegisterJiraWebhookInput!) { registerJiraWebhook(input: $input) { secret settings { ${WEBHOOK_FIELDS} } } }`,
      "registerJiraWebhook",
      registered ? t("webhookReregistered") : t("webhookRegisteredNotice"),
      { input: { url: webhookUrl, jql: jql.trim() || null } },
    );

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Webhook className="size-5" />
            <h2 className="font-semibold">{t("webhookTitle")}</h2>
          </div>
          <Badge
            className={
              configured
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : undefined
            }
          >
            {registered
              ? t("webhookRegistered")
              : configured
                ? t("webhookConfigured")
                : t("webhookNotConfigured")}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("webhookDescription")}
        </p>

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
            htmlFor="jira-webhook-url"
          >
            {t("webhookUrl")}
          </Label>
          <Input
            disabled={busy || credentialsReadOnly}
            id="jira-webhook-url"
            onChange={(event) => setWebhookUrl(event.target.value)}
            value={webhookUrl}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("webhookUrlHelp")}
          </p>
        </div>

        <div>
          <Label
            className="mb-1.5 block text-sm font-medium"
            htmlFor="jira-webhook-jql"
          >
            {t("webhookJql")}
          </Label>
          <Input
            disabled={busy || credentialsReadOnly}
            id="jira-webhook-jql"
            onChange={(event) => setJql(event.target.value)}
            placeholder="project in (ABC, XYZ)"
            value={jql}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("webhookJqlHelp")}
          </p>
        </div>

        {secret && !registered ? (
          <CopyField
            copiedLabel={t("copied")}
            copyLabel={t("copy")}
            help={t("webhookSecretHelp")}
            label={t("webhookSecret")}
            mono
            value={secret}
          />
        ) : (
          <div>
            <Label className="mb-1.5 block text-sm font-medium">
              {t("webhookSecret")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {registered
                ? t("webhookSecretRegistered")
                : configured
                  ? t("webhookSecretHelp")
                  : t("webhookSecretPending")}
            </p>
          </div>
        )}

        {registered ? (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p>
              {t("webhookRegisteredAs", {
                id: webhook?.registrationId ?? "—",
              })}
            </p>
            <p className="mt-2">
              <SettingsHelpLink href="https://developer.atlassian.com/cloud/jira/platform/webhooks/">
                {t("webhookDocs")}
              </SettingsHelpLink>
            </p>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/40 p-3 text-xs">
            <p className="mb-2 font-medium">{t("setupTitle")}</p>
            <p className="mb-2 text-muted-foreground">{t("manualIntro")}</p>
            <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
              <li>{t("setupStep1")}</li>
              <li>{t("setupStep2")}</li>
              <li>{t("setupStep3", { events: RECOMMENDED_EVENTS })}</li>
              <li>{t("setupStep4", { jql: "project in (ABC, XYZ)" })}</li>
            </ol>
            <p className="mt-2">
              <SettingsHelpLink href="https://developer.atlassian.com/cloud/jira/platform/webhooks/">
                {t("webhookDocs")}
              </SettingsHelpLink>
            </p>
          </div>
        )}

        {webhook?.lastReceivedAt && (
          <div className="text-xs text-muted-foreground">
            <p>
              {t("lastWebhook", {
                date: formatDateValue(webhook.lastReceivedAt, "short", {
                  locale,
                }),
                outcome: webhook.lastOutcome ?? "—",
              })}
            </p>
            {webhook.lastError && (
              <p className="mt-1 text-destructive">{webhook.lastError}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {configured && (
            <Button asChild className="mr-auto" variant="link">
              <Link href="/jira-webhooks">{t("viewDeliveries")}</Link>
            </Button>
          )}
          {configured && (
            <ConfirmationDialog
              actionLabel={t("disableWebhook")}
              cancelLabel={tc("cancel")}
              description={t("confirmDisableDescription")}
              onConfirm={disable}
              title={t("confirmDisable")}
              trigger={
                <Button
                  disabled={busy || credentialsReadOnly}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                  {t("disableWebhook")}
                </Button>
              }
            />
          )}
          {configured && (
            <ConfirmationDialog
              actionLabel={t("rotateWebhook")}
              cancelLabel={tc("cancel")}
              description={
                registered
                  ? t("confirmRotateRegisteredDescription")
                  : t("confirmRotateDescription")
              }
              onConfirm={() =>
                run(
                  `mutation { rotateJiraWebhookSecret { secret settings { ${WEBHOOK_FIELDS} } } }`,
                  "rotateJiraWebhookSecret",
                  registered ? t("webhookRotatedInJira") : t("webhookRotated"),
                )
              }
              title={t("confirmRotate")}
              trigger={
                <Button
                  disabled={busy || credentialsReadOnly}
                  type="button"
                  variant="ghost"
                >
                  {busy ? <Spinner /> : <RefreshCw />}
                  {t("rotateWebhook")}
                </Button>
              }
            />
          )}
          {!configured && (
            <Button
              disabled={busy || credentialsReadOnly}
              onClick={() =>
                void run(
                  `mutation { enableJiraWebhook { secret settings { ${WEBHOOK_FIELDS} } } }`,
                  "enableJiraWebhook",
                  t("webhookEnabled"),
                )
              }
              type="button"
              variant="outline"
            >
              {busy ? <Spinner /> : <KeyRound />}
              {t("enableWebhook")}
            </Button>
          )}
          <Button
            disabled={busy || credentialsReadOnly || !webhookUrl.trim()}
            onClick={() => void register()}
            type="button"
          >
            {busy ? <Spinner /> : <Webhook />}
            {registered ? t("updateRegistration") : t("registerWebhook")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function JiraSettingsPage({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const t = useTranslations("jiraSettings");
  const tc = useTranslations("common");
  const tCredentials = useTranslations("credentials");
  const credentialsReadOnly = useCredentialStoreReadOnly();
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
                  disabled={credentialsReadOnly}
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
                  disabled={credentialsReadOnly}
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
                  disabled={credentialsReadOnly}
                  id="jira-token"
                  onChange={(event) => setApiToken(event.target.value)}
                  placeholder={
                    settings?.tokenConfigured
                      ? t("tokenPlaceholderConfigured")
                      : t("tokenPlaceholder")
                  }
                  required={!settings?.tokenConfigured && !credentialsReadOnly}
                  type="password"
                  value={apiToken}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {credentialsReadOnly
                    ? tCredentials("readOnlyNotice")
                    : settings?.tokenConfigured
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
                      disabled={
                        busy ||
                        !settings?.tokenConfigured ||
                        credentialsReadOnly
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
                  disabled={busy || !settings?.tokenConfigured}
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
            </CardContent>
          </Card>
        </form>
      )}
      {!loading && settings?.tokenConfigured && <JiraWebhookCard />}
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
