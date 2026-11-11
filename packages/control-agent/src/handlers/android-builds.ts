import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  androidAssembleTask,
  parseAndroidBuildPayload,
  parseAndroidBuildSettings,
  parseAndroidSourcePayload,
  parseAndroidDeployPayload,
  parseAndroidRemoteDeployPayload,
  type BuildDestination,
} from "@ai-development-environment/agent-contract/builds";
import { androidTools } from "../android-tools.js";
import { bootAndroidAvd, runningAndroidAvds } from "../android-simulators.js";
import { captureCommand } from "../capture-command.js";
import { worktreeCodeStateHash } from "../git-code-state.js";
import { withRepositoryMetadata } from "../repository-metadata.js";
import {
  BuildLogger,
  containedPath,
  createRedactor,
  createRemoteBuildStagingDirectory,
  fileChecksum,
  minimalEnvironment,
  runLoggedCommand,
  runHook,
  validateWorktree,
  verifyQueuedBuildCheckout,
} from "./builds.js";
import type { AgentJobHandler, AgentJobHandlerContext } from "./index.js";

const succeeded = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

async function checkedPath(root: string, path: string): Promise<string> {
  const target = await realpath(containedPath(root, path));
  containedPath(root, relative(root, target));
  return target;
}

function gradleEnvironment(sdk: string) {
  return minimalEnvironment({
    ANDROID_HOME: sdk,
    ...Object.fromEntries(
      ["JAVA_HOME", "GRADLE_USER_HOME", "ANDROID_USER_HOME", "ANDROID_AVD_HOME"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]!]),
    ),
  });
}

function cleanError(error: unknown) {
  return createRedactor(process.env)(
    error instanceof Error ? error.message : String(error),
  ).slice(-4000);
}

export const discoverAndroidSources: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseAndroidSourcePayload(payload);
  const root = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  const sources: string[] = [];
  const queue = [{ path: root, depth: 0 }];
  const ignored = new Set(["node_modules", "build", "vendor", "DerivedData"]);
  for (
    let index = 0;
    index < queue.length && index < 4096 && sources.length < 100;
    index++
  ) {
    signal.throwIfAborted();
    const { path, depth } = queue[index]!;
    const entries = await readdir(path, { withFileTypes: true });
    const names = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    if (
      names.has("gradlew") &&
      (names.has("settings.gradle") || names.has("settings.gradle.kts"))
    ) {
      sources.push(relative(root, path) || ".");
    }
    if (depth < 4) {
      for (const entry of entries) {
        if (queue.length >= 4096) break;
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !ignored.has(entry.name)
        ) {
          queue.push({ path: join(path, entry.name), depth: depth + 1 });
        }
      }
    }
  }
  return { ...succeeded, sources: sources.sort() };
};

const discoveryPrefix = "ADE_ANDROID_VARIANT=";
const discoveryInit = `
gradle.beforeProject { project ->
    project.pluginManager.withPlugin('com.android.application') {
        def components = project.extensions.findByName('androidComponents')
        if (components != null) {
            components.onVariants(components.selector().all(), { variant ->
                println '${discoveryPrefix}' + groovy.json.JsonOutput.toJson([module: project.path, variant: variant.name])
                kotlin.Unit.INSTANCE
            } as kotlin.jvm.functions.Function1)
        }
    }
}
`;

export function parseAndroidVariants(output: string) {
  const modules = new Map<string, Set<string>>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(discoveryPrefix)) continue;
    const variant = JSON.parse(line.slice(discoveryPrefix.length));
    const { module, variant: name } = parseAndroidBuildSettings({
      ...variant,
      projectPath: ".",
    });
    let variants = modules.get(module);
    if (!variants) modules.set(module, (variants = new Set()));
    variants.add(name);
  }
  return [...modules]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, variants]) => ({ module, variants: [...variants].sort() }));
}

