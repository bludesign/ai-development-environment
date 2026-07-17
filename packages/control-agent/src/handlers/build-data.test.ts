import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { captureCommand } from "../capture-command.js";
import { deleteBuildData, scanBuildData, sizeBuildData } from "./build-data.js";

vi.mock("../capture-command.js", () => ({ captureCommand: vi.fn() }));

const temporaryDirectories: string[] = [];
const capture = vi.mocked(captureCommand);

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "build-data-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  capture.mockResolvedValue({
    exitCode: 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "Missing WorkspacePath",
  });
});

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const signal = () => new AbortController().signal;
const log = async () => undefined;

describe("Build Data agent handlers", () => {
  test("scans project, pending, and shared-cache directories without following directory symlinks", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "App-abcdef");
    await mkdir(project);
    await writeFile(
      join(project, "info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
       <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
       <plist version="1.0"><dict><key>WorkspacePath</key><string>/Repos/App/App.xcodeproj</string></dict></plist>`,
    );
    await mkdir(join(root, "Starting-abcdef"));
    await mkdir(join(root, "CompilationCache.noindex"));
    await symlink(project, join(root, "Linked-project"));
    capture.mockImplementation(async ({ args }) => {
      const isProject = args.at(-1)?.endsWith(join("App-abcdef", "info.plist"));
      return {
        exitCode: isProject ? 0 : 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: isProject ? "/Repos/App/App.xcodeproj\n" : "",
        stderr: isProject ? "" : "Missing WorkspacePath",
      };
    });

    const result = (await scanBuildData(
      { mode: "ABSOLUTE", path: root, worktrees: [] },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof scanBuildData>> & {
      entries: Array<{
        name: string;
        kind: string;
        workspacePath: string | null;
      }>;
      warnings: string[];
    };

    expect(result.entries).toEqual([
      expect.objectContaining({
        name: "App-abcdef",
        kind: "PROJECT",
        workspacePath: "/Repos/App/App.xcodeproj",
      }),
      expect.objectContaining({
        name: "CompilationCache.noindex",
        kind: "SHARED_CACHE",
      }),
      expect.objectContaining({ name: "Starting-abcdef", kind: "PENDING" }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("scans the configured folder beneath each relative worktree", async () => {
    const parent = await temporaryDirectory();
    const first = join(parent, "first");
    const second = join(parent, "second");
    await mkdir(join(first, "DerivedData", "First-hash"), { recursive: true });
    await mkdir(join(second, "DerivedData", "Second-hash"), {
      recursive: true,
    });

    const result = (await scanBuildData(
      {
        mode: "RELATIVE",
        path: "DerivedData",
        worktrees: [
          { id: "first", folder: first },
          { id: "second", folder: second },
        ],
      },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof scanBuildData>> & {
      entries: Array<{ name: string }>;
    };

    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      "First-hash",
      "Second-hash",
    ]);
  });

  test("calculates allocated usage and only deletes validated direct children", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "DerivedData");
    const target = join(root, "App-hash");
    const outside = join(parent, "outside");
    await mkdir(target, { recursive: true });
    await mkdir(outside);
    await writeFile(join(target, "artifact"), "artifact data");
    const canonicalRoot = await realpath(root);
    const canonicalTarget = join(canonicalRoot, "App-hash");
    const canonicalOutside = await realpath(outside);

    const sized = (await sizeBuildData(
      { targets: [{ rootPath: canonicalRoot, path: canonicalTarget }] },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof sizeBuildData>> & {
      sizes: Array<{ sizeBytes: number | null; error: string | null }>;
    };
    expect(sized.sizes[0]?.sizeBytes).toBeGreaterThan(0);
    expect(sized.sizes[0]?.error).toBeNull();

    const deleted = (await deleteBuildData(
      {
        targets: [
          { rootPath: canonicalRoot, path: canonicalTarget },
          { rootPath: canonicalRoot, path: canonicalOutside },
        ],
      },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof deleteBuildData>> & {
      deleted: Array<{ deleted: boolean; error: string | null }>;
    };
    expect(deleted.deleted[0]).toMatchObject({ deleted: true, error: null });
    expect(deleted.deleted[1]?.deleted).toBe(false);
    expect(deleted.deleted[1]?.error).toContain("direct child");
    await expect(readFile(join(canonicalTarget, "artifact"))).rejects.toThrow();
    expect((await lstat(canonicalOutside)).isDirectory()).toBe(true);
  });

  test("rejects unsafe relative settings before scanning worktrees", async () => {
    await expect(
      scanBuildData(
        {
          mode: "RELATIVE",
          path: "../DerivedData",
          worktrees: [{ id: "worktree", folder: "/tmp/worktree" }],
        },
        10_000,
        signal(),
        log,
      ),
    ).rejects.toThrow("safe relative path");
  });
});
