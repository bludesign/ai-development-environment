import { createHash, randomUUID } from "node:crypto";
import {
  connect,
  constants,
  type ClientHttp2Session,
  type ClientSessionOptions,
  type SecureClientSessionOptions,
} from "node:http2";

import { importPKCS8, SignJWT } from "jose";

import type { ApnsEnvironment } from "./validation";

const JWT_REUSE_MS = 50 * 60_000;
const TRANSIENT_STATUS = new Set([429, 500, 503]);

export type ApnsAuthentication =
  | {
      kind: "TOKEN";
      teamId: string;
      keyId: string;
      privateKey: string;
    }
  | {
      kind: "CERTIFICATE";
      p12Base64: string;
      passphrase: string;
      fingerprint: string;
    };

export type ApnsResponse = {
  status: number;
  reason: string | null;
  timestamp: Date | null;
  apnsId: string | null;
  attempts: number;
  durationMs: number;
};

type SessionFactory = (
  authority: string,
  options?: ClientSessionOptions | SecureClientSessionOptions,
) => ClientHttp2Session;

function endpoint(environment: ApnsEnvironment): string {
  return environment === "SANDBOX"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

function retryDelay(value: string | string[] | undefined, attempt: number) {
  const text = Array.isArray(value) ? value[0] : value;
  if (text) {
    const seconds = Number(text);
    if (Number.isFinite(seconds)) return Math.min(30_000, seconds * 1_000);
    const date = Date.parse(text);
    if (Number.isFinite(date))
      return Math.max(0, Math.min(30_000, date - Date.now()));
  }
  return Math.min(4_000, 250 * 2 ** attempt);
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApnsClient {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private readonly jwtCache = new Map<
    string,
    { token: string; createdAt: number }
  >();

  constructor(private readonly sessionFactory: SessionFactory = connect) {}

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(
    environment: ApnsEnvironment,
    authentication: ApnsAuthentication,
  ): ClientHttp2Session {
    const credentialKey =
      authentication.kind === "TOKEN"
        ? `token:${authentication.teamId}:${authentication.keyId}`
        : `certificate:${authentication.fingerprint}`;
    const key = `${environment}:${credentialKey}`;
    const existing = this.sessions.get(key);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const options: SecureClientSessionOptions =
      authentication.kind === "CERTIFICATE"
        ? {
            pfx: Buffer.from(authentication.p12Base64, "base64"),
            passphrase: authentication.passphrase,
          }
        : {};
    const created = this.sessionFactory(endpoint(environment), options);
    created.on("error", () => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
    });
    created.on("close", () => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
    });
    this.sessions.set(key, created);
    return created;
  }

  private async authorization(authentication: ApnsAuthentication) {
    if (authentication.kind === "CERTIFICATE") return null;
    const cacheKey = `${authentication.teamId}:${authentication.keyId}:${createHash(
      "sha256",
    )
      .update(authentication.privateKey)
      .digest("hex")}`;
    const cached = this.jwtCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < JWT_REUSE_MS) {
      return `bearer ${cached.token}`;
    }
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await importPKCS8(authentication.privateKey, "ES256");
    } catch {
      throw new Error("The APNs .p8 key must be an ES256 PKCS#8 private key");
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: authentication.keyId })
      .setIssuer(authentication.teamId)
      .setIssuedAt()
      .sign(key);
    this.jwtCache.set(cacheKey, { token, createdAt: Date.now() });
    return `bearer ${token}`;
  }

  private async requestOnce(input: {
    environment: ApnsEnvironment;
    authentication: ApnsAuthentication;
    path: string;
    method?: "POST" | "DELETE";
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  }): Promise<{
    status: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }> {
    const authorization = await this.authorization(input.authentication);
    const session = this.session(input.environment, input.authentication);
    return new Promise((resolve, reject) => {
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: input.method ?? "POST",
        [constants.HTTP2_HEADER_PATH]: input.path,
        [constants.HTTP2_HEADER_SCHEME]: "https",
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
        ...input.headers,
      });
      let responseHeaders: Record<string, string | string[] | undefined> = {};
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        responseHeaders = headers as Record<
          string,
          string | string[] | undefined
        >;
      });
      request.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.close(constants.NGHTTP2_CANCEL);
      });
      request.on("error", reject);
      request.on("end", () => {
        const rawStatus = responseHeaders[constants.HTTP2_HEADER_STATUS];
        const status = Number(
          Array.isArray(rawStatus) ? rawStatus[0] : rawStatus,
        );
        resolve({ status: status || 0, body, headers: responseHeaders });
      });
      request.setTimeout(20_000, () => {
        request.close(constants.NGHTTP2_CANCEL);
        reject(new Error("APNs request timed out"));
      });
      request.end(JSON.stringify(input.payload));
    });
  }

  async send(input: {
    environment: ApnsEnvironment;
    authentication: ApnsAuthentication;
    deviceToken?: string;
    broadcastTopic?: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  }): Promise<ApnsResponse> {
    if (!input.deviceToken && !input.broadcastTopic) {
      throw new Error("An APNs device token or broadcast topic is required");
    }
    const path = input.deviceToken
      ? `/3/device/${input.deviceToken.toLowerCase()}`
      : `/4/broadcasts/apps/${encodeURIComponent(input.broadcastTopic!)}`;
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      let response: Awaited<ReturnType<ApnsClient["requestOnce"]>>;
      try {
        response = await this.requestOnce({ ...input, path });
      } catch (error) {
        if (attempt >= 3) throw error;
        await pause(Math.min(4_000, 250 * 2 ** attempt));
        attempt += 1;
        continue;
      }
      let parsed: { reason?: string; timestamp?: number } = {};
      try {
        parsed = response.body ? JSON.parse(response.body) : {};
      } catch {
        parsed = {};
      }
      if (TRANSIENT_STATUS.has(response.status) && attempt < 3) {
        await pause(retryDelay(response.headers["retry-after"], attempt));
        attempt += 1;
        continue;
      }
      const rawApnsId = response.headers["apns-id"];
      return {
        status: response.status,
        reason: parsed.reason ?? null,
        timestamp:
          typeof parsed.timestamp === "number"
            ? new Date(parsed.timestamp)
            : null,
        apnsId:
          (Array.isArray(rawApnsId) ? rawApnsId[0] : rawApnsId) ??
          input.headers["apns-id"] ??
          randomUUID(),
        attempts: attempt + 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async createBroadcastChannel(input: {
    environment: ApnsEnvironment;
    authentication: ApnsAuthentication;
    bundleId: string;
    storagePolicy: "NO_STORAGE" | "MOST_RECENT";
  }): Promise<string> {
    const response = await this.requestOnce({
      environment: input.environment,
      authentication: input.authentication,
      path: `/4/broadcasts/apps/${encodeURIComponent(input.bundleId)}`,
      payload: {
        "channel-storage-policy": input.storagePolicy === "NO_STORAGE" ? 0 : 1,
      },
      headers: {
        "apns-topic": `${input.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
      },
    });
    const raw = response.headers["apns-channel-id"];
    const channelId = Array.isArray(raw) ? raw[0] : raw;
    if (![200, 201].includes(response.status) || !channelId) {
      throw new Error(
        `APNs could not create the broadcast channel (HTTP ${response.status})`,
      );
    }
    return channelId;
  }

  async deleteBroadcastChannel(input: {
    environment: ApnsEnvironment;
    authentication: ApnsAuthentication;
    bundleId: string;
    channelId: string;
  }): Promise<void> {
    const response = await this.requestOnce({
      environment: input.environment,
      authentication: input.authentication,
      method: "DELETE",
      path: `/4/broadcasts/apps/${encodeURIComponent(input.bundleId)}`,
      payload: {},
      headers: {
        "apns-topic": `${input.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-channel-id": input.channelId,
      },
    });
    if (![200, 204].includes(response.status)) {
      throw new Error(
        `APNs could not delete the broadcast channel (HTTP ${response.status})`,
      );
    }
  }
}
