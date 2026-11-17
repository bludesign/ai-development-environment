import { normalizeDeviceToken } from "@/services/push-notifications/validation";

export type IosStatusRegistration = {
  clientRegistrationId: string;
  kind: "WIDGET" | "LIVE_ACTIVITY";
  token: string;
  topic: string;
  environment: "SANDBOX" | "PRODUCTION";
};

export function registrationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error(
      "clientRegistrationId must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens",
    );
  }
  return value;
}

export function registrationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registration must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseStatusRegistration(value: unknown): IosStatusRegistration {
  const input = registrationObject(value);
  const allowed = new Set([
    "clientRegistrationId",
    "kind",
    "token",
    "topic",
    "environment",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Registration contains unsupported fields");
  }
  if (input.kind !== "WIDGET" && input.kind !== "LIVE_ACTIVITY") {
    throw new Error("kind must be WIDGET or LIVE_ACTIVITY");
  }
  if (input.environment !== "SANDBOX" && input.environment !== "PRODUCTION") {
    throw new Error("environment must be SANDBOX or PRODUCTION");
  }
  // These routes deliver the first-party control plane's status, never arbitrary app pushes.
  if (input.topic !== "com.bludesign.aidevelopmentenvironment") {
    throw new Error(
      "topic must be the AI Development Environment app bundle identifier",
    );
  }
  if (typeof input.token !== "string" || input.token.length > 512) {
    throw new Error("token must be a hexadecimal APNs token");
  }
  return {
    clientRegistrationId: registrationId(input.clientRegistrationId),
    kind: input.kind,
    token: normalizeDeviceToken(input.token, "HEX"),
    topic: input.topic,
    environment: input.environment,
  };
}
