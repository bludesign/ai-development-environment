export const APNS_PUSH_TYPES = [
  "alert",
  "background",
  "complication",
  "controls",
  "fileprovider",
  "liveactivity",
  "location",
  "mdm",
  "pushtotalk",
  "voip",
  "widgets",
] as const;

export type ApnsPushType = (typeof APNS_PUSH_TYPES)[number];
export type ApnsEnvironment = "SANDBOX" | "PRODUCTION";
export type ApnsTokenEncoding = "HEX" | "BASE64";

const PUSH_TYPE_SET = new Set<string>(APNS_PUSH_TYPES);
const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

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

export type ApnsRegistrationInput = {
  clientRegistrationId: string;
  token: string;
  tokenEncoding: ApnsTokenEncoding;
  topic: string;
  environment: ApnsEnvironment;
  supportedPushTypes: ApnsPushType[];
  displayName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
  pushMagic: string | null;
};

export function normalizeDeviceToken(
  token: string,
  encoding: ApnsTokenEncoding,
): string {
  let bytes: Buffer;
  if (encoding === "HEX") {
    const compact = token.replace(/[\s<>]/g, "");
    if (!/^[A-Fa-f0-9]{64}$/.test(compact)) {
      throw new Error(
        "token must contain exactly 32 bytes of hexadecimal data",
      );
    }
    bytes = Buffer.from(compact, "hex");
  } else {
    const compact = token.trim();
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      throw new Error("token is not valid Base64");
    }
    try {
      bytes = Buffer.from(
        compact.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      );
    } catch {
      throw new Error("token is not valid Base64");
    }
    if (
      bytes.toString("base64").replace(/=+$/, "") !==
      compact.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "")
    ) {
      throw new Error("token is not valid Base64");
    }
  }
  if (bytes.length !== 32) {
    throw new Error("token must decode to exactly 32 bytes");
  }
  return bytes.toString("hex").toUpperCase();
}

export function parseApnsRegistrationInput(
  value: unknown,
): ApnsRegistrationInput {
  const input = object(value, "registration");
  const allowed = new Set([
    "clientRegistrationId",
    "token",
    "tokenEncoding",
    "topic",
    "environment",
    "supportedPushTypes",
    "displayName",
    "deviceModel",
    "osVersion",
    "appVersion",
    "appBuild",
    "locale",
    "pushMagic",
  ]);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected)
    throw new Error(`Unexpected registration field: ${unexpected}`);
  const encoding = requiredString(input.tokenEncoding, "tokenEncoding", 10);
  if (encoding !== "HEX" && encoding !== "BASE64") {
    throw new Error("tokenEncoding must be HEX or BASE64");
  }
  const environment = requiredString(input.environment, "environment", 20);
  if (environment !== "SANDBOX" && environment !== "PRODUCTION") {
    throw new Error("environment must be SANDBOX or PRODUCTION");
  }
  const topic = requiredString(input.topic, "topic", 255);
  if (!TOPIC_PATTERN.test(topic)) throw new Error("topic is invalid");
  if (
    !Array.isArray(input.supportedPushTypes) ||
    !input.supportedPushTypes.length
  ) {
    throw new Error("supportedPushTypes must contain at least one push type");
  }
  const supportedPushTypes = [
    ...new Set(
      input.supportedPushTypes.map((item) => {
        if (typeof item !== "string" || !PUSH_TYPE_SET.has(item)) {
          throw new Error(`Unsupported APNs push type: ${String(item)}`);
        }
        return item as ApnsPushType;
      }),
    ),
  ];
  const pushMagic = optionalString(input.pushMagic, "pushMagic", 500);
  if (supportedPushTypes.includes("mdm") && !pushMagic) {
    throw new Error("pushMagic is required when MDM is supported");
  }
  return {
    clientRegistrationId: requiredString(
      input.clientRegistrationId,
      "clientRegistrationId",
      200,
    ),
    token: normalizeDeviceToken(
      requiredString(input.token, "token", 1_024),
      encoding,
    ),
    tokenEncoding: encoding,
    topic,
    environment,
    supportedPushTypes,
    displayName: requiredString(input.displayName, "displayName", 120),
    deviceModel: optionalString(input.deviceModel, "deviceModel", 120),
    osVersion: optionalString(input.osVersion, "osVersion", 50),
    appVersion: optionalString(input.appVersion, "appVersion", 50),
    appBuild: optionalString(input.appBuild, "appBuild", 50),
    locale: optionalString(input.locale, "locale", 35),
    pushMagic,
  };
}

export type PushEditor = {
  pushType: ApnsPushType;
  headers: Record<string, unknown>;
  aps: Record<string, unknown>;
  custom: Record<string, unknown>;
  liveActivity: Record<string, unknown> | null;
  credentialId: string | null;
};

