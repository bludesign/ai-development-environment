"use client";

import { useEffect, useRef, useState } from "react";
import { Plug, RefreshCw, ShieldCheck, ShieldOff, Unplug } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { formatDateValue } from "@/lib/date-format";
import type {
  McpConnection,
  McpConnectionAuthorization,
  McpConnectionsResponse,
} from "@/lib/mcp-connections";

type ConnectionAction = {
  client: McpConnection;
  authorization?: McpConnectionAuthorization;
};

const permissions = [
  { scope: "mcp:read", label: "readPermission", details: "readDetails" },
  { scope: "mcp:write", label: "writePermission", details: "writeDetails" },
  {
    scope: "mcp:destructive",
    label: "destructivePermission",
    details: "destructiveDetails",
  },
  {
    scope: "offline_access",
    label: "offlinePermission",
    details: "offlineDetails",
  },
] as const;

async function readConnections(
  signal?: AbortSignal,
): Promise<McpConnectionsResponse> {
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
        <p className="text-sm text-muted-foreground">
          {t("settingsDescription")}
        </p>
      </CardHeader>
    </Card>
  );
}

export function ConnectedApplications() {
  const t = useTranslations("mcpOAuth");
  const common = useTranslations("common");
  const locale = useLocale();
  const [clients, setClients] = useState<McpConnection[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<ConnectionAction | null>(
    null,
  );
  const [confirming, setConfirming] = useState<ConnectionAction | null>(null);
  const activeLoad = useRef<AbortController | null>(null);
  const failureMessage = t("error");

  async function load() {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await readConnections(controller.signal);
      if (controller.signal.aborted) return;
      setClients(data.clients);
      setEnabled(data.enabled);
    } catch {
      if (!controller.signal.aborted) setError(failureMessage);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    activeLoad.current = controller;
    void readConnections(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setClients(data.clients);
        setEnabled(data.enabled);
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(failureMessage);
        setLoading(false);
      });
    return () => activeLoad.current?.abort();
  }, [failureMessage]);

  async function revoke({ client, authorization }: ConnectionAction) {
    const clientId = client.clientId;
    setConfirming(null);
    setPendingAction({ client, authorization });
    setError(null);
    try {
      const response = await fetch("/api/auth/mcp-connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          authorization
            ? { clientId, authorizationId: authorization.id ?? null }
            : { clientId },
        ),
      });
      if (!response.ok) throw new Error();
      setClients(
        (current) =>
          current?.flatMap((connection) => {
            if (connection.clientId !== clientId) return [connection];
            if (!authorization) return [];
            const authorizations = connection.authorizations.filter(
              (item) => item.id !== authorization.id,
            );
            if (authorizations.length === 0) return [];
            return [
              {
                ...connection,
                authorizations,
                authorizationCount: authorizations.length,
                scopes: [
                  ...new Set(authorizations.flatMap((item) => item.scopes)),
                ],
                connectedAt: authorizations[0].authorizedAt,
                firstAuthorizedAt:
                  authorizations[authorizations.length - 1].authorizedAt,
              },
            ];
          }) ?? null,
      );
      await load();
    } catch {
      setError(failureMessage);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="mx-auto w-full max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold">{t("connectionsTitle")}</h1>
          <p className="mt-2 text-muted-foreground">
            {t("connectionsDescription")}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading || pendingAction !== null}
          onClick={() => void load()}
        >
          <RefreshCw
            className={loading ? "animate-spin" : undefined}
            aria-hidden="true"
          />
          {t("refresh")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        {enabled !== null && (
          <Badge variant={enabled ? "success" : "secondary"}>
            {t(enabled ? "oauthEnabled" : "oauthDisabled")}
          </Badge>
        )}
        {clients !== null && (
          <Badge variant="outline">
            {t("applicationCount", { count: clients.length })}
          </Badge>
        )}
      </div>
      {enabled === false && (
        <Alert>
          <AlertDescription>{t("disabledDetails")}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {clients === null ? (
        error ? null : (
          <p role="status">{t("loading")}</p>
        )
      ) : clients.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Plug className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">{t("empty")}</p>
            <p className="max-w-xl text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </CardContent>
        </Card>
      ) : (
        clients.map((client) => (
          <Card key={client.clientId}>
            <CardHeader className="gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  <Plug className="size-5" aria-hidden="true" />
                  {client.name}
                </CardTitle>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={loading || pendingAction !== null}
                  onClick={() => setConfirming({ client })}
                >
                  <Unplug aria-hidden="true" />
                  {t(
                    pendingAction?.client.clientId === client.clientId &&
                      !pendingAction.authorization
                      ? "disconnecting"
                      : "disconnect",
                  )}
                </Button>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t("clientId")}
                </p>
                <p className="mt-1 break-all font-mono text-xs">
                  {client.clientId}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <dl className="grid gap-4 rounded-lg bg-muted/50 p-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">
                    {t("firstAuthorized")}
                  </dt>
                  <dd className="mt-1 font-medium">
                    <time dateTime={client.firstAuthorizedAt}>
                      {formatDateValue(client.firstAuthorizedAt, "long", {
                        locale,
                      })}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("lastAuthorized")}
                  </dt>
                  <dd className="mt-1 font-medium">
                    <time dateTime={client.connectedAt}>
                      {formatDateValue(client.connectedAt, "long", { locale })}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("authorizations")}
                  </dt>
                  <dd className="mt-1 font-medium">
                    {client.authorizationCount}
                  </dd>
                </div>
              </dl>
              <div>
                <h2 className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  {t("grantedPermissions")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("permissionsDescription")}
                </p>
                <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                  {permissions
                    .filter(({ scope }) => client.scopes.includes(scope))
                    .map(({ scope, label, details }) => (
                      <li key={scope}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {t(label)}
                          </span>
                          <code className="text-xs text-muted-foreground">
                            {scope}
                          </code>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t(details)}
                        </p>
                      </li>
                    ))}
                </ul>
                {!client.scopes.includes("offline_access") && (
                  <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
                    {t("noOfflineAccess")}
                  </p>
                )}
              </div>
              <div className="space-y-3 border-t pt-4">
                <h2 className="font-medium">{t("authorizations")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("authorizationsDescription")}
                </p>
                <Table
                  aria-label={t("authorizationsFor", { client: client.name })}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("authorizedAt")}</TableHead>
                      <TableHead scope="col">
                        {t("grantedPermissions")}
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        {t("authorizationActions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {client.authorizations.map((authorization) => (
                      <TableRow key={authorization.id}>
                        <TableCell className="align-top whitespace-normal">
                          <time dateTime={authorization.authorizedAt}>
                            {formatDateValue(
                              authorization.authorizedAt,
                              "short",
                              { locale },
                            )}
                          </time>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <ul className="flex flex-wrap gap-2">
                            {authorization.scopes.map((scope) => {
                              const permission = permissions.find(
                                (item) => item.scope === scope,
                              );
                              return (
                                <li key={scope}>
                                  <Badge
                                    variant="outline"
                                    className="h-auto flex-wrap rounded-md py-1 whitespace-normal"
                                  >
                                    {permission && (
                                      <span>{t(permission.label)}</span>
                                    )}
                                    <code className="text-xs text-muted-foreground">
                                      {scope}
                                    </code>
                                  </Badge>
                                </li>
                              );
                            })}
                          </ul>
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={loading || pendingAction !== null}
                            aria-label={t("revokeAuthorizationLabel", {
                              client: client.name,
                              date: formatDateValue(
                                authorization.authorizedAt,
                                "short",
                                { locale },
                              ),
                            })}
                            onClick={() =>
                              setConfirming({ client, authorization })
                            }
                          >
                            <ShieldOff aria-hidden="true" />
                            {t(
                              pendingAction?.authorization?.id ===
                                authorization.id
                                ? "revoking"
                                : "revoke",
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("manageAccessTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div>
            <h2 className="mb-1 font-medium text-foreground">
              {t("changePermissionsTitle")}
            </h2>
            <p>{t("changePermissionsDescription")}</p>
          </div>
          <div>
            <h2 className="mb-1 font-medium text-foreground">
              {t("disconnectTitle")}
            </h2>
            <p>{t("disconnectDescription")}</p>
          </div>
          <p>{t("authorizationDetails")}</p>
        </CardContent>
      </Card>
      <ConfirmationDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t(
          confirming?.authorization
            ? "confirmRevokeAuthorization"
            : "confirmDisconnect",
          { client: confirming?.client.name ?? "" },
        )}
        description={
          confirming?.authorization
            ? t("revokeAuthorizationDescription", {
                date: formatDateValue(
                  confirming.authorization.authorizedAt,
                  "long",
                  { locale },
                ),
              })
            : t("disconnectDescription")
        }
        actionLabel={t(confirming?.authorization ? "revoke" : "disconnect")}
        cancelLabel={common("cancel")}
        onConfirm={() => (confirming ? revoke(confirming) : undefined)}
      />
    </section>
  );
}
