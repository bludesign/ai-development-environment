"use client";

import { ChevronRight, Folder, FolderCheck, Home } from "lucide-react";
import { useTranslations } from "next-intl";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { DirectoryListing } from "@/components/codebases/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

function pathBreadcrumbs(path: string) {
  if (path === "/") return [{ label: "/", path: "/" }];
  return [
    { label: "/", path: "/" },
    ...path
      .split("/")
      .filter(Boolean)
      .map((label, index, parts) => ({
        label,
        path: `/${parts.slice(0, index + 1).join("/")}`,
      })),
  ];
}

export function AgentDirectoryBrowser({
  agentId,
  disabled = false,
  initialPath = null,
  onPathChange,
  onSelect,
  selectIcon,
  selectLabel,
}: {
  agentId: string;
  disabled?: boolean;
  initialPath?: string | null;
  onPathChange?: (path: string) => void;
  onSelect?: (path: string) => Promise<void> | void;
  selectIcon?: ReactNode;
  selectLabel?: string;
}) {
  const t = useTranslations("codebases");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const browse = useCallback(
    async (path: string | null) => {
      const requestId = ++requestSequence.current;
      setBusy(true);
      try {
        const data = await controlPlaneRequest<{
          browseAgentDirectory: DirectoryListing;
        }>(
          `mutation BrowseAgentDirectory($input: BrowseAgentDirectoryInput!) {
            browseAgentDirectory(input: $input) {
              path parentPath homePath truncated entries { name path hidden }
            }
          }`,
          { input: { agentId, path, requestId: createClientId() } },
        );
        if (requestId !== requestSequence.current) return;
        setListing(data.browseAgentDirectory);
        onPathChange?.(data.browseAgentDirectory.path);
        setError(null);
      } catch (value) {
        if (requestId !== requestSequence.current) return;
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (requestId === requestSequence.current) setBusy(false);
      }
    },
    [agentId, onPathChange],
  );

  useEffect(() => {
    if (!initialPath) return;
    const timer = window.setTimeout(() => void browse(initialPath), 0);
    return () => window.clearTimeout(timer);
  }, [browse, initialPath]);

  useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );

  if (!listing) {
    return (
      <div className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          disabled={busy || disabled}
          onClick={() => void browse(null)}
          type="button"
          variant="outline"
        >
          {busy ? <Spinner /> : <Folder />} {t("browseHome")}
        </Button>
      </div>
    );
  }

  const breadcrumbs = pathBreadcrumbs(listing.path);
  return (
    <div className="space-y-3 rounded-lg border p-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          aria-label={t("home")}
          disabled={busy || disabled}
          onClick={() => void browse(listing.homePath)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Home />
        </Button>
        {breadcrumbs.map((crumb, index) => (
          <span className="flex items-center" key={crumb.path}>
            {index > 0 && (
              <ChevronRight className="size-3 text-muted-foreground" />
            )}
            <Button
              disabled={busy || disabled}
              onClick={() => void browse(crumb.path)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {crumb.label}
            </Button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={showHidden}
          id={`show-hidden-${agentId}`}
          onCheckedChange={(value) => setShowHidden(Boolean(value))}
        />
        <Label htmlFor={`show-hidden-${agentId}`}>{t("showHidden")}</Label>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-md border">
        {listing.entries
          .filter((entry) => showHidden || !entry.hidden)
          .map((entry) => (
            <Button
              className="h-auto w-full justify-start rounded-none border-b px-3 py-2 last:border-0"
              disabled={busy || disabled}
              key={entry.path}
              onClick={() => void browse(entry.path)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Folder className="size-4" /> {entry.name}
            </Button>
          ))}
      </div>
      {listing.truncated && (
        <p className="text-xs text-muted-foreground">{t("truncated")}</p>
      )}
      {onSelect && selectLabel && (
        <Button
          disabled={busy || disabled}
          onClick={() => void onSelect(listing.path)}
          type="button"
        >
          {disabled ? <Spinner /> : (selectIcon ?? <FolderCheck />)}{" "}
          {selectLabel}
        </Button>
      )}
    </div>
  );
}
