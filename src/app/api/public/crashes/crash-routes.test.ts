// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetRateLimitsForTests } from "@/lib/ios-registration-request";
import { CrashParseError } from "@/services/crashes/types";

const service = vi.hoisted(() => ({
  settings: vi.fn(),
  ingestCrashReport: vi.fn(),
  importDsymZip: vi.fn(),
  beginResumableUpload: vi.fn(),
  appendResumableChunk: vi.fn(),
  completeResumableUpload: vi.fn(),
  resumableUpload: vi.fn(),
  agentDwarfFile: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  optionalUserOrApiKeyRequest: vi.fn(),
  authorizeUserOrApiKeyRequest: vi.fn(),
  resolveRequestPrincipal: vi.fn(),
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    crashesService: service,
    agentControlService: {},
  }),
}));
vi.mock("@/services/auth", async () => {
  const principal = await vi.importActual<
    typeof import("@/services/auth/principal")
  >("@/services/auth/principal");
  return {
    ...auth,
    PrincipalResolutionError: principal.PrincipalResolutionError,
  };
});

import { GET as dwarfGet } from "@/app/api/agent/dsyms/[dsymId]/dwarf/route";
import { POST as dsymPost } from "@/app/api/dsyms/route";
import { PATCH as chunkPatch } from "@/app/api/dsyms/uploads/[uploadId]/route";
import { POST as dsymBegin } from "@/app/api/dsyms/uploads/route";
import { POST as crashPost } from "./route";

const anonymous = { principal: { kind: "anonymous" } };
const user = {
  principal: {
    kind: "user",
    userId: "user-1",
    email: "dev@example.com",
    sessionId: "session-1",
  },
};
const apiKey = {
  principal: {
    kind: "apiKey",
    apiKeyId: "key-1",
    userId: "user-1",
    name: "CI",
  },
};
const upload = {
  id: "upload-1",
  status: "READY",
  buildId: "42",
  url: null,
  projectName: "Acme",
  dsyms: [
    {
      id: "dsym-1",
      bundleName: "Acme.app.dSYM",
      shortVersion: "2.4.0",
      bundleVersion: "512",
      slices: [{ uuid: "776386D043863F249B215F7C02EB2873", arch: "arm64" }],
    },
  ],
};
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetRateLimitsForTests();
  directory = await mkdtemp(join(tmpdir(), "crash-routes-"));
  process.env.CRASH_DATA_DIRECTORY = directory;
  auth.optionalUserOrApiKeyRequest.mockResolvedValue(anonymous);
  auth.authorizeUserOrApiKeyRequest.mockResolvedValue(apiKey);
  service.settings.mockResolvedValue({ collectionEnabled: true });
  service.ingestCrashReport.mockResolvedValue({
    duplicate: false,
    crashes: [{ id: "crash-1", status: "PENDING" }],
  });
  service.importDsymZip.mockImplementation(
    async (input: { zipPath: string }) => {
      await rm(input.zipPath, { force: true });
      return { upload, duplicate: false };
    },
  );
});

afterEach(async () => {
  delete process.env.CRASH_DATA_DIRECTORY;
  await rm(directory, { recursive: true, force: true });
});

function crashRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/public/crashes", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("crash upload route", () => {
  test("stores an anonymous report and records where it came from", async () => {
    const response = await crashPost(
      crashRequest('{"bug_type":"309"}\n{}', {
        "x-crash-filename": encodeURIComponent("App 2026.ips"),
        "cf-connecting-ip": "203.0.113.7",
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      collected: true,
      duplicate: false,
      crashes: [{ id: "crash-1", status: "PENDING", url: "/crashes/crash-1" }],
    });
    const [input] = service.ingestCrashReport.mock.calls[0]!;
    expect(Buffer.from(input.bytes).toString()).toBe('{"bug_type":"309"}\n{}');
    expect(input.filename).toBe("App 2026.ips");
    expect(input.uploader).toEqual({
      source: "API",
      uploadedBy: null,
      apiKeyId: null,
      apiKeyName: null,
      clientIp: "203.0.113.7",
    });
  });

  test("decodes gzip bodies and caps the decoded size", async () => {
    await crashPost(
      crashRequest(gzipSync("report"), { "content-encoding": "gzip" }),
    );
    const [input] = service.ingestCrashReport.mock.calls[0]!;
    expect(Buffer.from(input.bytes).toString()).toBe("report");

    const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024));
    const response = await crashPost(
      crashRequest(bomb, { "content-encoding": "gzip" }),
    );
    expect(response.status).toBe(413);
  });

  test("answers 202 without storing while collection is off", async () => {
    service.settings.mockResolvedValue({ collectionEnabled: false });
    const response = await crashPost(crashRequest("{}"));
    expect(response.status).toBe(202);
    expect(service.ingestCrashReport).not.toHaveBeenCalled();
  });

  test("accepts signed-in uploads while collection is off", async () => {
    auth.optionalUserOrApiKeyRequest.mockResolvedValue(user);
    service.settings.mockResolvedValue({ collectionEnabled: false });
    const response = await crashPost(crashRequest("{}"));
    expect(response.status).toBe(201);
    expect(service.ingestCrashReport.mock.calls[0]![0].uploader).toMatchObject({
      source: "UPLOAD",
      uploadedBy: "dev@example.com",
    });
  });

  test("rate limits anonymous senders per address", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let index = 0; index < 30; index += 1) {
      expect((await crashPost(crashRequest("{}", headers))).status).toBe(201);
    }
    expect((await crashPost(crashRequest("{}", headers))).status).toBe(429);
  });

  test("maps parse failures and credential failures", async () => {
    service.ingestCrashReport.mockRejectedValueOnce(
      new CrashParseError(
        "Only crash reports (bug_type 309) can be symbolicated",
      ),
    );
    const parse = await crashPost(crashRequest("{}"));
    expect(parse.status).toBe(422);
    expect((await parse.json()).error.code).toBe("UNPROCESSABLE_CRASH_REPORT");

    auth.optionalUserOrApiKeyRequest.mockResolvedValue({
      response: Response.json({}, { status: 401 }),
    });
    expect((await crashPost(crashRequest("{}"))).status).toBe(401);
  });
});

