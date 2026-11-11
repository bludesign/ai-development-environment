"use client";

import { Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";

import { buildArtifactDownloadUrl } from "./build-artifact-download";

const subscribe = () => () => {};
const isAndroid = () => /Android/i.test(navigator.userAgent);
const serverSnapshot = () => false;

export function AndroidInstallButton({
  buildId,
  artifactId,
  size = "sm",
}: {
  buildId: string;
  artifactId: string;
  size?: "sm" | "default";
}) {
  const t = useTranslations("androidBuilds");
  const android = useSyncExternalStore(subscribe, isAndroid, serverSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!android) return null;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const url = new URL(
        await buildArtifactDownloadUrl(buildId, artifactId),
        window.location.origin,
      );
      const destination = new URL(window.location.origin);
      destination.pathname = url.pathname;
      destination.search = url.search;
      window.location.assign(destination.href);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size={size} variant="outline">
          <Smartphone /> {t("install")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-3 text-sm">
        <p>{t("installInstructions")}</p>
        {error && (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button disabled={busy} onClick={() => void download()} size="sm">
          {busy && <Spinner />} {t("download")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
