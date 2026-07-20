"use client";

import { Link, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
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
  const [warmed, setWarmed] = useState(false);
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
  const disabled = !environment || reason !== null;

  const installUrl = manifestUrl
    ? `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`
    : null;

  /**
   * Starts the artifact transfer before the install daemon asks for it. This is
   * deliberately not awaited: iOS only follows a link to another scheme while a
   * user gesture is active, and waiting here would lose it. The download cache
   * collapses concurrent requests for one artifact into a single transfer, so
   * the daemon joins this one rather than starting a second.
   */
  const warm = () => {
    if (warmed) return;
    setWarmed(true);
    void fetch(artifactPath, { method: "HEAD" }).catch(() => {});
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
        {disabled || !installUrl ? (
          <Button disabled size="sm" type="button" variant="outline">
            <Smartphone /> {t("installOnDevice")}
          </Button>
        ) : (
          /*
           * A real link rather than a scripted navigation: iOS hands the
           * itms-services scheme to the installer only when it is following a
           * genuine activation, and anything asynchronous beforehand loses it.
           */
          <Button asChild size="sm" variant="outline">
            <a href={installUrl} onPointerDown={warm}>
              <Smartphone /> {t("installOnDevice")}
            </a>
          </Button>
        )}
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
