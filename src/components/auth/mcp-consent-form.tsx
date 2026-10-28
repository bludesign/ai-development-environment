"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { authClient } from "@/services/auth/auth-client";
import { selectedMcpScopes } from "@/lib/mcp-scopes";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function McpConsentForm({
  clientId,
  clientName,
  oauthQuery,
  requestedScopes,
}: {
  clientId: string;
  clientName: string;
  oauthQuery: string;
  requestedScopes: string[];
}) {
  const t = useTranslations("mcpOAuth");
  const [write, setWrite] = useState(false);
  const [destructive, setDestructive] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function consent(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.oauth2.consent({
        accept,
        scope: selectedMcpScopes(
          requestedScopes,
          write,
          destructive,
          offline,
        ).join(" "),
        oauth_query: oauthQuery,
      });
      if (result.error) {
        setError(result.error.message ?? t("error"));
        setPending(false);
        return;
      }
      if (result.data?.url) window.location.assign(result.data.url);
      else {
        setError(t("error"));
        setPending(false);
      }
    } catch {
      setError(t("error"));
      setPending(false);
    }
  }
  return (
    <main className="flex h-dvh overflow-auto bg-muted/30 p-6">
      <Card className="m-auto w-full max-w-lg shrink-0">
        <CardHeader>
          <CardTitle>{t("consentTitle", { client: clientName })}</CardTitle>
          <CardDescription className="break-all">{clientId}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <p>{t("consentDescription")}</p>
          <p>
            {t(
              requestedScopes.includes("mcp:read")
                ? "readDescription"
                : "readRequired",
            )}
          </p>
          {requestedScopes.includes("mcp:write") && (
            <label className="flex gap-3">
              <input
                type="checkbox"
                checked={write}
                onChange={(event) => {
                  setWrite(event.target.checked);
                  if (!event.target.checked) setDestructive(false);
                }}
              />
              {t("writeDescription")}
            </label>
          )}
          {requestedScopes.includes("mcp:destructive") && (
            <label className="flex gap-3">
              <input
                type="checkbox"
                checked={destructive}
                disabled={!write}
                onChange={(event) => setDestructive(event.target.checked)}
              />
              {t("destructiveDescription")}
            </label>
          )}
          {requestedScopes.includes("offline_access") && (
            <label className="flex gap-3">
              <input
                type="checkbox"
                checked={offline}
                onChange={(event) => setOffline(event.target.checked)}
              />
              {t("offlineDescription")}
            </label>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <Button
              disabled={pending || !requestedScopes.includes("mcp:read")}
              onClick={() => void consent(true)}
            >
              {t("allow")}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void consent(false)}
            >
              {t("deny")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
