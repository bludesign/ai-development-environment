"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import { TRANSFER_OPERATION_FIELDS, type TransferOperation } from "./types";

const PENDING = new Set([
  "QUEUED",
  "PENDING",
  "RUNNING",
  "CLONING",
  "APPLYING",
  "RETRYING",
]);
const FAILED = new Set([
  "FAILED",
  "PARTIAL",
  "PARTIALLY_FAILED",
  "PARTIAL_FAILURE",
  "TIMED_OUT",
  "CANCELLED",
]);

export function TransferOperationStatus({
  initial,
  onChanged,
}: {
  initial: TransferOperation;
  onChanged?: (operation: TransferOperation) => void;
}) {
  const t = useTranslations("repositoryTransfer");
  const [operation, setOperation] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const changed = useRef(onChanged);
  const retryRequestId = useRef<string | null>(null);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    const controller = new AbortController();
    const receive = (value: TransferOperation) => {
      if (controller.signal.aborted) return;
      setOperation(value);
      changed.current?.(value);
    };
    const refresh = async () => {
      try {
        const data = await controlPlaneRequest<{
          repositoryTransferOperation: TransferOperation | null;
        }>(
          `query RepositoryTransferOperation($id: ID!) { repositoryTransferOperation(id: $id) { ${TRANSFER_OPERATION_FIELDS} } }`,
          { id: operation.id },
          { signal: controller.signal },
        );
        if (data.repositoryTransferOperation)
          receive(data.repositoryTransferOperation);
      } catch (value) {
        if (!controller.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      }
    };
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      repositoryTransferChanged: TransferOperation;
    }>(
      {
        query: `subscription RepositoryTransferChanged($operationId: ID!) { repositoryTransferChanged(operationId: $operationId) { ${TRANSFER_OPERATION_FIELDS} } }`,
        variables: { operationId: operation.id },
      },
      {
        next: (result) => {
          if (result.data?.repositoryTransferChanged)
            receive(result.data.repositoryTransferChanged);
        },
        error: () => {
          void refresh();
        },
        complete: () => undefined,
      },
    );
    const recovery = onControlPlaneRecovery(() => {
      void refresh();
    });
    void refresh();
    return () => {
      controller.abort();
      unsubscribe();
      recovery();
    };
  }, [operation.id]);
  const retry = async () => {
    setRetrying(true);
    setError(null);
    retryRequestId.current ??= createClientId();
    try {
      const result = await controlPlaneRequest<{
        retryRepositoryTransfer: TransferOperation;
      }>(
        `mutation RetryRepositoryTransfer($id: ID!, $requestId: ID!) { retryRepositoryTransfer(id: $id, requestId: $requestId) { ${TRANSFER_OPERATION_FIELDS} } }`,
        { id: operation.id, requestId: retryRequestId.current },
      );
      setOperation(result.retryRepositoryTransfer);
      changed.current?.(result.retryRepositoryTransfer);
      retryRequestId.current = null;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setRetrying(false);
    }
  };
  const pending =
    PENDING.has(operation.status) ||
    operation.items.some((item) => PENDING.has(item.status));
  const failed =
    FAILED.has(operation.status) ||
    operation.items.some((item) => FAILED.has(item.status));
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {pending && <Spinner />}
        <h3 className="font-semibold">{t("operationStatus")}</h3>
        <Badge variant={failed ? "destructive" : "secondary"}>
          {operation.status}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("operationDescription")}
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {operation.items.map((item) => (
        <div className="space-y-1 rounded-lg border p-3" key={item.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-mono text-xs">
              {item.destinationPath}
            </span>
            <Badge
              variant={FAILED.has(item.status) ? "destructive" : "secondary"}
            >
              {item.status}
            </Badge>
          </div>
          {item.error && (
            <p className="text-sm text-destructive">{item.error}</p>
          )}
          {item.codebaseId && (
            <Link
              className="text-sm underline"
              href={`/dashboard/codebases/${item.codebaseId}`}
            >
              {t("openCheckout")}
            </Link>
          )}
        </div>
      ))}
      {failed && (
        <Button
          disabled={retrying || pending}
          onClick={() => void retry()}
          variant="outline"
        >
          {retrying ? <Spinner /> : <RefreshCw />}
          {t("retryFailed")}
        </Button>
      )}
      {operation.appId && (
        <Button asChild variant="outline">
          <Link href={`/dashboard/apps/${operation.appId}?view=sync`}>
            {t("openApp")}
          </Link>
        </Button>
      )}
    </div>
  );
}
