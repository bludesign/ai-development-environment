import { createHash } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Client, Sink } from "graphql-ws";

import {
  AgentGraphQLClient,
  agentWebSocketHeaders,
  subscribeToAgentEvents,
  type AgentJob,
  writeArtifactTransferBytes,
} from "./graphql-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentGraphQLClient", () => {
  test("retries positioned writes until a downloaded chunk is complete", async () => {
    const positions: number[] = [];
    const stored: number[] = [];
    const writer = {
      write: vi.fn(
        async (
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          positions.push(position);
          stored.push(bytes[offset]!);
          return { bytesWritten: Math.min(1, length) };
        },
      ),
    };

    await writeArtifactTransferBytes(writer, Buffer.from("abc"), 11);

    expect(positions).toEqual([11, 12, 13]);
    expect(Buffer.from(stored).toString()).toBe("abc");
  });

  test("rejects a downloaded chunk write that makes no progress", async () => {
    await expect(
      writeArtifactTransferBytes(
        { write: vi.fn().mockResolvedValue({ bytesWritten: 0 }) },
        Buffer.from("abc"),
        0,
      ),
    ).rejects.toThrow("made no progress");
  });

  test("checks public auth configuration for server readiness", async () => {
    const fetchMock = vi.fn(async () => Response.json({ mode: "password" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentGraphQLClient(
      "https://control.test",
      null,
      10_000,
      {
        "CF-Access-Client-Id": "client-id",
      },
    );

    await expect(client.ready()).resolves.toEqual({ mode: "password" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.test/api/auth/config",
      expect.objectContaining({
        headers: { "CF-Access-Client-Id": "client-id" },
      }),
    );
  });

  test("builds a run-scoped MCP descriptor with agent authorization taking precedence", () => {
    const client = new AgentGraphQLClient(
      "https://control.test/",
      "agent-credential",
      10_000,
      {
        "CF-Access-Client-Id": "client-id",
        Authorization: "Bearer custom",
      },
    );

    expect(client.mcpServerDescriptor("run/1")).toEqual({
      name: "ai-development-environment",
      url: "https://control.test/api/mcp?run=run%2F1",
      headers: {
        "CF-Access-Client-Id": "client-id",
        authorization: "Bearer agent-credential",
      },
    });
    expect(
      new AgentGraphQLClient("https://control.test").mcpServerDescriptor(
        "run-1",
      ),
    ).toBeNull();
  });

  test("aborts a hung fetch at the configured request timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }),
    );
    const client = new AgentGraphQLClient("http://control.test", null, 5);

    await expect(client.health()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  test("applies custom headers while preserving GraphQL authorization and content type", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: { health: "ok" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentGraphQLClient(
      "https://control.test",
      "agent-credential",
      10_000,
      {
        "CF-Access-Client-Id": "client-id",
        Authorization: "Bearer custom",
        "Content-Type": "text/plain",
      },
    );

    await expect(client.health()).resolves.toEqual({ health: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.test/api/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({
          "CF-Access-Client-Id": "client-id",
          authorization: "Bearer agent-credential",
          "content-type": "application/json",
        }),
      }),
    );
  });

  test("applies custom headers to uploads while preserving owned upload headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-agent-upload-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "artifact.ipa");
    await writeFile(path, "artifact");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentGraphQLClient(
      "https://control.test",
      "agent-credential",
      10_000,
      {
        "CF-Access-Client-Secret": "client-secret",
        Authorization: "Bearer custom",
        "Content-Length": "1",
        "Content-Type": "text/plain",
        "X-Artifact-Filename": "custom",
      },
    );

    await client.uploadBuildArtifact({
      uploadId: "upload-1",
      path,
      filename: "App.ipa",
      contentType: "application/octet-stream",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.test/api/build-artifact-uploads/upload-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "CF-Access-Client-Secret": "client-secret",
          authorization: "Bearer agent-credential",
          "content-length": "8",
          "content-type": "application/octet-stream",
          "x-artifact-filename": "App.ipa",
        }),
      }),
    );
  });

  test("uploads artifacts larger than 100 MB without exceeding 16 MiB per request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-agent-transfer-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "AcmeApp.tar.gz");
    const uploadLength = 101 * 1024 * 1024 + 7;
    await writeFile(path, "");
    await truncate(path, uploadLength);
    let confirmedOffset = 0;
    const chunkSizes: number[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/complete")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/upload") && init.method === "HEAD") {
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": String(confirmedOffset) },
        });
      }
      if (url.endsWith("/upload") && init.method === "PATCH") {
        const headers = new Headers(init.headers);
        const size = Number(headers.get("content-length"));
        expect(Number(headers.get("upload-offset"))).toBe(confirmedOffset);
        chunkSizes.push(size);
        confirmedOffset += size;
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": String(confirmedOffset) },
        });
      }
      expect(init.method).toBe("POST");
      return Response.json({ status: "UPLOADING" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgentGraphQLClient(
      "https://control.test",
      "agent-credential",
    );

    await client.uploadBuildArtifactTransfer({
      transferId: "transfer-1",
      path,
      filename: "AcmeApp.tar.gz",
      contentType: "application/gzip",
      checksum: "a".repeat(64),
      signal: new AbortController().signal,
    });

    expect(confirmedOffset).toBe(uploadLength);
    expect(chunkSizes).toHaveLength(7);
    expect(Math.max(...chunkSizes)).toBe(16 * 1024 * 1024);
    expect(chunkSizes.every((size) => size <= 16 * 1024 * 1024)).toBe(true);
  });

  test("resumes from the server offset after an upload response is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-agent-transfer-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "AcmeApp.tar.gz");
    await writeFile(path, "data");
    let confirmedOffset = 0;
    let patchRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith("/complete"))
          return new Response(null, { status: 204 });
        if (url.endsWith("/upload") && init.method === "HEAD") {
          return new Response(null, {
            status: 204,
            headers: { "upload-offset": String(confirmedOffset) },
          });
        }
        if (url.endsWith("/upload") && init.method === "PATCH") {
          patchRequests += 1;
          confirmedOffset = 4;
          throw new Error("connection reset after upload");
        }
        return Response.json({ status: "UPLOADING" });
      }),
    );

    await new AgentGraphQLClient(
      "https://control.test",
      "agent-credential",
    ).uploadBuildArtifactTransfer({
      transferId: "transfer-1",
      path,
      filename: "AcmeApp.tar.gz",
      contentType: "application/gzip",
      checksum: createHash("sha256").update("data").digest("hex"),
      signal: new AbortController().signal,
    });

    expect(patchRequests).toBe(1);
    expect(confirmedOffset).toBe(4);
  });

  test("retries failed artifact download ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "control-agent-transfer-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "AcmeApp.tar.gz");
    let rangeRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/download")) {
          rangeRequests += 1;
          if (rangeRequests === 1)
            return new Response("retry", { status: 503 });
          return new Response("abc", { status: 206 });
        }
        return Response.json({
          status: "READY",
          uploadLength: 3,
          checksum: createHash("sha256").update("abc").digest("hex"),
          filename: "AcmeApp.tar.gz",
          contentType: "application/gzip",
          error: null,
        });
      }),
    );

    await expect(
      new AgentGraphQLClient(
        "https://control.test",
        "agent-credential",
      ).downloadBuildArtifactTransfer({
        transferId: "transfer-1",
        path,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ filename: "AcmeApp.tar.gz" });
    expect(rangeRequests).toBe(2);
  });

  test("applies headers to WebSocket upgrades with agent authorization taking precedence", () => {
    expect(
      agentWebSocketHeaders({
        server: "https://control.test",
        websocketServer: "wss://control.test/graphql",
        agentId: "agent-1",
        credential: "agent-credential",
        name: "build-agent",
        headers: {
          "CF-Access-Client-Id": "client-id",
          Authorization: "Bearer custom",
        },
      }),
    ).toEqual({
      "CF-Access-Client-Id": "client-id",
      authorization: "Bearer agent-credential",
    });
  });

  test("includes cancelled jobs so durable reconciliation can stop them", async () => {
    const client = new AgentGraphQLClient("http://control.test");
    vi.spyOn(client, "request").mockResolvedValue({
      agentJobs: [
        { id: "queued", status: "QUEUED" },
        { id: "cancelling", status: "CANCELLING" },
        { id: "cancelled", status: "CANCELLED" },
        { id: "done", status: "SUCCEEDED" },
      ],
    });

    await expect(client.pendingJobs("agent-1")).resolves.toEqual([
      { id: "queued", status: "QUEUED" },
      { id: "cancelling", status: "CANCELLING" },
      { id: "cancelled", status: "CANCELLED" },
    ]);
  });

  test("loads owned codebases with the configured reconciliation interval", async () => {
    const client = new AgentGraphQLClient("http://control.test");
    const request = vi.spyOn(client, "request").mockResolvedValue({
      agentCodebaseConfiguration: {
        refreshIntervalSeconds: 120,
        codebases: [
          {
            id: "codebase-1",
            folder: "/repo",
            canonicalOrigin: "example/repo",
          },
        ],
      },
    });

    await expect(client.agentCodebaseConfiguration()).resolves.toEqual({
      refreshIntervalSeconds: 120,
      codebases: [
        { id: "codebase-1", folder: "/repo", canonicalOrigin: "example/repo" },
      ],
    });
    expect(request.mock.calls[0]?.[0]).toContain(
      "query AgentCodebaseConfiguration",
    );
  });

  test("loads the agent's four cadence settings", async () => {
    const client = new AgentGraphQLClient("http://control.test");
    const settings = {
      agentId: "agent-1",
      codebaseScanIntervalSeconds: 60,
      jobReconciliationIntervalSeconds: 30,
      gitFetchIntervalSeconds: 900,
      heartbeatIntervalSeconds: 20,
    };
    const request = vi
      .spyOn(client, "request")
      .mockResolvedValue({ agentCadenceSettings: settings });

    await expect(client.cadenceSettings("agent-1")).resolves.toEqual(settings);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query AgentCadenceSettings"),
      { agentId: "agent-1" },
    );
  });
});

describe("subscribeToAgentEvents", () => {
  test("resubscribes after an operation error", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sinks: Array<Sink<{ agentEvents: { job: AgentJob } }>> = [];
    const client = {
      subscribe: vi.fn((_request, sink) => {
        sinks.push(sink);
        return () => undefined;
      }),
    } as unknown as Client;

    const unsubscribe = subscribeToAgentEvents(
      client,
      "agent-1",
      () => undefined,
    );
    sinks[0]?.error(new Error("server operation failed"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
