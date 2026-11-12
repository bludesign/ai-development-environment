import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { captureCommand } from "../capture-command.js";
import {
  collectAgentDiskSpace,
  ownedWorktreeBuildData,
  deleteBuildData,
  scanBuildData,
  sizeBuildData,
} from "./build-data.js";

vi.mock("../capture-command.js", () => ({ captureCommand: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));

const temporaryDirectories: string[] = [];
const capture = vi.mocked(captureCommand);
const originalDeviceSupportDirectory =
  process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY;

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "build-data-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(async () => {
  vi.mocked(homedir).mockReturnValue(await temporaryDirectory());
  process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY = join(
    tmpdir(),
    `missing-device-support-${process.pid}`,
  );
  capture.mockResolvedValue({
    exitCode: 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "Missing WorkspacePath",
    outputTruncated: false,
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

afterAll(() => {
  if (originalDeviceSupportDirectory === undefined) {
    delete process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY;
  } else {
    process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY =
      originalDeviceSupportDirectory;
  }
});

const signal = () => new AbortController().signal;
const log = async () => undefined;

describe("Build Data agent handlers", () => {
  test("sizes and deletes a Gradle cache with its generated Android module outputs", async () => {
    const builds = await realpath(await temporaryDirectory());
    const worktreePath = await realpath(await temporaryDirectory());
    const projectPath = ".";
    const worktreeId = "android-worktree";
    const rootPath = join(builds, ".android-gradle", worktreeId);
    const path = join(
      rootPath,
      createHash("sha256").update(projectPath).digest("hex").slice(0, 16),
    );
    const generated = join(worktreePath, "app", "build", "outputs", "apk");
    const tracked = join(worktreePath, "tracked", "build", "outputs", "apk");
    await Promise.all(
      [path, generated, tracked].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(
      join(path, ".aide-android-gradle.json"),
      JSON.stringify({
        worktreeId,
        worktreePath,
        projectPath,
        module: ":app",
        modules: [":tracked"],
      }),
    );
    await writeFile(join(generated, "generated.apk"), Buffer.alloc(4096));
    const retained = join(tracked, "tracked.apk");
    await writeFile(retained, "tracked");
    capture.mockImplementation(async ({ args }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stderr: "",
      outputTruncated: false,
      stdout:
        args[0] === "ls-files" && args.includes("tracked/build/")
          ? "tracked/build/outputs/apk/tracked.apk\0"
          : "",
    }));
    const configuration = {
      mode: "ABSOLUTE" as const,
      path: join(builds, "legacy"),
      managedRoot: join(builds, ".worktree-derived-data"),
    };
    const scan = await scanBuildData(
      { ...configuration, worktrees: [] },
      10_000,
      signal(),
      log,
    );
    expect(scan).toMatchObject({
      entries: [
        { path, rootPath, kind: "GRADLE_PROJECT", workspacePath: worktreePath },
      ],
    });
    const target = { path, rootPath };
    const size = await sizeBuildData(
      { targets: [target] },
      10_000,
      signal(),
      log,
    );
    expect(size).toMatchObject({
      sizes: [{ path, sizeBytes: expect.any(Number), error: null }],
    });
    expect(
      await deleteBuildData({ targets: [target] }, 10_000, signal(), log),
    ).toMatchObject({ deleted: [{ path, deleted: true, error: null }] });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(generated)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(retained, "utf8")).toBe("tracked");
  });
  test("discovers and deletes only the removed worktree's managed cache without an Xcode plist", async () => {
    const root = await realpath(await temporaryDirectory());
    const folder = await realpath(await temporaryDirectory());
    const sibling = await realpath(await temporaryDirectory());
    const managedRoot = join(root, ".worktree-derived-data");
    for (const [id, source] of [
      ["worktree-a", folder],
      ["worktree-b", sibling],
    ]) {
      await mkdir(join(managedRoot, id!), { recursive: true });
      await writeFile(
        join(managedRoot, id!, ".aide-worktree.json"),
        JSON.stringify({ version: 1, worktreeId: id, folder: source }),
      );
    }
    const configuration = {
      mode: "ABSOLUTE" as const,
      path: join(root, "legacy"),
      managedRoot,
    };
    const scan = (await scanBuildData(
      { ...configuration, worktrees: [] },
      10_000,
      signal(),
      log,
    )) as unknown as {
      entries: Array<{ path: string; workspacePath: string; kind: string }>;
    };
    expect(scan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(managedRoot, "worktree-a"),
          workspacePath: folder,
          kind: "PROJECT",
        }),
      ]),
    );
    const owned = await ownedWorktreeBuildData(
      folder,
      configuration,
      10_000,
      signal(),
    );
    expect(owned.targets).toEqual([
      { path: join(managedRoot, "worktree-a"), rootPath: managedRoot },
    ]);
    await deleteBuildData({ targets: owned.targets }, 10_000, signal(), log);
    expect(
      await readFile(
        join(managedRoot, "worktree-b", ".aide-worktree.json"),
        "utf8",
      ),
    ).toContain("worktree-b");
  });
  test("deletes only Xcode project data owned by the removed worktree", async () => {
    const root = await realpath(await temporaryDirectory());
    const folder = await realpath(await temporaryDirectory());
    const other = await realpath(await temporaryDirectory());
    await mkdir(join(folder, "App.xcodeproj"));
    await mkdir(join(other, "Other.xcodeproj"));
    await symlink(
      join(other, "Other.xcodeproj"),
      join(folder, "Linked.xcodeproj"),
    );
    const workspaceByName = new Map([
      ["Owned", join(folder, "App.xcodeproj")],
      ["Sibling", join(`${folder}-sibling`, "App.xcodeproj")],
      ["Other", join(other, "Other.xcodeproj")],
      ["Symlinked", join(folder, "Linked.xcodeproj")],
      ["Cache.noindex", join(folder, "App.xcodeproj")],
    ]);
    for (const name of workspaceByName.keys()) await mkdir(join(root, name));
    capture.mockImplementation(async ({ args }) => {
      const entry = [...workspaceByName].find(
        ([name]) => args.at(-1) === join(root, name, "info.plist"),
      );
      return {
        exitCode: entry ? 0 : 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: entry?.[1] ?? "",
        stderr: "",
        outputTruncated: false,
      };
    });
    const owned = await ownedWorktreeBuildData(
      folder,
      { mode: "ABSOLUTE", path: root },
      10_000,
      signal(),
    );
    expect(owned).toEqual({
      targets: [{ path: join(root, "Owned"), rootPath: root }],
      warnings: [],
    });
    await deleteBuildData({ targets: owned.targets }, 10_000, signal(), log);
    await expect(lstat(join(root, "Owned"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(join(root, "Other"))).isDirectory()).toBe(true);
    expect((await lstat(join(root, "Cache.noindex"))).isDirectory()).toBe(true);
  });

  test("treats absent Xcode build roots as no cleanup and leaves relative data to worktree removal", async () => {
    const folder = await realpath(await temporaryDirectory());
    expect(
      await ownedWorktreeBuildData(
        folder,
        { mode: "ABSOLUTE", path: join(folder, "missing") },
        10_000,
        signal(),
      ),
    ).toEqual({ targets: [], warnings: [] });
    await mkdir(join(folder, "App.xcodeproj"));
    await mkdir(join(folder, "DerivedData", "Owned"), { recursive: true });
    capture.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: join(folder, "App.xcodeproj"),
      stderr: "",
      outputTruncated: false,
    });
    expect(
      (
        await ownedWorktreeBuildData(
          folder,
          { mode: "RELATIVE", path: "DerivedData" },
          10_000,
          signal(),
        )
      ).targets,
    ).toEqual([]);
  });
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
        outputTruncated: false,
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

  test("scans Apple platform Device Support and honors the iOS override without following discovered symlinks", async () => {
    const derivedData = await temporaryDirectory();
    const deviceSupport = await temporaryDirectory();
    process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY = deviceSupport;
    await mkdir(join(deviceSupport, "iPhone17,1 26.0 (23A123)"));
    const outside = await temporaryDirectory();
    await symlink(outside, join(deviceSupport, "Linked Support"));
    const xcode = join(homedir(), "Library", "Developer", "Xcode");
    await mkdir(join(xcode, "iOS DeviceSupport", "Ignored built-in iOS"), {
      recursive: true,
    });
    await mkdir(join(xcode, "tvOS DeviceSupport", "26.0 (23J123)"), {
      recursive: true,
    });
    await mkdir(join(xcode, "watchOS DeviceSupport", "26.0 (23R123)"), {
      recursive: true,
    });
    await mkdir(join(xcode, "xrOS DeviceSupport", "26.0 (23M123)"), {
      recursive: true,
    });
    await symlink(outside, join(xcode, "Linked DeviceSupport"));

    const result = (await scanBuildData(
      { mode: "ABSOLUTE", path: derivedData, worktrees: [] },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof scanBuildData>> & {
      entries: Array<{ name: string; kind: string; rootPath: string }>;
    };

    expect(result.entries).toHaveLength(4);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "iPhone17,1 26.0 (23A123)",
          kind: "DEVICE_SUPPORT",
          deviceSupportPlatform: "iOS",
          rootPath: await realpath(deviceSupport),
        }),
        expect.objectContaining({
          name: "26.0 (23J123)",
          deviceSupportPlatform: "tvOS",
        }),
        expect.objectContaining({
          name: "26.0 (23R123)",
          deviceSupportPlatform: "watchOS",
        }),
        expect.objectContaining({
          name: "26.0 (23M123)",
          deviceSupportPlatform: "visionOS",
        }),
      ]),
    );
  });

  test("scans the legacy iOS Device Support symlink without following discovered symlinks", async () => {
    delete process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY;
    const xcode = join(homedir(), "Library", "Developer", "Xcode");
    const deviceSupport = await realpath(await temporaryDirectory());
    const outside = await temporaryDirectory();
    await mkdir(xcode, { recursive: true });
    await mkdir(join(deviceSupport, "iPhone 26.0"));
    await mkdir(join(outside, "Unrelated cache"));
    await symlink(deviceSupport, join(xcode, "iOS DeviceSupport"));
    await symlink(outside, join(xcode, "tvOS DeviceSupport"));
    await symlink(outside, join(deviceSupport, "Linked Support"));

    const result = (await scanBuildData(
      { mode: "DEFAULT", path: null, worktrees: [] },
      10_000,
      signal(),
      log,
    )) as Awaited<ReturnType<typeof scanBuildData>> & { entries: unknown[] };

    expect(result.entries).toEqual([
      expect.objectContaining({
        path: join(deviceSupport, "iPhone 26.0"),
        rootPath: deviceSupport,
        kind: "DEVICE_SUPPORT",
        deviceSupportPlatform: "iOS",
      }),
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

  test("deduplicates filesystem roles and reports direct-child modification dates", async () => {
    const root = await temporaryDirectory();
    const entry = join(root, "App-hash");
    await mkdir(entry);
    const modifiedAt = new Date("2025-02-03T04:05:06.000Z");
    await utimes(entry, modifiedAt, modifiedAt);
    capture.mockImplementation(async ({ command }) => ({
      exitCode: command === "/usr/sbin/diskutil" ? 0 : 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout:
        command === "/usr/sbin/diskutil"
          ? '<?xml version="1.0"?><plist version="1.0"><dict><key>APFSContainerReference</key><string>disk3</string></dict></plist>'
          : "",
      stderr: "",
      outputTruncated: false,
    }));

    const report = await collectAgentDiskSpace(
      {
        enabled: true,
        pollIntervalSeconds: 60,
        baseRepoDirectory: root,
        derivedDataLocationMode: "ABSOLUTE",
        derivedDataPath: root,
        worktrees: [],
      },
      signal(),
    );

    const configuredVolume = report.volumes.find((volume) =>
      volume.roles.includes("DERIVED_DATA"),
    );
    expect(configuredVolume?.roles).toEqual(
      expect.arrayContaining(["BASE_REPO", "DERIVED_DATA"]),
    );
    expect(configuredVolume?.capacityId).toBe("apfs:disk3");
    const canonicalRoot = await realpath(root);
    expect(configuredVolume?.paths).toEqual(
      expect.arrayContaining([canonicalRoot]),
    );
    expect(
      configuredVolume?.paths.filter((path) => path === canonicalRoot),
    ).toHaveLength(1);
    expect(report.entries).toEqual([
      expect.objectContaining({
        path: join(canonicalRoot, "App-hash"),
        modifiedAt: modifiedAt.toISOString(),
        volumeId: configuredVolume?.id,
      }),
    ]);
    expect(report.observedAt).toEqual(expect.any(String));
  });

  test("surfaces missing configured filesystem paths without failing the poll", async () => {
    const root = await temporaryDirectory();
    const missing = join(root, "missing-base-repository");
    const report = await collectAgentDiskSpace(
      {
        enabled: true,
        pollIntervalSeconds: 60,
        baseRepoDirectory: missing,
        derivedDataLocationMode: "ABSOLUTE",
        derivedDataPath: root,
        worktrees: [],
      },
      signal(),
    );

    expect(report.volumes.some((volume) => volume.roles.includes("MAIN"))).toBe(
      true,
    );
    expect(
      report.warnings.some((warning) => warning.startsWith(`${missing}:`)),
    ).toBe(true);
  });

  test("monitors the parent volume before a Derived Data directory exists", async () => {
    const root = await temporaryDirectory();
    const relativePath = join("Library", "Developer", "Xcode", "DerivedData");
    const missing = join(root, relativePath);
    const report = await collectAgentDiskSpace(
      {
        enabled: true,
        pollIntervalSeconds: 60,
        baseRepoDirectory: null,
        derivedDataLocationMode: "ABSOLUTE",
        derivedDataPath: missing,
        worktrees: [],
      },
      signal(),
    );

    const derivedDataVolume = report.volumes.find((volume) =>
      volume.roles.includes("DERIVED_DATA"),
    );
    expect(derivedDataVolume?.paths).toContain(
      join(await realpath(root), relativePath),
    );
    expect(
      report.warnings.some((warning) => warning.startsWith(`${missing}:`)),
    ).toBe(false);
  });
});
