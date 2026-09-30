import { isLoopback } from "./public-origin";

export const SERVER_URL_KINDS = ["LOCAL", "REMOTE", "PROXY"] as const;
export type ServerUrlKind = (typeof SERVER_URL_KINDS)[number];

export type ServerUrlSettings = {
  localBaseUrlOverride: string | null;
  remoteBaseUrlOverride: string | null;
  proxyBaseUrl: string | null;
  detectedLocalBaseUrl: string;
  detectedRemoteBaseUrl: string;
  effectiveLocalBaseUrl: string;
  effectiveRemoteBaseUrl: string;
  defaultServerUrlKind: ServerUrlKind;
  simulatorDefaultServerUrlKind: ServerUrlKind | null;
  updatedAt: string;
};

export const SERVER_URL_SETTINGS_FIELDS = `
  localBaseUrlOverride remoteBaseUrlOverride proxyBaseUrl
  detectedLocalBaseUrl detectedRemoteBaseUrl effectiveLocalBaseUrl effectiveRemoteBaseUrl
  defaultServerUrlKind simulatorDefaultServerUrlKind updatedAt
`;

export function normalizeServerOrigin(value: string): string {
  const trimmed = value.trim();
  // Validate the input before URL normalization can erase dot paths or empty delimiters.
  if (/\s/.test(trimmed) || !/^https?:\/\/[^/?#@\\]+\/*$/i.test(trimmed)) {
    throw new Error(
      "Server URL must be an HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed.replace(/\/+$/, ""));
  } catch {
    throw new Error("Server URL must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Server URL must be an HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

export function serverUrlOptions(settings: ServerUrlSettings) {
  return [
    {
      kind: "LOCAL" as const,
      name: "Local",
      url: settings.effectiveLocalBaseUrl,
    },
    {
      kind: "REMOTE" as const,
      name: "Remote",
      url: settings.effectiveRemoteBaseUrl,
    },
    ...(settings.proxyBaseUrl
      ? [{ kind: "PROXY" as const, name: "Proxy", url: settings.proxyBaseUrl }]
      : []),
  ];
}

export function serverUrlActionProblem(
  settings: ServerUrlSettings | null,
  kind: ServerUrlKind | null,
  publicHost = false,
): "loading" | "proxyMissing" | "httpsRequired" | "publicHostRequired" | null {
  if (!settings) return "loading";
  const base = serverUrlOptions(settings).find(
    (option) => option.kind === (kind ?? settings.defaultServerUrlKind),
  )?.url;
  if (!base) return "proxyMissing";
  const url = new URL(base);
  if (url.protocol !== "https:") return "httpsRequired";
  if (
    publicHost &&
    (isLoopback(url.hostname) ||
      /^(169\.254\.|100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\.|\[?f[cd][0-9a-f]{2}:|\[?fe[89ab][0-9a-f]:)/i.test(
        url.hostname,
      ))
  )
    return "publicHostRequired";
  return null;
}

export function defaultServerUrlKind(
  settings: ServerUrlSettings,
  destinationType?: string,
): ServerUrlKind {
  return destinationType === "SIMULATOR"
    ? (settings.simulatorDefaultServerUrlKind ?? settings.defaultServerUrlKind)
    : settings.defaultServerUrlKind;
}

export function serverBaseUrl(
  settings: ServerUrlSettings,
  kind: ServerUrlKind,
): string {
  const option = serverUrlOptions(settings).find(
    (option) => option.kind === kind,
  );
  if (!option)
    throw new Error(
      "Proxy server URL is not configured. Choose another server URL or configure Proxy in Settings.",
    );
  return option.url;
}

export function serverEndpointUrls(settings: ServerUrlSettings, path: string) {
  return {
    localUrl: settings.effectiveLocalBaseUrl + path,
    remoteUrl: settings.effectiveRemoteBaseUrl + path,
    proxyUrl: settings.proxyBaseUrl ? settings.proxyBaseUrl + path : null,
  };
}

export function serverUrlKindFromLocation(): ServerUrlKind | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("serverUrlKind");
  return SERVER_URL_KINDS.includes(value as ServerUrlKind)
    ? (value as ServerUrlKind)
    : null;
}
