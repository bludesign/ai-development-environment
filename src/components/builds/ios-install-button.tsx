"use client";

import { Link, Smartphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { BuildArtifact } from "./types";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import {
  ServerUrlPicker,
  EndpointUrls,
} from "@/components/server-urls/server-url-controls";
import {
  serverUrlOptions,
  serverUrlKindFromLocation,
  type ServerUrlKind,
} from "@/lib/server-urls";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/browser-utils";
import type { PublicOrigin } from "@/lib/public-origin";

export function latestInstallArtifact(
  artifacts: BuildArtifact[],
): BuildArtifact | undefined {
  const ipas = artifacts
    .filter((artifact) => artifact.kind === "IPA")
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  return (
    ipas.find(
      (artifact) =>
        artifact.metadata.exportMethod !== "APP_STORE_CONNECT" &&
        typeof artifact.metadata.bundleIdentifier === "string" &&
        artifact.metadata.bundleIdentifier.trim().length > 0,
    ) ?? ipas[0]
  );
}

type InstallEnvironment = {
  origin: string;
  secure: boolean;
  apple: boolean;
};

let cachedEnvironment: InstallEnvironment | null = null;

/**
 * Cached because useSyncExternalStore compares snapshots by identity, and none
 * of these values change over the life of the page.
 */
function readEnvironment(): InstallEnvironment {
  cachedEnvironment ??= {
    origin: window.location.origin,
    secure: window.location.protocol === "https:",
    // iPadOS reports itself as a Mac by default, so the touch check is what
    // actually identifies an iPad.
    apple:
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" &&
        (navigator.maxTouchPoints ?? 0) > 1),
  };
  return cachedEnvironment;
}

const subscribe = () => () => {};

/**
 * Offers over-the-air installation of an exported IPA.
 *
 * iOS only accepts an install manifest served over publicly trusted HTTPS, and
 * only for packages signed for development, ad-hoc, or enterprise distribution,
 * so the button reports why it cannot install rather than handing iOS a request
 * it will reject with an opaque error.
 */
export function IosInstallButton({
  buildId,
  artifactId,
  metadata,
  publicOrigin: _publicOrigin,
  size = "sm",
}: {
  buildId: string;
  artifactId: string;
  metadata: Record<string, unknown>;
  publicOrigin: Pick<PublicOrigin, "origin" | "secure"> | null;
  size?: "sm" | "default";
}) {
  const { settings: serverUrls } = useServerUrlSettings();
  const [selectedKind, setSelectedKind] = useState<ServerUrlKind | null>(
    serverUrlKindFromLocation,
  );
  const t = useTranslations("builds");
  const locale = useLocale();
  // The server has no way to know the browsing origin or the device, so it
  // renders the disabled state and the client fills it in on hydration.
  const environment = useSyncExternalStore(
    subscribe,
    readEnvironment,
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const artifactPath = `/api/public/builds/${encodeURIComponent(buildId)}/artifacts/${encodeURIComponent(artifactId)}`;
  const serverKind = selectedKind ?? serverUrls?.defaultServerUrlKind;
  const selectedBase =
    serverUrls &&
    serverUrlOptions(serverUrls).find((option) => option.kind === serverKind)
      ?.url;
  const installOrigin = selectedBase
    ? { origin: selectedBase, secure: selectedBase.startsWith("https://") }
    : null;
  const manifestUrl = installOrigin
    ? `${installOrigin.origin}${artifactPath}/manifest.plist?serverUrlKind=${serverKind}`
    : null;

  const blocked = (): string | null => {
    if (!environment) return null;
    if (!installOrigin?.secure) return t("installRequiresHttps");
    if (metadata.exportMethod === "APP_STORE_CONNECT") {
      return t("installNotSupportedForAppStore");
    }
    if (
      typeof metadata.bundleIdentifier !== "string" ||
      !metadata.bundleIdentifier.trim()
    ) {
      return t("installMissingBundleIdentifier");
    }
    return null;
  };

  const reason = blocked();
  const disabled =
    !environment || !environment.apple || reason !== null || busy;

  const install = async () => {
    if (!manifestUrl) return;
    setBusy(true);
    try {
      // Warm the download cache first. The agent holds the only copy, so a cold
      // fetch inside the install daemon's own budget shows up as an unhelpful
      // "Unable to Download App" instead of progress.
      await fetch(artifactPath, { method: "HEAD" }).catch(() => {});
      window.location.href = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!installOrigin || !serverKind) return;
    const origin = installOrigin.origin;
    await copyText(
      `${origin}/${locale}/builds/${encodeURIComponent(buildId)}?serverUrlKind=${serverKind}`,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  const explanation =
    environment && !environment.apple ? t("installOpenOnDevice") : reason;
  const label = (
    <>
      {busy ? <Spinner /> : <Smartphone />}
      {busy ? t("installPreparing") : t("install")}
    </>
  );
  return (
    <span
      className="inline-flex"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Choose server URL">
            <Link />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="space-y-3">
          <ServerUrlPicker
            value={selectedKind}
            onValueChange={setSelectedKind}
          />
          <EndpointUrls path={artifactPath} />
        </PopoverContent>
      </Popover>
      {explanation ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-disabled="true"
              className="cursor-not-allowed opacity-50"
              size={size}
              type="button"
              variant="outline"
            >
              {label}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 space-y-2 text-sm" align="end">
            <p>{explanation}</p>
            <Button
              disabled={!installOrigin}
              onClick={() => void copyLink()}
              size="sm"
              variant="ghost"
            >
              <Link />
              {copied ? t("installLinkCopied") : t("copyInstallLink")}
            </Button>
          </PopoverContent>
        </Popover>
      ) : (
        <Button
          disabled={disabled}
          onClick={() => void install()}
          size={size}
          type="button"
          variant="outline"
        >
          {label}
        </Button>
      )}
    </span>
  );
}
