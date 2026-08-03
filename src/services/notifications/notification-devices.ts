import {
  normalizeDeviceToken,
  type ApnsEnvironment,
  type ApnsTokenEncoding,
} from "@/services/push-notifications/validation";

const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

export type NotificationDeviceInput = {
  clientRegistrationId: string;
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  displayName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  const cleaned = value.trim();
  if (cleaned.length > max || cleaned.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return cleaned;
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name, max);
}

/**
 * Parses what the control plane's own iOS app posts when the user registers a device for
 * notifications. Deliberately narrower than `parseApnsRegistrationInput`: this channel only ever
 * sends alerts to one first-party app, so there is no push-type catalog, no MDM push magic, and
 * no certificate authentication to describe.
 */
export function parseNotificationDeviceInput(
  value: unknown,
): NotificationDeviceInput {
  const input = object(value, "device");
  const allowed = new Set([
    "clientRegistrationId",
    "token",
    "tokenEncoding",
    "topic",
    "environment",
    "displayName",
    "deviceModel",
    "osVersion",
    "appVersion",
    "appBuild",
    "locale",
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknownKeys.length) {
    throw new Error(`device has unsupported fields: ${unknownKeys.join(", ")}`);
  }

  const encoding = input.tokenEncoding ?? "HEX";
  if (encoding !== "HEX" && encoding !== "BASE64") {
    throw new Error("tokenEncoding must be HEX or BASE64");
  }
  const environment = input.environment;
  if (environment !== "SANDBOX" && environment !== "PRODUCTION") {
    throw new Error("environment must be SANDBOX or PRODUCTION");
  }
  const topic = requiredString(input.topic, "topic", 255);
  if (!TOPIC_PATTERN.test(topic)) throw new Error("topic is invalid");

  return {
    clientRegistrationId: requiredString(
      input.clientRegistrationId,
      "clientRegistrationId",
      200,
    ),
    token: normalizeDeviceToken(
      requiredString(input.token, "token", 500),
      encoding as ApnsTokenEncoding,
    ),
    topic,
    environment,
    displayName: requiredString(input.displayName, "displayName", 120),
    deviceModel: optionalString(input.deviceModel, "deviceModel", 120),
    osVersion: optionalString(input.osVersion, "osVersion", 60),
    appVersion: optionalString(input.appVersion, "appVersion", 60),
    appBuild: optionalString(input.appBuild, "appBuild", 60),
    locale: optionalString(input.locale, "locale", 35),
  };
}
