import "server-only";
import {
  SERVER_URL_KINDS,
  serverBaseUrl,
  type ServerUrlKind,
} from "@/lib/server-urls";
import { resolvePublicOrigin } from "@/lib/public-origin";
import { serverUrlSettingsService } from "@/services/server-urls/server-urls.service";

export class ServerUrlSelectionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function configuredServerOrigin(
  headers: Headers,
  value?: string | null,
) {
  if (value && !SERVER_URL_KINDS.includes(value as ServerUrlKind))
    throw new ServerUrlSelectionError("Unknown server URL kind");
  const settings = await serverUrlSettingsService.settings({
    requestOrigin: resolvePublicOrigin(headers)?.origin,
  });
  const kind =
    (value as ServerUrlKind | undefined) || settings.defaultServerUrlKind;
  if (kind === "PROXY" && !settings.proxyBaseUrl)
    throw new ServerUrlSelectionError(
      "Proxy URL is not configured. Choose Local or Remote, or configure it in Settings.",
      409,
    );
  const base = serverBaseUrl(settings, kind);
  // Configured origins are operator-controlled; request headers still use the trusted host resolver.
  const origin = resolvePublicOrigin(new Headers(), { PUBLIC_BASE_URL: base });
  if (!origin)
    throw new ServerUrlSelectionError(
      "The selected server URL is unavailable",
      409,
    );
  return { ...origin, kind };
}
