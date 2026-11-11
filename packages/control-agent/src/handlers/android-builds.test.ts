import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  androidAssembleTask,
  parseAndroidBuildSettings,
} from "@ai-development-environment/agent-contract/builds";
import {
  adbDevices,
  findAndroidApk,
  parseAndroidVariants,
} from "./android-builds.js";

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

test("rejects an APK output symlink that leaves the worktree", async () => {
  await symlink(tmpdir(), join(root, "external.apk"));
  await expect(
    findAndroidApk(root, root, {
      module: ":app",
      variant: "debug",
      apkPath: "external.apk",
    }),
  ).rejects.toThrow("within the worktree");
});

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
