import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function executable(path: string): string | undefined {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

function directories(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((name) => !name.startsWith("."))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function hasWorkingJava(signal?: AbortSignal): Promise<boolean> {
  const java = process.env.JAVA_HOME
    ? executable(join(process.env.JAVA_HOME, "bin", "java"))
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((path) => executable(join(path, "java")))
        .find(Boolean);
  if (!java) return false;
  // macOS installs a Java launcher even on machines with no runtime.
  return execFileAsync(java, ["-version"], {
    timeout: 2_000,
    killSignal: "SIGKILL",
    signal,
  }).then(
    () => true,
    () => false,
  );
}

export function androidTools() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(
      homedir(),
      ...(process.platform === "darwin"
        ? ["Library", "Android", "sdk"]
        : ["Android", "Sdk"]),
    );
  const sdkTool = (...parts: string[]) =>
    isAbsolute(sdk) ? executable(join(sdk, ...parts)) : undefined;
  const commandLineTool = (name: string) =>
    ["latest", ...directories(join(sdk, "cmdline-tools"))]
      .map((version) => sdkTool("cmdline-tools", version, "bin", name))
      .find(Boolean);
  return {
    sdk,
    hasWorkingJava,
    adb: sdkTool("platform-tools", "adb"),
    emulator: sdkTool("emulator", "emulator"),
    avdmanager: commandLineTool("avdmanager"),
    sdkmanager: commandLineTool("sdkmanager"),
    apkanalyzer: commandLineTool("apkanalyzer"),
    apksigner: directories(join(sdk, "build-tools"))
      .map((version) => sdkTool("build-tools", version, "apksigner"))
      .find(Boolean),
  };
}
