import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Client, Sink } from "graphql-ws";

import {
  AgentGraphQLClient,
  agentWebSocketHeaders,
  subscribeToAgentEvents,
  type AgentJob,
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
        { id: "cancelled", status: "CANCELLED" },
        { id: "done", status: "SUCCEEDED" },
      ],
    });

    await expect(client.pendingJobs("agent-1")).resolves.toEqual([
      { id: "queued", status: "QUEUED" },
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
