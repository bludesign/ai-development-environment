import { createHash } from "node:crypto";

export const SKILL_SCAN_JOB_KIND = "skills.scan";
export const SKILL_READ_JOB_KIND = "skills.read";
export const SKILL_APPLY_JOB_KIND = "skills.apply";

export const SKILL_JOB_KINDS = [
  SKILL_SCAN_JOB_KIND,
  SKILL_READ_JOB_KIND,
  SKILL_APPLY_JOB_KIND,
] as const;

export const AI_TOOLS = [
  "CURSOR",
  "GITHUB_COPILOT",
  "CODEX",
  "CLAUDE",
  "OPENCODE",
] as const;
export type AiTool = (typeof AI_TOOLS)[number];

export const SKILL_ROOT_KINDS = [
  "CURSOR",
  "GITHUB_COPILOT",
  "AGENTS",
  "CLAUDE",
  "CODEX_LEGACY",
  "OPENCODE",
] as const;
export type SkillRootKind = (typeof SKILL_ROOT_KINDS)[number];
export type SkillScope = "GLOBAL" | "PROJECT";

export const SKILL_NAME_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const SKILL_NAME_REGEX = new RegExp(`^${SKILL_NAME_PATTERN}$`);
export const MAX_SKILL_FILES = 500;
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_PACKAGE_BYTES = 20 * 1024 * 1024;

export type SkillScanTarget = {
  codebaseId: string;
  worktreeId: string | null;
  folder: string;
};

export type SkillPackageFile = {
  path: string;
  contentsBase64: string;
  executable: boolean;
};

export type SkillPackage = {
  name: string;
  description: string;
  packageHash: string;
  files: SkillPackageFile[];
};

function scalarValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseSkillMetadata(contents: string): {
  name: string;
  description: string;
} {
  const normalized = contents.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must begin with YAML frontmatter");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  const lines = normalized.slice(4, end).split("\n");
  const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(
      lines[index] ?? "",
    );
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2] ?? "";
    if (raw === "|" || raw === ">") {
      const parts: string[] = [];
      while (
        index + 1 < lines.length &&
        /^(?:\s+|$)/.test(lines[index + 1] ?? "")
      ) {
        index += 1;
        parts.push((lines[index] ?? "").replace(/^\s+/, ""));
      }
      values.set(
        key,
        raw === ">" ? parts.join(" ").trim() : parts.join("\n").trim(),
      );
    } else {
      values.set(key, scalarValue(raw));
    }
  }
  const name = validateSkillName(values.get("name"), "SKILL.md name");
  const description = (values.get("description") ?? "").trim();
  if (!description || description.length > 1_024) {
    throw new Error("SKILL.md description must be 1-1024 characters");
  }
  return { name, description };
}

export function hashSkillFiles(
  files: Array<
    Pick<SkillPackageFile, "path" | "contentsBase64" | "executable">
  >,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((first, second) =>
    first.path.localeCompare(second.path),
  )) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.executable ? "1" : "0");
    hash.update("\0");
    hash.update(Buffer.from(file.contentsBase64, "base64"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type SkillLocation = {
  scope: SkillScope;
  rootKind: SkillRootKind;
  folder: string | null;
};

export type SkillScanInstallation = SkillLocation & {
  codebaseId: string | null;
  worktreeId: string | null;
  rootPath: string;
  skillName: string;
  description: string;
  packageHash: string;
  fileCount: number;
  totalBytes: number;
  tracked: boolean;
  consumers: AiTool[];
};

export type SkillScanResult = {
  configuredTools: Array<{
    tool: AiTool;
    configured: boolean;
    homePath: string;
  }>;
  installations: SkillScanInstallation[];
  warnings: string[];
};

export type SkillApplyOperation =
  | (SkillLocation & {
      kind: "WRITE";
      package: SkillPackage;
      manageGitExclude: boolean;
    })
  | (SkillLocation & {
      kind: "DELETE";
      skillName: string;
      manageGitExclude: boolean;
    });

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  const result = stringValue(value, name) as T;
  if (!values.includes(result)) throw new Error(`${name} is invalid`);
  return result;
}

function nullableId(value: unknown, name: string): string | null {
  return value === null ? null : stringValue(value, name);
}

function folderValue(value: unknown, name: string): string {
  const folder = stringValue(value, name);
  if (folder.includes("\0") || folder.length > 4_096) {
    throw new Error(`${name} is invalid`);
  }
  return folder;
}

function skillLocation(value: JsonObject, name: string): SkillLocation {
  const scope = enumValue(value.scope, ["GLOBAL", "PROJECT"], `${name}.scope`);
  const folder =
    value.folder === null ? null : folderValue(value.folder, `${name}.folder`);
  if ((scope === "GLOBAL") !== (folder === null)) {
    throw new Error(`${name}.folder must be null only for global skills`);
  }
  return {
    scope,
    rootKind: enumValue(value.rootKind, SKILL_ROOT_KINDS, `${name}.rootKind`),
    folder,
  };
}

export function validateSkillName(value: unknown, name = "skill name"): string {
  const result = stringValue(value, name);
  if (result.length > 64 || !SKILL_NAME_REGEX.test(result)) {
    throw new Error(
      `${name} must use 1-64 lowercase letters, numbers, and single hyphens`,
    );
  }
  return result;
}

export function validateSkillRelativePath(
  value: unknown,
  name = "file path",
): string {
  const path = stringValue(value, name).replaceAll("\\", "/");
  if (
    path.length > 512 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.includes("\0"),
      )
  ) {
    throw new Error(`${name} must stay within the skill directory`);
  }
  return path;
}

