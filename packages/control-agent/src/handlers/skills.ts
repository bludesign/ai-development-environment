import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  AI_TOOLS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_PACKAGE_BYTES,
  hashSkillFiles,
  parseSkillApplyPayload,
  parseSkillMetadata,
  parseSkillReadPayload,
  parseSkillScanPayload,
  type AiTool,
  type SkillLocation,
  type SkillPackage,
  type SkillPackageFile,
  type SkillRootKind,
  type SkillScanInstallation,
  type SkillScanTarget,
} from "@ai-development-environment/agent-contract/skills";

import type { AgentJobHandler } from "./index.js";

const executeFile = promisify(execFile);
const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

const MANAGED_EXCLUDE_START = "# BEGIN ai-development-environment skill sync";
const MANAGED_EXCLUDE_END = "# END ai-development-environment skill sync";

const ROOT_CONSUMERS: Record<
  AiTool,
  { global: SkillRootKind[]; project: SkillRootKind[] }
> = {
  CURSOR: {
    global: ["CURSOR", "AGENTS", "CLAUDE", "CODEX_LEGACY"],
    project: ["CURSOR", "AGENTS", "CLAUDE", "CODEX_LEGACY"],
  },
  GITHUB_COPILOT: {
    global: ["GITHUB_COPILOT", "AGENTS"],
    project: ["GITHUB_COPILOT", "AGENTS", "CLAUDE"],
  },
  CODEX: {
    global: ["AGENTS", "CODEX_LEGACY"],
    project: ["AGENTS", "CODEX_LEGACY"],
  },
  CLAUDE: { global: ["CLAUDE"], project: ["CLAUDE"] },
  OPENCODE: {
    global: ["OPENCODE", "CLAUDE", "AGENTS"],
    project: ["OPENCODE", "CLAUDE", "AGENTS"],
  },
};

const CONFIG_PATHS: Record<AiTool, string[]> = {
  CURSOR: [".cursor"],
  GITHUB_COPILOT: [".copilot"],
  CODEX: [".codex"],
  CLAUDE: [".claude"],
  OPENCODE: [".config", "opencode"],
};

const GLOBAL_ROOTS: Record<SkillRootKind, string[]> = {
  CURSOR: [".cursor", "skills"],
  GITHUB_COPILOT: [".copilot", "skills"],
  AGENTS: [".agents", "skills"],
  CLAUDE: [".claude", "skills"],
  CODEX_LEGACY: [".codex", "skills"],
  OPENCODE: [".config", "opencode", "skills"],
};

const PROJECT_ROOTS: Record<SkillRootKind, string[]> = {
  CURSOR: [".cursor", "skills"],
  GITHUB_COPILOT: [".github", "skills"],
  AGENTS: [".agents", "skills"],
  CLAUDE: [".claude", "skills"],
  CODEX_LEGACY: [".codex", "skills"],
  OPENCODE: [".opencode", "skills"],
};

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function configuredTools(tools: AiTool[]) {
  const homePath = homedir();
  return Promise.all(
    AI_TOOLS.filter((tool) => tools.includes(tool)).map(async (tool) => ({
      tool,
      configured: await directoryExists(join(homePath, ...CONFIG_PATHS[tool])),
      homePath,
    })),
  );
}

function rootPath(location: SkillLocation): string {
  const base = location.scope === "GLOBAL" ? homedir() : location.folder!;
  const parts =
    location.scope === "GLOBAL"
      ? GLOBAL_ROOTS[location.rootKind]
      : PROJECT_ROOTS[location.rootKind];
  const path = resolve(base, ...parts);
  const normalizedBase = resolve(base);
  if (path !== normalizedBase && !path.startsWith(`${normalizedBase}${sep}`)) {
    throw new Error("Skill root escaped its configured base directory");
  }
  return path;
}

function targetForFolder(targets: SkillScanTarget[], folder: string | null) {
  return folder
    ? targets.find((target) => resolve(target.folder) === resolve(folder))
    : undefined;
}