describe("dSYM upload routes", () => {
  test("streams the multipart file part and its metadata", async () => {
    const form = new FormData();
    form.set("projectName", "Acme");
    form.set("buildId", "42");
    form.set("url", "https://ci.example.com/runs/42");
    form.set("file", new Blob(["zip bytes"]), "dSYMs.zip");
    let staged = "";
    service.importDsymZip.mockImplementationOnce(
      async (input: { zipPath: string }) => {
        staged = await readFile(input.zipPath, "utf8");
        return { upload, duplicate: false };
      },
    );
    const response = await dsymPost(
      new Request("http://localhost/api/dsyms", { method: "POST", body: form }),
    );
    expect(response.status).toBe(201);
    expect(staged).toBe("zip bytes");
    expect(service.importDsymZip).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "dSYMs.zip",
        sizeBytes: 9,
        metadata: {
          buildId: "42",
          url: "https://ci.example.com/runs/42",
          projectName: "Acme",
        },
        uploader: {
          source: "API",
          uploadedBy: "API key CI",
          apiKeyId: "key-1",
          ownerKey: "api-key:key-1",
        },
      }),
    );
    expect(await response.json()).toMatchObject({
      dsyms: [
        {
          id: "dsym-1",
          version: "2.4.0",
          build: "512",
          url: "/crashes/dsyms/dsym-1",
          slices: [
            { uuid: "776386D0-4386-3F24-9B21-5F7C02EB2873", arch: "arm64" },
          ],
        },
      ],
    });
  });

  test("accepts a raw zip body with metadata in the query", async () => {
    const response = await dsymPost(
      new Request(
        "http://localhost/api/dsyms?projectName=Acme&buildId=7&filename=App.dSYM.zip",
        {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: "zip",
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(service.importDsymZip.mock.calls[0]![0]).toMatchObject({
      filename: "App.dSYM.zip",
      metadata: { projectName: "Acme", buildId: "7", url: null },
    });
  });

  test("refuses other content types and missing credentials", async () => {
    const wrong = await dsymPost(
      new Request("http://localhost/api/dsyms", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "zip",
      }),
    );
    expect(wrong.status).toBe(415);

    auth.authorizeUserOrApiKeyRequest.mockResolvedValue({
      response: Response.json({}, { status: 401 }),
    });
    const unauthorized = await dsymPost(
      new Request("http://localhost/api/dsyms", { method: "POST", body: "x" }),
    );
    expect(unauthorized.status).toBe(401);
    expect(service.importDsymZip).not.toHaveBeenCalled();
  });

  test("starts a resumable upload and appends offset chunks", async () => {
    service.beginResumableUpload.mockResolvedValue({
      upload: { id: "upload-2" },
      chunkBytes: 16 * 1024 * 1024,
    });
    const started = await dsymBegin(
      new Request("http://localhost/api/dsyms/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "dSYMs.zip", sizeBytes: 10 }),
      }),
    );
    expect(started.status).toBe(201);
    expect(service.beginResumableUpload.mock.calls[0]![0]).toMatchObject({
      sizeBytes: 10,
      sha256: null,
    });

    service.appendResumableChunk.mockResolvedValue({
      uploadOffset: 4,
      sizeBytes: 10,
    });
    const context = { params: Promise.resolve({ uploadId: "upload-2" }) };
    const chunk = await chunkPatch(
      new Request("http://localhost/api/dsyms/uploads/upload-2", {
        method: "PATCH",
        headers: { "upload-offset": "0" },
        body: "abcd",
      }),
      context,
    );
    expect(chunk.status).toBe(204);
    expect(chunk.headers.get("upload-offset")).toBe("4");
    expect(service.appendResumableChunk.mock.calls[0]![0]).toMatchObject({
      id: "upload-2",
      ownerKey: "api-key:key-1",
      offset: 0,
    });

    const missing = await chunkPatch(
      new Request("http://localhost/api/dsyms/uploads/upload-2", {
        method: "PATCH",
        body: "abcd",
      }),
      context,
    );
    expect(missing.status).toBe(400);
  });
});

describe("agent DWARF route", () => {
  test("serves a DWARF file with ranges only to an agent that needs it", async () => {
    const path = join(directory, "dwarf");
    await writeFile(path, "0123456789");
    auth.resolveRequestPrincipal.mockResolvedValue({
      kind: "agent",
      agentId: "agent-1",
    });
    service.agentDwarfFile.mockResolvedValue({
      path,
      size: 10,
      sha256: "digest",
      filename: "App",
    });
    const context = { params: Promise.resolve({ dsymId: "dsym-1" }) };
    const ranged = await dwarfGet(
      new Request("http://localhost/api/agent/dsyms/dsym-1/dwarf", {
        headers: { range: "bytes=2-5" },
      }),
      context,
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("2345");
    expect(service.agentDwarfFile).toHaveBeenCalledWith("agent-1", "dsym-1");

    service.agentDwarfFile.mockResolvedValue(null);
    const refused = await dwarfGet(
      new Request("http://localhost/api/agent/dsyms/dsym-1/dwarf"),
      context,
    );
    expect(refused.status).toBe(403);

    auth.resolveRequestPrincipal.mockResolvedValue({ kind: "anonymous" });
    const anonymousRequest = await dwarfGet(
      new Request("http://localhost/api/agent/dsyms/dsym-1/dwarf"),
      context,
    );
    expect(anonymousRequest.status).toBe(401);
  });
});
