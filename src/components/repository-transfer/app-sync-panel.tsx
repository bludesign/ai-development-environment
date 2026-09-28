"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { TransferDestinationEditor } from "./destination-editor";
import { TransferOperationStatus } from "./operation-status";
import {
  SYNC_OVERVIEW_FIELDS,
  TRANSFER_OPERATION_FIELDS,
  type SyncOverview,
  type TransferDestinationInput,
  type TransferOperation,
} from "./types";

export function AppSyncPanel({ appId }: { appId: string }) {
  const t = useTranslations("repositoryTransfer");
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [destinations, setDestinations] = useState<TransferDestinationInput[]>(
    [],
  );
  const [operation, setOperation] = useState<TransferOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<{ id: string; fingerprint: string } | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<{
          appRepositorySync: SyncOverview;
        }>(
          `query AppRepositorySync($appId: ID!) { appRepositorySync(appId: $appId) { ${SYNC_OVERVIEW_FIELDS} } }`,
          { appId },
          { signal },
        );
        if (signal?.aborted) return;
        setOverview(data.appRepositorySync);
        setError(null);
      } catch (value) {
        if (!signal?.aborted)
          setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [appId],
  );
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void load(controller.signal);
    };
    const recovery = onControlPlaneRecovery(refresh);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      {
        query:
          "subscription AppSyncCodebasesChanged { codebaseOverviewChanged { repositoryId } }",
      },
      { next: refresh, error: () => undefined, complete: () => undefined },
    );
    refresh();
    return () => {
      controller.abort();
      recovery();
      unsubscribe();
    };
  }, [load]);
  const sync = async () => {
    if (!overview || !destinations.length) return;
    setBusy(true);
    setError(null);
    request.current ??= {
      id: createClientId(),
      fingerprint: overview.fingerprint,
    };
    try {
      const data = await controlPlaneRequest<{
        syncAppRepositories: TransferOperation;
      }>(
        `mutation SyncAppRepositories($appId: ID!, $destinations: [RepositoryTransferDestinationInput!]!, $fingerprint: String!, $requestId: ID!) { syncAppRepositories(appId: $appId, destinations: $destinations, fingerprint: $fingerprint, requestId: $requestId) { ${TRANSFER_OPERATION_FIELDS} } }`,
        {
          appId,
          destinations,
          fingerprint: request.current.fingerprint,
          requestId: request.current.id,
        },
      );
      setOperation(data.syncAppRepositories);
      setDestinations([]);
      request.current = null;
      await load();
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      setError(message);
      if (/coverage changed|review the destinations again/i.test(message)) {
        request.current = null;
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("syncTitle")}</CardTitle>
        <CardDescription>{t("syncDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {operation && (
          <TransferOperationStatus
            key={operation.id}
            initial={operation}
            onChanged={() => {
              void load();
            }}
          />
        )}
        {loading ? (
          <p className="flex items-center gap-2">
            <Spinner />
            {t("loading")}
          </p>
        ) : (
          overview && (
            <>
              <TransferDestinationEditor
                agents={overview.agents}
                repositories={overview.repositories}
                destinations={destinations}
                coverage={overview.destinations}
                onChange={(value) => {
                  setDestinations(value);
                  request.current = null;
                }}
                disabled={busy}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  disabled={busy}
                  onClick={() => void load()}
                  variant="outline"
                >
                  <RefreshCw />
                  {t("refresh")}
                </Button>
                <Button
                  disabled={busy || !destinations.length}
                  onClick={() => void sync()}
                >
                  {busy ? <Spinner /> : <RefreshCw />}
                  {t("cloneSelected", { count: destinations.length })}
                </Button>
              </div>
            </>
          )
        )}
      </CardContent>
    </Card>
  );
}