export const inspectAndroidSource: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseAndroidSourcePayload(payload);
  if (input.projectPath == null)
    throw new Error("Select a Gradle project directory");
  const root = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  const project = await checkedPath(root, input.projectPath);
  const wrapper = await checkedPath(
    root,
    relative(root, join(project, "gradlew")),
  );
  const { sdk, java } = androidTools();
  if (!java) throw new Error("Configure a compatible JDK on the agent");
  const staging = await mkdtemp(join(tmpdir(), "ade-gradle-inspect-"));
  try {
    const init = join(staging, "android-variants.gradle");
    await writeFile(init, discoveryInit, { mode: 0o600 });
    const result = await captureCommand({
      command: "sh",
      args: [
        wrapper,
        "--console=plain",
        "--no-daemon",
        "--no-configuration-cache",
        "--no-configure-on-demand",
        "--project-cache-dir",
        join(staging, "cache"),
        "--init-script",
        init,
        "help",
      ],
      cwd: project,
      timeoutMs,
      signal,
      env: gradleEnvironment(sdk),
    });
    if (result.exitCode !== 0 || result.outputTruncated) {
      throw new Error(
        cleanError(
          result.stderr || result.stdout || "Gradle project inspection failed",
        ),
      );
    }
    return { ...succeeded, modules: parseAndroidVariants(result.stdout) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

async function runTool(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 30_000,
) {
  const output = await captureCommand({ command, args, signal, timeoutMs });
  if (output.exitCode !== 0 || output.outputTruncated) {
    throw new Error(
      output.stderr.trim() ||
        output.stdout.trim() ||
        `${basename(command)} did not complete successfully`,
    );
  }
  return output.stdout.trim();
}

async function variantMetadata(
  directory: string,
  depth = 0,
): Promise<string[]> {
  const children = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isFile() && child.name === "output-metadata.json")
      files.push(path);
    if (depth < 4 && child.isDirectory())
      files.push(...(await variantMetadata(path, depth + 1)));
  }
  return files;
}

export async function findAndroidApk(
  root: string,
  project: string,
  settings: {
    module: string;
    variant: string;
    apkPath: string | null;
  },
): Promise<string> {
  if (settings.apkPath) return checkedPath(root, settings.apkPath);
  const modulePath = settings.module.slice(1).replaceAll(":", "/");
  const outputPath = join(project, modulePath, "build", "outputs", "apk");
  const output = await checkedPath(root, relative(root, outputPath)).catch(
    () => null,
  );
  const matches = new Set<string>();
  for (const path of output ? await variantMetadata(output) : []) {
    const data = JSON.parse(await readFile(path, "utf8")) as {
      variantName?: string;
      elements?: { outputFile?: string; filters?: unknown[] }[];
    };
    if (
      data.variantName?.toLowerCase() !== settings.variant.toLowerCase() ||
      !Array.isArray(data.elements)
    )
      continue;
    const eligible = data.elements.filter(
      (element) =>
        typeof element.outputFile === "string" &&
        element.outputFile.endsWith(".apk") &&
        basename(element.outputFile) === element.outputFile &&
        (!element.filters?.length || data.elements!.length === 1),
    );
    for (const element of eligible) {
      const candidate = join(dirname(path), element.outputFile!);
      matches.add(await checkedPath(root, relative(root, candidate)));
    }
  }
  if (matches.size !== 1) {
    throw new Error(
      "Could not select one standalone APK for this variant. Enable a universal APK or set the APK output path in the build configuration.",
    );
  }
  return [...matches][0]!;
}