export function parseSkillPackage(
  value: unknown,
  name = "skill package",
): SkillPackage {
  const input = objectValue(value, name);
  const skillName = validateSkillName(input.name, `${name}.name`);
  const description = stringValue(
    input.description,
    `${name}.description`,
  ).trim();
  if (description.length > 1_024) {
    throw new Error(`${name}.description must be 1-1024 characters`);
  }
  if (
    !Array.isArray(input.files) ||
    input.files.length === 0 ||
    input.files.length > MAX_SKILL_FILES
  ) {
    throw new Error(`${name}.files must contain 1-${MAX_SKILL_FILES} files`);
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  const files = input.files.map((item, index) => {
    const file = objectValue(item, `${name}.files[${index}]`);
    const path = validateSkillRelativePath(
      file.path,
      `${name}.files[${index}].path`,
    );
    if (seen.has(path))
      throw new Error(`${name} contains duplicate path ${path}`);
    seen.add(path);
    const contentsBase64 = stringValue(
      file.contentsBase64,
      `${name}.files[${index}].contentsBase64`,
    );
    const byteLength = Buffer.from(contentsBase64, "base64").byteLength;
    if (byteLength > MAX_SKILL_FILE_BYTES)
      throw new Error(`${path} exceeds the per-file limit`);
    totalBytes += byteLength;
    return {
      path,
      contentsBase64,
      executable: file.executable === true,
    };
  });
  if (!seen.has("SKILL.md")) throw new Error(`${name} must contain SKILL.md`);
  if (totalBytes > MAX_SKILL_PACKAGE_BYTES)
    throw new Error(`${name} exceeds the package size limit`);
  const metadata = parseSkillMetadata(
    Buffer.from(
      files.find((file) => file.path === "SKILL.md")!.contentsBase64,
      "base64",
    ).toString("utf8"),
  );
  if (metadata.name !== skillName || metadata.description !== description) {
    throw new Error(`${name} metadata must match SKILL.md frontmatter`);
  }
  const packageHash = stringValue(input.packageHash, `${name}.packageHash`);
  if (hashSkillFiles(files) !== packageHash) {
    throw new Error(`${name}.packageHash does not match its files`);
  }
  return {
    name: skillName,
    description,
    packageHash,
    files,
  };
}

export function parseSkillScanPayload(value: unknown): {
  tools: AiTool[];
  targets: SkillScanTarget[];
} {
  const input = objectValue(value, "skills.scan payload");
  if (!Array.isArray(input.tools) || !Array.isArray(input.targets)) {
    throw new Error("skills.scan requires tools and targets arrays");
  }
  const tools = [
    ...new Set(
      input.tools.map((tool, index) =>
        enumValue(tool, AI_TOOLS, `tools[${index}]`),
      ),
    ),
  ];
  const targets = input.targets.slice(0, 2_000).map((item, index) => {
    const target = objectValue(item, `targets[${index}]`);
    return {
      codebaseId: stringValue(
        target.codebaseId,
        `targets[${index}].codebaseId`,
      ),
      worktreeId: nullableId(target.worktreeId, `targets[${index}].worktreeId`),
      folder: folderValue(target.folder, `targets[${index}].folder`),
    };
  });
  return { tools, targets };
}

export function parseSkillReadPayload(value: unknown): {
  tools: AiTool[];
  targets: SkillScanTarget[];
  requests: Array<SkillLocation & { skillName: string }>;
} {
  const input = objectValue(value, "skills.read payload");
  const scan = parseSkillScanPayload(input);
  if (!Array.isArray(input.requests))
    throw new Error("skills.read requires requests");
  return {
    ...scan,
    requests: input.requests.slice(0, 200).map((item, index) => {
      const request = objectValue(item, `requests[${index}]`);
      return {
        ...skillLocation(request, `requests[${index}]`),
        skillName: validateSkillName(
          request.skillName,
          `requests[${index}].skillName`,
        ),
      };
    }),
  };
}

export function parseSkillApplyPayload(value: unknown): {
  operations: SkillApplyOperation[];
} {
  const input = objectValue(value, "skills.apply payload");
  if (!Array.isArray(input.operations))
    throw new Error("skills.apply requires operations");
  return {
    operations: input.operations.slice(0, 500).map((item, index) => {
      const operation = objectValue(item, `operations[${index}]`);
      const location = skillLocation(operation, `operations[${index}]`);
      if (operation.kind === "WRITE") {
        return {
          kind: "WRITE" as const,
          ...location,
          package: parseSkillPackage(
            operation.package,
            `operations[${index}].package`,
          ),
          manageGitExclude: operation.manageGitExclude === true,
        };
      }
      if (operation.kind === "DELETE") {
        return {
          kind: "DELETE" as const,
          ...location,
          skillName: validateSkillName(
            operation.skillName,
            `operations[${index}].skillName`,
          ),
          manageGitExclude: operation.manageGitExclude === true,
        };
      }
      throw new Error(`operations[${index}].kind is invalid`);
    }),
  };
}
