import type { ServerUrlSettings } from "@/lib/server-urls";
export const serverUrlFixture: ServerUrlSettings = {
  localBaseUrlOverride: null,
  remoteBaseUrlOverride: null,
  detectedLocalBaseUrl: "http://127.0.0.1:3000",
  detectedRemoteBaseUrl: "https://builds.example.com",
  effectiveLocalBaseUrl: "http://127.0.0.1:3000",
  effectiveRemoteBaseUrl: "https://builds.example.com",
  proxyBaseUrl: "https://aide.example.ts.net",
  defaultServerUrlKind: "LOCAL",
  simulatorDefaultServerUrlKind: null,
  updatedAt: "2026-09-29T12:00:00.000Z",
};
