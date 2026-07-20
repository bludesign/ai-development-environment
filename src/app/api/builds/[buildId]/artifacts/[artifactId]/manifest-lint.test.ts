import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getServerServices = vi.hoisted(() => vi.fn());
vi.mock("@/services/server-services", () => ({ getServerServices }));

import { GET as manifest } from "@/app/api/builds/[buildId]/artifacts/[artifactId]/manifest.plist/route";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

beforeEach(() => {
  process.env.OTA_TOKEN_SECRET = "test-secret";
  getServerServices.mockReturnValue({
    buildsService: {
      artifactForInstall: vi.fn(async () => ({
        id: "artifact-1",
        kind: "IPA",
        relativePath: "exports/export-1/App.ipa",
        sizeBytes: 1024,
        checksum: "checksum-1",
        createdAt: "2026-07-19T00:00:00.000Z",
        metadata: {
          exportMethod: "RELEASE_TESTING",
          bundleIdentifier: "com.example.App",
          bundleShortVersion: "2.1.0",
          bundleVersion: "417",
          applicationName: "Ben & Jerry's <Example>",
        },
      })),
    },
  });
});

afterEach(async () => {
  delete process.env.OTA_TOKEN_SECRET;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// plutil ships with macOS only; the assertions below are about Apple's parser,
// so there is nothing meaningful to check without it.
const withPlutil = existsSync("/usr/bin/plutil") ? test : test.skip;

describe("install manifest against Apple's own parser", () => {
  withPlutil(
    "plutil accepts the manifest and reads back the install keys",
    async () => {
      const response = await manifest(
        new Request(
          "http://127.0.0.1:3000/api/builds/build-1/artifacts/artifact-1/manifest.plist",
          {
            headers: {
              "x-forwarded-proto": "https",
              "x-forwarded-host": "builds.example.com",
            },
          },
        ),
        {
          params: Promise.resolve({
            buildId: "build-1",
            artifactId: "artifact-1",
          }),
        },
      );
      expect(response.status).toBe(200);

      const root = await mkdtemp(join(tmpdir(), "ade-manifest-lint-"));
      roots.push(root);
      const path = join(root, "manifest.plist");
      await writeFile(path, await response.text());

      // plutil is the parser iOS itself uses; a malformed document fails here.
      const lint = await execFileAsync("/usr/bin/plutil", ["-lint", path]);
      expect(lint.stdout).toContain("OK");

      const read = async (keyPath: string) =>
        (
          await execFileAsync("/usr/bin/plutil", [
            "-extract",
            keyPath,
            "raw",
            "-o",
            "-",
            path,
          ])
        ).stdout.trim();

      expect(await read("items.0.metadata.bundle-identifier")).toBe(
        "com.example.App",
      );
      expect(await read("items.0.metadata.bundle-version")).toBe("2.1.0");
      expect(await read("items.0.metadata.kind")).toBe("software");
      // Round-trips through XML escaping without corruption.
      expect(await read("items.0.metadata.title")).toBe(
        "Ben & Jerry's <Example>",
      );
      expect(await read("items.0.assets.0.kind")).toBe("software-package");
      expect(await read("items.0.assets.0.url")).toMatch(
        /^https:\/\/builds\.example\.com\/api\/builds\/build-1\/artifacts\/artifact-1\?token=/,
      );
    },
  );
});
