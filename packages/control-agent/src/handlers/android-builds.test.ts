import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  androidAssembleTask,
  BUILD_ENDPOINT_PATHS,
  parseAndroidBuildSettings,
} from "@ai-development-environment/agent-contract/builds";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { androidTools } from "../android-tools.js";
import {
  adbDevices,
  findAndroidApk,
  parseAndroidVariants,
  runAndroidBuild,
} from "./android-builds.js";

vi.mock("../android-tools.js", () => ({ androidTools: vi.fn() }));

let root: string;
let output: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aide-android-build-")));
  output = join(root, "app", "build", "outputs", "apk", "demo", "debug");
  await mkdir(output, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

test("normalizes Gradle project paths and qualifies the selected flavor task", () => {
  const settings = parseAndroidBuildSettings({
    projectPath: "./android/",
    module: ":mobile:app",
    variant: "demoDebug",
  });
  expect(settings.projectPath).toBe("android");
  expect(androidAssembleTask(settings)).toBe(":mobile:app:assembleDemoDebug");
  expect(androidAssembleTask({ module: ":", variant: "release" })).toBe(
    ":assembleRelease",
  );
  expect(() =>
    parseAndroidBuildSettings({ ...settings, projectPath: "../other" }),
  ).toThrow("within the worktree");
});

test("selects the universal APK for the exact requested variant", async () => {
  const universal = join(output, "app-universal.apk");
  await writeFile(universal, "apk");
  await writeFile(join(output, "app-arm64.apk"), "apk");
  await writeFile(
    join(output, "output-metadata.json"),
    JSON.stringify({
      variantName: "demoDebug",
      elements: [
        {
          outputFile: "app-arm64.apk",
          filters: [{ filterType: "ABI", value: "arm64-v8a" }],
        },
        { outputFile: "app-universal.apk", filters: [] },
      ],
    }),
  );
  const settings = { module: ":app", variant: "demoDebug", apkPath: null };
  await expect(findAndroidApk(root, root, settings)).resolves.toBe(universal);
  await expect(
    findAndroidApk(root, root, { ...settings, variant: "otherDebug" }),
  ).rejects.toThrow("standalone APK");
});

test("rejects explicit and Gradle-reported APK paths that leave the worktree", async () => {
  await symlink(tmpdir(), join(root, "external.apk"));
  await expect(
    findAndroidApk(root, root, {
      module: ":app",
      variant: "debug",
      apkPath: "external.apk",
    }),
  ).rejects.toThrow("within the worktree");
  await expect(
    findAndroidApk(
      root,
      root,
      { module: ":app", variant: "debug", apkPath: null },
      join(root, "external.apk"),
    ),
  ).rejects.toThrow("within the worktree");
});

test.each([
  { name: "signed", signatureError: null, signed: true },
  {
    name: "unsigned",
    signatureError: "Missing META-INF/MANIFEST.MF",
    signed: false,
  },
  {
    name: "invalid signature",
    signatureError: "APK Signature Scheme v2 signer #1: Digest did not verify",
    signed: null,
  },
])(
  "captures the Gradle-reported APK with $name",
  async ({ signatureError, signed }) => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    const origin = "https://example.com/android-app.git";
    git("init", "--quiet", "--initial-branch=main");
    git("remote", "add", "origin", origin);
    git(
      "-c",
      "user.name=Build Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Initial commit",
    );
    await writeFile(
      join(root, "gradlew"),
      `#!/bin/sh
set -eu
test "$AIDE_ANDROID_BUILD_MODULE" = :app
test "$AIDE_ANDROID_BUILD_VARIANT" = release
while [ "$#" -gt 1 ]; do shift; done
test "$1" = :app:assembleRelease
output="$PWD/custom-build/mobile/outputs/apk/release"
mkdir -p "$output"
printf 'test apk' > "$output/mobile-release.apk"
printf '%s' '{"variantName":"release","elements":[{"outputFile":"mobile-release.apk"}]}' > "$output/output-metadata.json"
printf '"%s"' "$output" > "$AIDE_ANDROID_APK_OUTPUT"
`,
    );
    const apksigner = join(root, "apksigner");
    const apkanalyzer = join(root, "apkanalyzer");
    await writeFile(
      apksigner,
      signatureError
        ? `#!/bin/sh\nprintf '%s\\n' 'DOES NOT VERIFY' 'ERROR: ${signatureError}' >&2\nexit 1\n`
        : "#!/bin/sh\nexit 0\n",
      { mode: 0o700 },
    );
    await writeFile(
      apkanalyzer,
      `#!/bin/sh
case "$1:$2" in
  manifest:application-id) printf '%s' example.android ;;
  manifest:version-name) printf '%s' 1.0 ;;
  manifest:version-code) printf '%s' 1 ;;
  manifest:min-sdk) printf '%s' 23 ;;
  manifest:print) printf '%s' '<manifest package="example.android" />' ;;
  files:list) printf '%s' '/AndroidManifest.xml' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    vi.mocked(androidTools).mockReturnValue({
      sdk: root,
      hasWorkingJava: async () => true,
      apksigner,
      apkanalyzer,
      adb: undefined,
      emulator: undefined,
      avdmanager: undefined,
      sdkmanager: undefined,
    });
    const buildId = "android-build";
    const worktreeId = "android-worktree";
    const projectPath = ".";
    const cacheKey = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 16);
    const buildRoot = join(root, "artifacts");
    const artifactDirectory = join(buildRoot, buildId);
    const result = await runAndroidBuild(
      {
        buildId,
        codebaseId: "android-codebase",
        worktreeId,
        branch: "main",
        folder: root,
        gitDirectory: join(root, ".git"),
        expectedOrigin: normalizeGitOrigin(origin).canonicalOrigin,
        headSha: git("rev-parse", "HEAD"),
        artifactDirectory,
        gradleCachePath: join(
          buildRoot,
          ".android-gradle",
          worktreeId,
          cacheKey,
        ),
        settings: { projectPath, module: ":app", variant: "release" },
        server: {
          localBaseUrl: "http://localhost:3000",
          remoteBaseUrl: "https://example.com",
          selectedUrlKind: "REMOTE",
          selectedBaseUrl: "https://example.com",
        },
        telemetry: {
          consoleCollectionEnabled: true,
          analyticsCollectionEnabled: false,
        },
        endpointPaths: BUILD_ENDPOINT_PATHS,
        scripts: [
          {
            id: "check-context",
            name: "Check build context",
            position: 0,
            timeoutSeconds: 5,
            failureBehavior: "FAIL_BUILD",
            preBuildScript: `import assert from "node:assert/strict";
export default function (build) {
  assert.equal(build.destination.platformId, "ANDROID");
  assert.equal(build.server.selectedBaseUrl, "https://example.com");
  assert.equal(build.endpointPaths.consoleLogs, "${BUILD_ENDPOINT_PATHS.consoleLogs}");
  assert.equal(build.telemetry.consoleCollectionEnabled, true);
  assert.equal(process.env.SERVER_BASE_URL, build.server.selectedBaseUrl);
  assert.equal(process.env.CONSOLE_LOGS_PATH, build.endpointPaths.consoleLogs);
  assert.equal(process.env.CONSOLE_LOG_COLLECTION_ENABLED, "true");
}`,
          },
        ],
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect(result).toMatchObject({
      scriptExecutions: [{ phase: "PRE_BUILD", status: "SUCCEEDED" }],
    });
    if (signed === null) {
      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "APK_CAPTURE_FAILED",
      });
      await expect(
        readFile(join(artifactDirectory, "application.apk")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result).toMatchObject({
        exitCode: 0,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: "APK",
            checksum: createHash("sha256").update("test apk").digest("hex"),
            metadata: expect.objectContaining({ signed }),
          }),
        ]),
      });
      await expect(
        readFile(join(artifactDirectory, "application.apk"), "utf8"),
      ).resolves.toBe("test apk");
    }
  },
);

test("returns discovered Gradle variants and excludes emulators from connected devices", () => {
  expect(
    parseAndroidVariants(
      [
        'ADE_ANDROID_VARIANT={"module":":app","variant":"demoDebug"}',
        'ADE_ANDROID_VARIANT={"module":":app","variant":"demoRelease"}',
        'ADE_ANDROID_VARIANT={"module":":app","variant":"demoDebug"}',
      ].join("\n"),
    ),
  ).toEqual([{ module: ":app", variants: ["demoDebug", "demoRelease"] }]);
  expect(
    adbDevices(
      "emulator-5554 device model:sdk\n123 unauthorized usb:0\n456 device model:Pixel_8",
    ),
  ).toMatchObject([
    { id: "123", available: false, state: "unauthorized" },
    { id: "456", available: true, name: "Pixel 8" },
  ]);
});
