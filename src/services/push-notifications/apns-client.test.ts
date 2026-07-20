// @vitest-environment node
import { EventEmitter } from "node:events";
import { constants } from "node:http2";

import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { ApnsClient, type ApnsAuthentication } from "./apns-client";

type Response = {
  status: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

function fakeHttp2(responses: Response[]) {
  const authorities: string[] = [];
  const options: unknown[] = [];
  const requests: Array<{
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }> = [];
  let cursor = 0;
  const factory = vi.fn((authority: string, sessionOptions?: unknown) => {
    authorities.push(authority);
    options.push(sessionOptions);
    const session = new EventEmitter() as EventEmitter & {
      closed: boolean;
      destroyed: boolean;
      close(): void;
      request(headers: Record<string, string>): EventEmitter & {
        setEncoding(): void;
        setTimeout(_timeout: number, _callback: () => void): void;
        close(): void;
        end(payload: string): void;
      };
    };
    session.closed = false;
    session.destroyed = false;
    session.close = () => {
      session.closed = true;
      session.emit("close");
    };
    session.request = (headers) => {
      const request = new EventEmitter() as ReturnType<typeof session.request>;
      request.setEncoding = () => undefined;
      request.setTimeout = () => undefined;
      request.close = () => undefined;
      request.end = (payload) => {
        requests.push({ headers, payload: JSON.parse(payload) });
        const response = responses[cursor++] ?? { status: 200 };
        queueMicrotask(() => {
          request.emit("response", {
            [constants.HTTP2_HEADER_STATUS]: response.status,
            ...response.headers,
          });
          if (response.body)
            request.emit("data", JSON.stringify(response.body));
          request.emit("end");
        });
      };
      return request;
    };
    return session;
  });
  return {
    authorities,
    options,
    requests,
    factory: factory as unknown as ConstructorParameters<typeof ApnsClient>[0],
  };
}

let tokenAuthentication: ApnsAuthentication;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  tokenAuthentication = {
    kind: "TOKEN",
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: await exportPKCS8(privateKey),
  };
});

describe("ApnsClient", () => {
  test("reuses sandbox HTTP/2 sessions and ES256 JWTs", async () => {
    const fake = fakeHttp2([{ status: 200 }, { status: 200 }]);
    const client = new ApnsClient(fake.factory);
    const input = {
      environment: "SANDBOX" as const,
      authentication: tokenAuthentication,
      deviceToken: "01".repeat(32),
      payload: { aps: { alert: "Hello" } },
      headers: {
        "apns-topic": "com.example.app",
        "apns-push-type": "alert",
      },
    };

    await client.send(input);
    await client.send(input);

    expect(fake.authorities).toEqual(["https://api.sandbox.push.apple.com"]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.headers.authorization).toMatch(/^bearer /);
    expect(fake.requests[1]?.headers.authorization).toBe(
      fake.requests[0]?.headers.authorization,
    );
    expect(fake.requests[0]?.headers[":path"]).toBe(
      `/3/device/${"01".repeat(32)}`,
    );
  });

  test("routes production certificate authentication without a bearer token", async () => {
    const fake = fakeHttp2([{ status: 200 }]);
    const client = new ApnsClient(fake.factory);
    const certificate: ApnsAuthentication = {
      kind: "CERTIFICATE",
      p12Base64: Buffer.from("p12").toString("base64"),
      passphrase: "secret",
      fingerprint: "ABC",
    };

    await client.send({
      environment: "PRODUCTION",
      authentication: certificate,
      deviceToken: "02".repeat(32),
      payload: { mdm: "push-magic" },
      headers: { "apns-topic": "com.example.mdm", "apns-push-type": "mdm" },
    });

    expect(fake.authorities).toEqual(["https://api.push.apple.com"]);
    expect(fake.options[0]).toMatchObject({ passphrase: "secret" });
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("retries transient APNs responses and records the final outcome", async () => {
    const fake = fakeHttp2([
      {
        status: 429,
        body: { reason: "TooManyRequests" },
        headers: { "retry-after": "0" },
      },
      { status: 200, headers: { "apns-id": "response-id" } },
    ]);
    const client = new ApnsClient(fake.factory);

    const response = await client.send({
      environment: "SANDBOX",
      authentication: tokenAuthentication,
      deviceToken: "03".repeat(32),
      payload: { aps: { "content-available": 1 } },
      headers: {
        "apns-topic": "com.example.app",
        "apns-push-type": "background",
      },
    });

    expect(response).toMatchObject({
      status: 200,
      apnsId: "response-id",
      attempts: 2,
    });
    expect(fake.requests).toHaveLength(2);
  });

  test("creates broadcast channels with an immutable storage policy", async () => {
    const fake = fakeHttp2([
      { status: 201, headers: { "apns-channel-id": "channel-123" } },
    ]);
    const client = new ApnsClient(fake.factory);

    const channelId = await client.createBroadcastChannel({
      environment: "PRODUCTION",
      authentication: tokenAuthentication,
      bundleId: "com.example.app",
      storagePolicy: "MOST_RECENT",
    });

    expect(channelId).toBe("channel-123");
    expect(fake.requests[0]).toMatchObject({
      payload: { "channel-storage-policy": 1 },
    });
    expect(fake.requests[0]?.headers[":path"]).toBe(
      "/4/broadcasts/apps/com.example.app",
    );
  });
});
