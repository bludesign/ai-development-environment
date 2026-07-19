"use client";

import { Link, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { copyText } from "@/lib/browser-utils";

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
}: {
  buildId: string;
  artifactId: string;
  metadata: Record<string, unknown>;
}) {
  const t = useTranslations("builds");
  // The server has no way to know the browsing origin or the device, so it
  // renders the disabled state and the client fills it in on hydration.
  const environment = useSyncExternalStore(
    subscribe,
    readEnvironment,
    () => null,
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const artifactPath = `/api/builds/${encodeURIComponent(buildId)}/artifacts/${encodeURIComponent(artifactId)}`;
  const manifestUrl = environment
    ? `${environment.origin}${artifactPath}/manifest.plist`
    : null;

  const blocked = (): string | null => {
    if (!environment) return null;
    if (!environment.secure) return t("installRequiresHttps");
    if (metadata.exportMethod === "APP_STORE_CONNECT") {
      return t("installNotSupportedForAppStore");
    }
    if (typeof metadata.bundleIdentifier !== "string") {
      return t("installMissingBundleIdentifier");
    }
    return null;
  };

  const reason = blocked();
  const disabled = !environment || reason !== null || busy;

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
    await copyText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {environment && !environment.apple && !reason && (
          <Button
            onClick={() => void copyLink()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Link /> {copied ? t("installLinkCopied") : t("copyInstallLink")}
          </Button>
        )}
        <Button
          disabled={disabled}
          onClick={() => void install()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? <Spinner /> : <Smartphone />}
          {busy ? t("installPreparing") : t("installOnDevice")}
        </Button>
      </div>
      {reason && (
        <p className="text-right text-xs text-muted-foreground">{reason}</p>
      )}
      {!reason && environment && !environment.apple && (
        <p className="text-right text-xs text-muted-foreground">
          {t("installOpenOnDevice")}
        </p>
      )}
    </div>
  );
}