async function listPackageFiles(
  skillDirectory: string,
): Promise<SkillPackageFile[]> {
  const files: SkillPackageFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Nested symbolic link is not supported: ${relative(skillDirectory, path)}`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (files.length >= MAX_SKILL_FILES)
        throw new Error("Skill contains too many files");
      if (metadata.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(
          `${relative(skillDirectory, path)} exceeds the per-file limit`,
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_SKILL_PACKAGE_BYTES)
        throw new Error("Skill exceeds the package size limit");
      files.push({
        path: relative(skillDirectory, path).split(sep).join("/"),
        contentsBase64: (await readFile(path)).toString("base64"),
        executable: (metadata.mode & 0o111) !== 0,
      });
    }
  };
  await visit(skillDirectory);
  return files;
}

async function readPackage(directory: string): Promise<SkillPackage> {
  const metadata = await lstat(directory);
  let resolvedDirectory = directory;
  if (metadata.isSymbolicLink()) {
    resolvedDirectory = await realpath(directory);
  } else if (!metadata.isDirectory()) {
    throw new Error("Skill path is not a directory");
  }
  const files = await listPackageFiles(resolvedDirectory);
  const definition = files.find((file) => file.path === "SKILL.md");
  if (!definition) throw new Error("Skill does not contain SKILL.md");
  const frontmatter = parseSkillMetadata(
    Buffer.from(definition.contentsBase64, "base64").toString("utf8"),
  );
  if (frontmatter.name !== directory.split(sep).at(-1)) {
    throw new Error("Skill name must match its directory name");
  }
  return {
    ...frontmatter,
    packageHash: hashSkillFiles(files),
    files,
  };
}

async function trackedProjectPath(
  folder: string,
  path: string,
): Promise<boolean> {
  try {
    const result = await executeFile(
      "git",
      ["-C", folder, "ls-files", "--", path],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function consumersForRoot(
  configured: AiTool[],
  rootKind: SkillRootKind,
  scope: "GLOBAL" | "PROJECT",
): AiTool[] {
  return configured.filter((tool) =>
    ROOT_CONSUMERS[tool][scope === "GLOBAL" ? "global" : "project"].includes(
      rootKind,
    ),
  );
}

async function scanRoot(
  location: SkillLocation,
  configured: AiTool[],
  targets: SkillScanTarget[],
  warnings: string[],
): Promise<SkillScanInstallation[]> {
  const root = rootPath(location);
  if (!(await directoryExists(root))) return [];
  const consumers = consumersForRoot(
    configured,
    location.rootKind,
    location.scope,
  );
  if (!consumers.length) return [];
  const target = targetForFolder(targets, location.folder);
  const installations: SkillScanInstallation[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    try {
      const skillPackage = await readPackage(directory);
      const relativeDirectory = location.folder
        ? relative(location.folder, directory).split(sep).join("/")
        : "";
      installations.push({
        ...location,
        codebaseId: target?.codebaseId ?? null,
        worktreeId: target?.worktreeId ?? null,
        rootPath: root,
        skillName: skillPackage.name,
        description: skillPackage.description,
        packageHash: skillPackage.packageHash,
        fileCount: skillPackage.files.length,
        totalBytes: skillPackage.files.reduce(
          (total, file) =>
            total + Buffer.from(file.contentsBase64, "base64").byteLength,
          0,
        ),
        tracked:
          location.scope === "PROJECT"
            ? await trackedProjectPath(location.folder!, relativeDirectory)
            : false,
        consumers,
      });
    } catch (error) {
      warnings.push(
        `${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return installations;
}

function scanLocations(
  configured: AiTool[],
  targets: SkillScanTarget[],
): SkillLocation[] {
  const locations = new Map<string, SkillLocation>();
  const add = (location: SkillLocation) => {
    const path = rootPath(location);
    locations.set(`${location.scope}:${path}`, location);
  };
  for (const tool of configured) {
    for (const rootKind of ROOT_CONSUMERS[tool].global) {
      add({ scope: "GLOBAL", rootKind, folder: null });
    }
    for (const target of targets) {
      for (const rootKind of ROOT_CONSUMERS[tool].project) {
        add({ scope: "PROJECT", rootKind, folder: target.folder });
      }
    }
  }
  return [...locations.values()];
}

export const scanSkills: AgentJobHandler = async (payload) => {
  const input = parseSkillScanPayload(payload);
  const observations = await configuredTools(input.tools);
  const configured = observations
    .filter((observation) => observation.configured)
    .map((observation) => observation.tool);
  const warnings: string[] = [];
  const installations = (
    await Promise.all(
      scanLocations(configured, input.targets).map((location) =>
        scanRoot(location, configured, input.targets, warnings),
      ),
    )
  ).flat();
  return {
    ...successfulProcess,
    configuredTools: observations,
    installations,
    warnings: warnings.slice(0, 500),
  };
};

export const readSkills: AgentJobHandler = async (payload) => {
  const input = parseSkillReadPayload(payload);
  const configured = (await configuredTools(input.tools))
    .filter((observation) => observation.configured)
    .map((observation) => observation.tool);
  const allowed = new Set(
    scanLocations(configured, input.targets).map(
      (location) => `${location.scope}:${rootPath(location)}`,
    ),
  );
  const packages = [];
  for (const request of input.requests) {
    const root = rootPath(request);
    if (!allowed.has(`${request.scope}:${root}`)) {
      throw new Error("Requested skill root is not enabled or configured");
    }
    packages.push({
      ...request,
      package: await readPackage(join(root, request.skillName)),
    });
  }
  return { ...successfulProcess, packages };
};

async function gitExcludePath(folder: string): Promise<string> {
  const result = await executeFile("git", [
    "-C",
    folder,
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  const value = result.stdout.trim();
  return isAbsolute(value) ? value : resolve(folder, value);
}

async function updateManagedExclude(
  folder: string,
  relativeSkillPath: string,
  present: boolean,
): Promise<void> {
  const excludePath = await gitExcludePath(folder);
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // A repository does not need to have an info/exclude file yet.
  }
  const start = existing.indexOf(MANAGED_EXCLUDE_START);
  const end = existing.indexOf(MANAGED_EXCLUDE_END);
  const before =
    start >= 0 ? existing.slice(0, start).trimEnd() : existing.trimEnd();
  const managed = new Set<string>();
  if (start >= 0 && end > start) {
    for (const line of existing
      .slice(start + MANAGED_EXCLUDE_START.length, end)
      .split(/\r?\n/)) {
      if (line.trim()) managed.add(line.trim());
    }
  }
  const pattern = `/${relativeSkillPath.split(sep).join("/").replace(/^\/+/, "")}/`;
  if (present) managed.add(pattern);
  else managed.delete(pattern);
  const block = managed.size
    ? `${MANAGED_EXCLUDE_START}\n${[...managed].sort().join("\n")}\n${MANAGED_EXCLUDE_END}`
    : "";
  await writeFile(
    excludePath,
    `${[before, block].filter(Boolean).join("\n\n")}\n`,
    "utf8",
  );
}

async function assertUntracked(
  location: SkillLocation,
  skillDirectory: string,
): Promise<void> {
  if (location.scope !== "PROJECT") return;
  const relativeDirectory = relative(location.folder!, skillDirectory)
    .split(sep)
    .join("/");
  if (await trackedProjectPath(location.folder!, relativeDirectory)) {
    throw new Error(
      `${relativeDirectory} is tracked by Git and cannot be managed automatically`,
    );
  }
}

async function writePackage(
  location: SkillLocation,
  skillPackage: SkillPackage,
): Promise<string> {
  if (location.rootKind !== "AGENTS" && location.rootKind !== "CLAUDE") {
    throw new Error("New skill copies may only be written to shared roots");
  }
  const root = rootPath(location);
  const destination = join(root, skillPackage.name);
  await assertUntracked(location, destination);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${skillPackage.name}.${randomUUID()}.tmp`);
  const backup = join(root, `.${skillPackage.name}.${randomUUID()}.bak`);
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of skillPackage.files) {
      const path = resolve(temporary, ...file.path.split("/"));
      if (!path.startsWith(`${temporary}${sep}`))
        throw new Error("Skill file escaped temporary directory");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.contentsBase64, "base64"));
      await chmod(path, file.executable ? 0o755 : 0o644);
    }
    let hadDestination = false;
    try {
      await access(destination);
      hadDestination = true;
      await rename(destination, backup);
    } catch {
      hadDestination = false;
    }
    try {
      await rename(temporary, destination);
      if (hadDestination) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (hadDestination) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
  return destination;
}

export const applySkills: AgentJobHandler = async (payload) => {
  const { operations } = parseSkillApplyPayload(payload);
  const results: Array<{
    kind: string;
    path: string;
    packageHash: string | null;
  }> = [];
  for (const operation of operations) {
    const root = rootPath(operation);
    const skillName =
      operation.kind === "WRITE" ? operation.package.name : operation.skillName;
    const destination = join(root, skillName);
    await assertUntracked(operation, destination);
    if (operation.kind === "WRITE") {
      await writePackage(operation, operation.package);
      results.push({
        kind: operation.kind,
        path: destination,
        packageHash: operation.package.packageHash,
      });
    } else {
      await rm(destination, { recursive: true, force: true });
      results.push({
        kind: operation.kind,
        path: destination,
        packageHash: null,
      });
    }
    if (operation.scope === "PROJECT" && operation.manageGitExclude) {
      await updateManagedExclude(
        operation.folder!,
        relative(operation.folder!, destination),
        operation.kind === "WRITE",
      );
    }
  }
  return { ...successfulProcess, results };
};