async function apkMetadata(apk: string, signal: AbortSignal) {
  const { apksigner, apkanalyzer } = androidTools();
  if (!apksigner || !apkanalyzer)
    throw new Error(
      "Install Android SDK Build Tools and command-line tools on the build agent",
    );
  try {
    await runTool(apksigner, ["verify", apk], signal);
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "APK signature verification failed. Configure Gradle to sign this variant.",
    );
  }
  const [applicationId, versionName, versionCode, minSdk, manifest, files] =
    await Promise.all([
      runTool(apkanalyzer, ["manifest", "application-id", apk], signal),
      runTool(apkanalyzer, ["manifest", "version-name", apk], signal),
      runTool(apkanalyzer, ["manifest", "version-code", apk], signal),
      runTool(apkanalyzer, ["manifest", "min-sdk", apk], signal),
      runTool(apkanalyzer, ["manifest", "print", apk], signal),
      runTool(apkanalyzer, ["files", "list", apk], signal),
    ]);
  if (
    /<manifest\b[^>]*\ssplit\s*=/s.test(manifest) ||
    /android:isSplitRequired\s*=\s*"true"/.test(manifest)
  ) {
    throw new Error(
      "APK requires additional splits. Configure a standalone APK for this variant.",
    );
  }
  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(applicationId)
  ) {
    throw new Error("APK does not have a valid Android application ID");
  }
  const abis = [
    ...new Set(
      [...files.matchAll(/^\s*\/?lib\/([^/\s]+)\/.+\.so\s*$/gm)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  return {
    applicationId,
    versionName,
    versionCode,
    minSdk: /^\d+$/.test(minSdk) ? Number(minSdk) : null,
    abis,
    signed: true,
  };
}

async function captureAndroidApk(
  root: string,
  project: string,
  settings: ReturnType<typeof parseAndroidBuildSettings>,
  artifactDirectory: string,
  signal: AbortSignal,
) {
  const sourceApk = await findAndroidApk(root, project, settings);
  if (!(await stat(sourceApk)).isFile())
    throw new Error("APK output is not a file");
  const relativePath = "application.apk";
  const destination = join(artifactDirectory, relativePath);
  const staged = `${destination}.${randomUUID()}.apk`;
  try {
    await copyFile(sourceApk, staged);
    const metadata = await apkMetadata(staged, signal);
    const checksum = await fileChecksum(staged);
    if (!checksum) throw new Error("Could not checksum the APK");
    const { size } = await stat(staged);
    signal.throwIfAborted();
    await rename(staged, destination);
    return { kind: "APK", relativePath, sizeBytes: size, checksum, metadata };
  } finally {
    await rm(staged, { force: true });
  }
}

export const runAndroidBuild: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const input = parseAndroidBuildPayload(payload);
  const { buildId, settings, gradleCachePath } = input;
  const startedAt = new Date().toISOString();
  const report = (
    status: "PREPARING" | "RUNNING",
    scriptExecutions?: Parameters<
      NonNullable<AgentJobHandlerContext["reportBuildProgress"]>
    >[0]["scriptExecutions"],
  ) =>
    context
      ?.reportBuildProgress?.({ buildId, status, startedAt, scriptExecutions })
      .catch(() => undefined);
  await report("PREPARING");
  const root = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  await verifyQueuedBuildCheckout(
    root,
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  const project = await checkedPath(root, settings.projectPath);
  const gradlew = await checkedPath(
    root,
    relative(root, join(project, "gradlew")),
  );
  if (!(await stat(gradlew)).isFile())
    throw new Error("The Gradle project must contain a gradlew wrapper script");
  const { sdk, java } = androidTools();
  if (!java) throw new Error("Configure a compatible JDK on the build agent");
  const hash = createHash("sha256")
    .update(settings.projectPath)
    .digest("hex")
    .slice(0, 16);
  const artifactRoot = dirname(input.artifactDirectory);
  const expectedCache = join(
    artifactRoot,
    ".android-gradle",
    input.worktreeId,
    hash,
  );
  if (
    !/^[A-Za-z0-9_-]+$/.test(input.worktreeId) ||
    gradleCachePath !== expectedCache
  ) {
    throw new Error("Gradle cache directory does not match this worktree");
  }
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const canonicalArtifactRoot = await realpath(artifactRoot);
  await mkdir(gradleCachePath, { recursive: true, mode: 0o700 });
  const cache = await checkedPath(
    canonicalArtifactRoot,
    relative(artifactRoot, gradleCachePath),
  );
  const recordPath = join(cache, ".aide-android-gradle.json");
  const recordTemp = `${recordPath}.${randomUUID()}`;
  const modules = new Set([settings.module]);
  try {
    const info = await lstat(recordPath);
    if (info.isFile() && info.size <= 16_384) {
      const prior = JSON.parse(await readFile(recordPath, "utf8"));
      if (
        prior.worktreeId === input.worktreeId &&
        prior.worktreePath === root &&
        prior.projectPath === settings.projectPath
      ) {
        for (const gradleModule of [
          prior.module,
          ...(Array.isArray(prior.modules) ? prior.modules.slice(0, 50) : []),
        ]) {
          try {
            modules.add(
              parseAndroidBuildSettings({ ...settings, module: gradleModule })
                .module,
            );
          } catch {
            /* Ignore an invalid prior module. */
          }
        }
      }
    }
  } catch {
    /* The marker is replaced after validation. */
  }
  try {
    await writeFile(
      recordTemp,
      JSON.stringify({
        worktreeId: input.worktreeId,
        worktreePath: root,
        projectPath: settings.projectPath,
        module: settings.module,
        modules: [...modules].slice(0, 50),
      }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(recordTemp, recordPath);
  } finally {
    await rm(recordTemp, { force: true });
  }
  await mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  const artifactDirectory = await checkedPath(canonicalArtifactRoot, buildId);
  const logPath = join(artifactDirectory, "build.log");
  const logger = new BuildLogger(buildId, context, logPath, process.env);
  let result: Awaited<ReturnType<typeof runLoggedCommand>> | undefined;
  let error: string | undefined;
  let errorCode: string | undefined;
  const artifacts: unknown[] = [];
  const scriptExecutions: Awaited<ReturnType<typeof runHook>>[] = [];
  const hookInput = { buildId, artifactDirectory };
  const hookContext = {
    buildId,
    platform: "ANDROID",
    action: "BUILD",
    branch: input.branch,
    worktree: {
      id: input.worktreeId,
      folder: root,
      branch: input.branch,
      headSha: input.headSha,
    },
    configuration: settings,
  };
  const runHooks = async (
    phase: "PRE_BUILD" | "POST_BUILD",
    hookSignal: AbortSignal,
  ) => {
    const pre = phase === "PRE_BUILD";
    const scripts = [...input.scripts].sort((a, b) =>
      pre ? a.position - b.position : b.position - a.position,
    );
    for (const script of scripts) {
      const source = pre ? script.preBuildScript : script.postBuildScript;
      if (!source || hookSignal.aborted) continue;
      const progressStatus = pre ? "PREPARING" : "RUNNING";
      await report(progressStatus, [
        { phase, position: script.position, status: "RUNNING" },
      ]);
      const execution = await runHook({
        input: hookInput,
        folder: root,
        script,
        phase,
        source,
        logger,
        signal: hookSignal,
        contextPath: join(artifactDirectory, "context.json"),
        hookContext: {
          ...hookContext,
          buildFolder: artifactDirectory,
          failed: Boolean(error),
          cancelled: signal.aborted,
          error,
          errorCode,
        },
      });
      scriptExecutions.push(execution);
      await report(progressStatus, [execution]);
      if (execution.causedBuildFailure && !signal.aborted) {
        error ??= execution.error ?? "Build hook failed";
        errorCode ??= "SCRIPT_FAILED";
        if (pre) break;
      }
    }
  };
  const stateHash = (stateSignal: AbortSignal) =>
    withRepositoryMetadata(
      root,
      () =>
        worktreeCodeStateHash(root, Math.min(timeoutMs, 60_000), stateSignal),
      stateSignal,
    );
  let sourceStateHash: string | null | undefined;
  try {
    sourceStateHash = await stateHash(signal);
    await onLog({
      sequence: 0,
      stream: "SYSTEM",
      message: "Starting Android Gradle build",
      createdAt: startedAt,
    }).catch(() => undefined);
    await runHooks("PRE_BUILD", signal);
    signal.throwIfAborted();
    if (error) throw new Error(error);
    await report("RUNNING");
    result = await runLoggedCommand({
      command: "sh",
      args: [
        gradlew,
        "--console=plain",
        "--no-daemon",
        "--project-cache-dir",
        cache,
        androidAssembleTask(settings),
      ],
      cwd: project,
      env: gradleEnvironment(sdk),
      timeoutMs,
      signal,
      logger,
      phase: "BUILD",
    });
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
      errorCode = result.timedOut
        ? "TIMEOUT"
        : result.cancelled
          ? "CANCELLED"
          : "GRADLE_BUILD_FAILED";
      error = cleanError(
        result.output || "Gradle did not complete successfully",
      );
    }
  } catch (failure) {
    error ??= cleanError(failure);
    errorCode ??= signal.aborted
      ? "CANCELLED"
      : result?.exitCode === 0
        ? "APK_CAPTURE_FAILED"
        : "GRADLE_BUILD_FAILED";
  } finally {
    try {
      await runHooks("POST_BUILD", new AbortController().signal);
      if (result?.exitCode === 0 && !error && !signal.aborted) {
        try {
          artifacts.push(
            await captureAndroidApk(
              root,
              project,
              settings,
              artifactDirectory,
              signal,
            ),
          );
        } catch (failure) {
          error = cleanError(failure);
          errorCode = signal.aborted ? "CANCELLED" : "APK_CAPTURE_FAILED";
        }
      }
    } finally {
      if (error) logger.emit("BUILD", "SYSTEM", error);
      await logger.close();
    }
  }
  const logChecksum = await fileChecksum(logPath);
  if (logChecksum)
    artifacts.push({
      kind: "RAW_LOG",
      relativePath: "build.log",
      sizeBytes: (await stat(logPath)).size,
      checksum: logChecksum,
      metadata: {},
    });
  const finalStateHash = await stateHash(new AbortController().signal).catch(
    () => undefined,
  );
  const cancelled = result?.cancelled === true || signal.aborted;
  const completed = {
    exitCode: cancelled ? null : error ? 1 : (result?.exitCode ?? 1),
    signal: result?.signal ?? null,
    timedOut: result?.timedOut === true,
    cancelled,
    errorCode,
    error,
    artifacts,
    scriptExecutions,
    sourceStateHash,
    finalStateHash,
    codeStateObservedAt: new Date().toISOString(),
  };
  await context?.finalizeBuildResult?.(completed);
  return completed;
};

export function adbDevices(output: string): BuildDestination[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match =
      /^([^\s]+)\s+(device|offline|unauthorized|no permissions|recovery|sideload)\b(.*)$/.exec(
        line,
      );
    if (!match || match[1]!.startsWith("emulator-")) return [];
    const [, id, state, details] = match;
    return [
      {
        type: "PHYSICAL_DEVICE" as const,
        id: id!,
        name:
          /\bmodel:([^\s]+)/.exec(details!)?.[1]?.replaceAll("_", " ") ?? id!,
        platform: "Android",
        platformId: "ANDROID" as const,
        osVersion: null,
        state: state!,
        available: state === "device",
        ...(state === "device"
          ? {}
          : {
              unavailableReason:
                state === "unauthorized"
                  ? "Approve USB debugging on the Android device"
                  : `ADB device is ${state}`,
            }),
      },
    ];
  });
}

export const inspectAndroidRunDestinations: AgentJobHandler = async (
  _payload,
  _timeoutMs,
  signal,
) => {
  const { adb, emulator } = androidTools();
  if (!adb) throw new Error("Install Android SDK Platform Tools on the agent");
  const connected = adbDevices(await runTool(adb, ["devices", "-l"], signal));
  if (!emulator) return { ...succeeded, destinations: connected };
  const [names, running] = await Promise.all([
    runTool(emulator, ["-list-avds"], signal),
    runningAndroidAvds(signal),
  ]);
  const avds = names
    .split(/\r?\n/)
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name));
  const destinations = [
    ...connected,
    ...avds.map((name) => ({
      type: "SIMULATOR" as const,
      id: `android:${name}`,
      name,
      platform: "Android",
      platformId: "ANDROID" as const,
      osVersion: null,
      state: running.has(name) ? "Booted" : "Shutdown",
      available: true,
    })),
  ];
  return { ...succeeded, destinations };
};

