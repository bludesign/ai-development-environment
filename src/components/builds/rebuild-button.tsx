"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

export function useRebuildBuild({
  buildId,
  onCompleted,
  onError,
}: {
  buildId: string;
  onCompleted?: (build: { id: string; status: string }) => void | Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [rebuilding, setRebuilding] = useState(false);

  const rebuild = async () => {
    setRebuilding(true);
    onError(null);
    try {
      const data = await controlPlaneRequest<{
        rebuildBuild: { id: string; status: string };
      }>(
        `mutation RebuildBuild($id: ID!, $requestId: ID!) {
          rebuildBuild(id: $id, requestId: $requestId) { id status }
        }`,
        { id: buildId, requestId: createClientId() },
      );
      await onCompleted?.(data.rebuildBuild);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRebuilding(false);
    }
  };

  return { rebuild, rebuilding };
}

export function RebuildButton({
  buildId,
  onCompleted,
  onError,
  size = "default",
}: {
  buildId: string;
  onCompleted?: (build: { id: string; status: string }) => void | Promise<void>;
  onError: (error: string | null) => void;
  size?: "sm" | "default";
}) {
  const t = useTranslations("builds");
  const { rebuild, rebuilding } = useRebuildBuild({
    buildId,
    onCompleted,
    onError,
  });

  return (
    <Button
      disabled={rebuilding}
      onClick={(event) => {
        event.stopPropagation();
        void rebuild();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      size={size}
      type="button"
      variant="outline"
    >
      {rebuilding ? <Spinner /> : <RotateCcw />} {t("rebuild")}
    </Button>
  );
}
