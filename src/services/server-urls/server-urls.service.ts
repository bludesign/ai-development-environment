import "server-only";
import { getPrismaClient } from "@/data/prisma-client";
import { getEnrollmentServerOrigins } from "@/server/enrollment-server-origins";
import {
  agentEventBus,
  TELEMETRY_SETTINGS_CHANGED_TOPIC,
} from "@/services/agent-control";
import {
  defaultServerUrlKind,
  normalizeServerOrigin,
  serverBaseUrl,
  SERVER_URL_KINDS,
  type ServerUrlKind,
  type ServerUrlSettings,
} from "@/lib/server-urls";

export const SERVER_URL_SETTINGS_CHANGED_TOPIC = "server-url.settings.changed";
export type ServerUrlDetection = {
  requestOrigin?: string | null;
  localOrigins?: string[];
  publicBaseUrl?: string | null;
};
export type SaveServerUrlSettingsInput = {
  localBaseUrlOverride?: string | null;
  remoteBaseUrlOverride?: string | null;
  proxyBaseUrl?: string | null;
  defaultServerUrlKind?: ServerUrlKind | null;
  simulatorDefaultServerUrlKind?: ServerUrlKind | null;
};

function optionalOrigin(value: string | null | undefined): string | null {
  return value?.trim() ? normalizeServerOrigin(value) : null;
}
function detectedOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
function privateHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value.endsWith(".local") ||
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  );
}
export function detectServerOrigins(input: ServerUrlDetection = {}) {
  const request = detectedOrigin(input.requestOrigin);
  const locals = (input.localOrigins ?? getEnrollmentServerOrigins()).flatMap(
    (value) => {
      try {
        return [normalizeServerOrigin(value)];
      } catch {
        return [];
      }
    },
  );
  const configured = detectedOrigin(
    input.publicBaseUrl ?? process.env.PUBLIC_BASE_URL,
  );
  const local =
    request && privateHostname(new URL(request).hostname)
      ? request
      : (locals[0] ?? request ?? "http://127.0.0.1:3000");
  return { local, remote: configured ?? request ?? local };
}
function kind(value: string): ServerUrlKind {
  if (!SERVER_URL_KINDS.includes(value as ServerUrlKind))
    throw new Error("Unknown server URL kind");
  return value as ServerUrlKind;
}

export class ServerUrlSettingsService {
  private async rawSettings() {
    const prisma = await getPrismaClient();
    return prisma.serverUrlSettings.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
    });
  }
  async settings(
    detection: ServerUrlDetection = {},
  ): Promise<ServerUrlSettings> {
    const row = await this.rawSettings();
    const detected = detectServerOrigins(detection);
    return {
      localBaseUrlOverride: row.localBaseUrlOverride,
      remoteBaseUrlOverride: row.remoteBaseUrlOverride,
      proxyBaseUrl: row.proxyBaseUrl,
      detectedLocalBaseUrl: detected.local,
      detectedRemoteBaseUrl: detected.remote,
      effectiveLocalBaseUrl: row.localBaseUrlOverride ?? detected.local,
      effectiveRemoteBaseUrl: row.remoteBaseUrlOverride ?? detected.remote,
      defaultServerUrlKind: kind(row.defaultServerUrlKind),
      simulatorDefaultServerUrlKind: row.simulatorDefaultServerUrlKind
        ? kind(row.simulatorDefaultServerUrlKind)
        : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async saveSettings(
    input: SaveServerUrlSettingsInput,
    detection: ServerUrlDetection = {},
  ) {
    const prisma = await getPrismaClient();
    await this.rawSettings();
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.serverUrlSettings.findUniqueOrThrow({
        where: { id: "default" },
      });
      const proxyBaseUrl =
        input.proxyBaseUrl === undefined
          ? current.proxyBaseUrl
          : optionalOrigin(input.proxyBaseUrl);
      const defaultKind = kind(
        input.defaultServerUrlKind ?? current.defaultServerUrlKind,
      );
      const simulatorKind =
        input.simulatorDefaultServerUrlKind === undefined
          ? current.simulatorDefaultServerUrlKind
          : input.simulatorDefaultServerUrlKind;
      if (simulatorKind) kind(simulatorKind);
      if (
        !proxyBaseUrl &&
        (defaultKind === "PROXY" || simulatorKind === "PROXY")
      ) {
        throw new Error(
          "Configure a Proxy URL or choose another default server URL before saving.",
        );
      }
      return tx.serverUrlSettings.update({
        where: { id: "default" },
        data: {
          localBaseUrlOverride:
            input.localBaseUrlOverride === undefined
              ? current.localBaseUrlOverride
              : optionalOrigin(input.localBaseUrlOverride),
          remoteBaseUrlOverride:
            input.remoteBaseUrlOverride === undefined
              ? current.remoteBaseUrlOverride
              : optionalOrigin(input.remoteBaseUrlOverride),
          proxyBaseUrl,
          defaultServerUrlKind: defaultKind,
          simulatorDefaultServerUrlKind: simulatorKind,
        },
      });
    });
    const event = { updatedAt: updated.updatedAt.toISOString() };
    agentEventBus.publish(SERVER_URL_SETTINGS_CHANGED_TOPIC, event);
    agentEventBus.publish(TELEMETRY_SETTINGS_CHANGED_TOPIC, event);
    return this.settings(detection);
  }
  subscribeSettings() {
    return agentEventBus.iterate<{ updatedAt: string }>(
      SERVER_URL_SETTINGS_CHANGED_TOPIC,
    );
  }
  async buildSettings(
    destinationType: string,
    selectedKind?: ServerUrlKind | null,
    detection: ServerUrlDetection = {},
  ) {
    const settings = await this.settings(detection);
    const selectedUrlKind =
      selectedKind ?? defaultServerUrlKind(settings, destinationType);
    return {
      localBaseUrl: settings.effectiveLocalBaseUrl,
      remoteBaseUrl: settings.effectiveRemoteBaseUrl,
      proxyBaseUrl: settings.proxyBaseUrl,
      selectedUrlKind,
      selectedBaseUrl: serverBaseUrl(settings, selectedUrlKind),
    };
  }
}
export const serverUrlSettingsService = new ServerUrlSettingsService();
