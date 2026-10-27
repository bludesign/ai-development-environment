"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";

type Client = {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
};

async function readConnections(
  signal?: AbortSignal,
): Promise<{ enabled: boolean; clients: Client[] }> {
  const response = await fetch("/api/auth/mcp-connections", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Could not load connected applications");
  return response.json();
}

export function ConnectedApplicationsLink() {
  const t = useTranslations("mcpOAuth");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Link href="/system/connected-applications" className="underline">
            {t("connectionsTitle")}
          </Link>
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

export function ConnectedApplications() {
  const t = useTranslations("mcpOAuth");
  const [clients, setClients] = useState<Client[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const failureMessage = t("error");
  async function load() {
    try {
      const data = await readConnections();
      setClients(data.clients);
      setEnabled(data.enabled);
    } catch {
      setError(failureMessage);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void readConnections(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setClients(data.clients);
        setEnabled(data.enabled);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(failureMessage);
      });
    return () => controller.abort();
  }, [failureMessage]);
  async function disconnect(clientId: string) {
    setDisconnecting(clientId);
    setError(null);
    try {
      const response = await fetch("/api/auth/mcp-connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError(t("error"));
    } finally {
      setDisconnecting(null);
    }
  }
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("connectionsTitle")}</h1>
        <p className="mt-2 text-muted-foreground">
          {t("connectionsDescription")}
        </p>
      </div>
      {!enabled && <p>{t("disabled")}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {clients === null ? (
        error ? null : (
          <p>{t("loading")}</p>
        )
      ) : clients.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        clients.map((client) => (
          <Card key={client.clientId}>
            <CardHeader>
              <CardTitle>{client.name}</CardTitle>
              <p className="break-all text-sm text-muted-foreground">
                {client.clientId}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="list-inside list-disc">
                {client.scopes.map((scope) => (
                  <li key={scope}>
                    {t(
                      scope === "mcp:read"
                        ? "readPermission"
                        : scope === "mcp:write"
                          ? "writePermission"
                          : scope === "mcp:destructive"
                            ? "destructivePermission"
                            : "offlinePermission",
                    )}
                  </li>
                ))}
              </ul>
              <Button
                variant="destructive"
                disabled={disconnecting !== null}
                onClick={() => void disconnect(client.clientId)}
              >
                {t("disconnect")}
              </Button>
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}