async function deployAndroid(
  input:
    | ReturnType<typeof parseAndroidRemoteDeployPayload>
    | ReturnType<typeof parseAndroidDeployPayload>,
  apk: string,
  logPath: string,
  signal: AbortSignal,
  context: AgentJobHandlerContext | undefined,
) {
  const { adb } = androidTools();
  if (!adb)
    throw new Error("Install Android SDK Platform Tools on the run agent");
  if ((await fileChecksum(apk)) !== input.checksum)
    throw new Error("APK checksum does not match the captured artifact");
  const logger = new BuildLogger(input.buildId, context, logPath, process.env);
  const deployments = [];
  try {
    for (const { id, destination } of input.deployments) {
      const log = (message: string) =>
        logger.emit("DEPLOY", "SYSTEM", message, "DEPLOYMENT", id);
      try {
        signal.throwIfAborted();
        const serial =
          destination.type === "SIMULATOR"
            ? await bootAndroidAvd(
                destination.id.slice("android:".length),
                signal,
              )
            : destination.id;
        if (
          (await runTool(adb, ["-s", serial, "get-state"], signal)) !== "device"
        ) {
          throw new Error("The selected device is offline or unauthorized");
        }
        if (input.minSdk != null) {
          const sdk = Number(
            await runTool(
              adb,
              ["-s", serial, "shell", "getprop", "ro.build.version.sdk"],
              signal,
            ),
          );
          if (!Number.isInteger(sdk) || sdk < input.minSdk)
            throw new Error(
              `APK requires Android API level ${input.minSdk} or newer`,
            );
        }
        if (input.abis.length) {
          const supported = (
            await runTool(
              adb,
              ["-s", serial, "shell", "getprop", "ro.product.cpu.abilist"],
              signal,
            )
          ).split(",");
          if (!input.abis.some((abi) => supported.includes(abi)))
            throw new Error(
              `APK requires one of these Android ABIs: ${input.abis.join(", ")}`,
            );
        }
        log(`Installing on ${destination.name}`);
        const install = await runTool(
          adb,
          ["-s", serial, "install", "-r", apk],
          signal,
          120_000,
        );
        if (!/^Success\r?$/m.test(install))
          throw new Error(install || "ADB did not confirm installation");
        const activity = (
          await runTool(
            adb,
            [
              "-s",
              serial,
              "shell",
              "cmd",
              "package",
              "resolve-activity",
              "--brief",
              "-a",
              "android.intent.action.MAIN",
              "-c",
              "android.intent.category.LAUNCHER",
              "-p",
              input.applicationId,
            ],
            signal,
          )
        )
          .split("\n")
          .at(-1)
          ?.trim();
        if (
          !activity?.startsWith(`${input.applicationId}/`) ||
          !/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(activity)
        ) {
          throw new Error(
            "APK installed, but the app has no launchable activity",
          );
        }
        const launch = await runTool(
          adb,
          ["-s", serial, "shell", "am", "start", "-W", "-n", `'${activity}'`],
          signal,
          60_000,
        );
        if (!/^Status: ok\r?$/m.test(launch))
          throw new Error(launch || "Android did not confirm launch");
        const launchedAt = new Date().toISOString();
        log(`Launched ${input.applicationId}`);
        await context
          ?.reportBuildDeploymentLaunched?.(id, launchedAt)
          .catch(() => undefined);
        deployments.push({ id, status: "SUCCEEDED", launchedAt });
      } catch (failure) {
        const error = cleanError(failure);
        log(error);
        deployments.push({
          id,
          status: signal.aborted ? "CANCELLED" : "FAILED",
          error,
        });
      }
    }
    return {
      ...succeeded,
      cancelled: signal.aborted,
      exitCode: deployments.every((item) => item.status === "SUCCEEDED")
        ? 0
        : 1,
      deployments,
    };
  } finally {
    await logger.close();
  }
}

export const deployAndroidBuild: AgentJobHandler = async (
  payload,
  _timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = parseAndroidDeployPayload(payload);
  const root = await realpath(input.artifactDirectory);
  const apk = await checkedPath(root, input.artifactRelativePath);
  return deployAndroid(
    input,
    apk,
    join(root, `android-deploy-${randomUUID()}.log`),
    signal,
    context,
  );
};

export const deployTransferredAndroidBuild: AgentJobHandler = async (
  payload,
  _timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = parseAndroidRemoteDeployPayload(payload);
  if (!context?.downloadBuildArtifactTransfer)
    throw new Error("This agent cannot download a relayed APK");
  const staging = await createRemoteBuildStagingDirectory(input.buildId);
  try {
    const apk = join(staging, "application.apk");
    await context.downloadBuildArtifactTransfer({
      transferId: input.transferId,
      path: apk,
      signal,
    });
    return await deployAndroid(
      input,
      apk,
      join(staging, "android-deploy.log"),
      signal,
      context,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};