export function validatePushEditor(value: unknown): {
  editor: PushEditor;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  byteLength: number;
} {
  const source = object(value, "push editor");
  const pushType = requiredString(source.pushType, "pushType", 30);
  if (!PUSH_TYPE_SET.has(pushType)) throw new Error("pushType is unsupported");
  const headersInput = object(source.headers ?? {}, "headers");
  const aps = object(source.aps ?? {}, "aps");
  const custom = object(source.custom ?? {}, "custom");
  const credentialId = optionalString(source.credentialId, "credentialId", 100);
  const priorityValue =
    headersInput.priority ?? (pushType === "background" ? 5 : 10);
  const priority = Number(priorityValue);
  if (![1, 5, 10].includes(priority)) {
    throw new Error("APNs priority must be 1, 5, or 10");
  }
  if (pushType === "background" && priority !== 5) {
    throw new Error("Background notifications require priority 5");
  }
  if (["voip", "mdm", "pushtotalk"].includes(pushType) && priority !== 10) {
    throw new Error(`${pushType} notifications require priority 10`);
  }
  if (priority === 1 && pushType !== "location") {
    throw new Error("Priority 1 is supported only for location notifications");
  }
  const topic = requiredString(headersInput.topic, "topic", 255);
  if (!TOPIC_PATTERN.test(topic)) throw new Error("topic is invalid");
  const suffixes: Partial<Record<ApnsPushType, string>> = {
    complication: ".complication",
    fileprovider: ".pushkit.fileprovider",
    liveactivity: ".push-type.liveactivity",
    location: ".location-query",
    pushtotalk: ".voip-ptt",
    voip: ".voip",
    widgets: ".push-type.widgets",
    controls: ".push-type.controls",
  };
  const suffix = suffixes[pushType as ApnsPushType];
  if (suffix && !topic.endsWith(suffix)) {
    throw new Error(
      `${pushType} notifications require a topic ending in ${suffix}`,
    );
  }
  let payload: Record<string, unknown>;
  if (pushType === "mdm") {
    if (!credentialId) throw new Error("MDM requires a certificate credential");
    if (Object.keys(aps).length)
      throw new Error("MDM payloads cannot contain aps");
    if (Object.keys(custom).length) {
      throw new Error("MDM payloads cannot contain custom root fields");
    }
    payload = { mdm: "__PUSH_MAGIC__" };
  } else {
    const normalizedAps = { ...aps };
    const relevance = normalizedAps["relevance-score"];
    if (
      relevance !== undefined &&
      (typeof relevance !== "number" || relevance < 0 || relevance > 1)
    ) {
      throw new Error("aps.relevance-score must be between 0 and 1");
    }
    const badge = normalizedAps.badge;
    if (
      badge !== undefined &&
      (typeof badge !== "number" || !Number.isInteger(badge) || badge < 0)
    ) {
      throw new Error("aps.badge must be a non-negative integer");
    }
    const interruption = normalizedAps["interruption-level"];
    if (
      interruption !== undefined &&
      !["passive", "active", "time-sensitive", "critical"].includes(
        String(interruption),
      )
    ) {
      throw new Error("aps.interruption-level is invalid");
    }
    const sound = normalizedAps.sound;
    if (sound && typeof sound === "object" && !Array.isArray(sound)) {
      const volume = (sound as Record<string, unknown>).volume;
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 1
      ) {
        throw new Error("Critical sound volume must be between 0 and 1");
      }
    }
    if (pushType === "background") {
      for (const key of ["alert", "badge", "sound"]) {
        if (normalizedAps[key] !== undefined) {
          throw new Error(`Background notifications cannot contain aps.${key}`);
        }
      }
      normalizedAps["content-available"] = 1;
    }
    if (pushType === "alert" && !Object.keys(normalizedAps).length) {
      throw new Error("Alert notifications require at least one aps field");
    }
    if (pushType === "liveactivity") {
      const liveActivity = object(source.liveActivity ?? {}, "liveActivity");
      if (!Number.isInteger(liveActivity.timestamp)) {
        throw new Error(
          "Live Activity timestamp must be an integer Unix timestamp",
        );
      }
      if (!["start", "update", "end"].includes(String(liveActivity.event))) {
        throw new Error("Live Activity event must be start, update, or end");
      }
      Object.assign(normalizedAps, liveActivity);
    }
    payload = { ...custom, aps: normalizedAps };
  }
  const byteLength = Buffer.byteLength(JSON.stringify(payload));
  const limit = pushType === "voip" ? 5 * 1024 : 4 * 1024;
  if (byteLength > limit) {
    throw new Error(
      `Payload is ${byteLength} bytes; ${pushType} allows ${limit}`,
    );
  }
  const headers: Record<string, string> = {
    "apns-push-type": pushType,
    "apns-topic": topic,
    "apns-priority": String(priority),
  };
  const optionalHeaders: Array<[string, unknown]> = [
    ["apns-id", headersInput.id],
    ["apns-expiration", headersInput.expiration],
    ["apns-collapse-id", headersInput.collapseId],
    ["apns-channel-id", headersInput.broadcastChannelId],
  ];
  for (const [name, raw] of optionalHeaders) {
    if (raw !== undefined && raw !== null && raw !== "") {
      headers[name] = requiredString(
        raw,
        name,
        name === "apns-collapse-id" ? 64 : 200,
      );
    }
  }
  if (
    headers["apns-id"] &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      headers["apns-id"],
    )
  ) {
    throw new Error("apns-id must be a UUID");
  }
  if (
    headers["apns-expiration"] &&
    (!/^\d+$/.test(headers["apns-expiration"]) ||
      Number(headers["apns-expiration"]) < 0)
  ) {
    throw new Error("apns-expiration must be a non-negative Unix timestamp");
  }
  return {
    editor: {
      pushType: pushType as ApnsPushType,
      headers: headersInput,
      aps,
      custom,
      liveActivity:
        pushType === "liveactivity"
          ? object(source.liveActivity ?? {}, "liveActivity")
          : null,
      credentialId,
    },
    payload,
    headers,
    byteLength,
  };
}
