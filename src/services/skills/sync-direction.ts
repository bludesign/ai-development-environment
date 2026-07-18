import type {
  AiTool,
  SkillRootKind,
} from "@ai-development-environment/agent-contract/skills";

export type SkillVersionDirection =
  "UNCHANGED" | "IMPORT" | "EXPORT" | "CONFLICT";

export function selectSharedSkillRoots(
  tools: AiTool[],
  scope: "GLOBAL" | "PROJECT",
): SkillRootKind[] {
  const roots: SkillRootKind[] = [];
  const hasClaude = tools.includes("CLAUDE");
  if (hasClaude) roots.push("CLAUDE");
  if (
    tools.includes("CODEX") ||
    (!hasClaude && tools.length > 0) ||
    (scope === "GLOBAL" && tools.includes("GITHUB_COPILOT"))
  ) {
    roots.push("AGENTS");
  }
  return roots;
}

export function hasDivergentTargetVersions(
  databaseHash: string | null,
  targetHashes: string[],
): boolean {
  return (
    new Set(
      targetHashes.filter(
        (targetHash) => databaseHash === null || targetHash !== databaseHash,
      ),
    ).size > 1
  );
}

export function compareSkillVersions(input: {
  databaseHash: string;
  targetHash: string;
  baselineHash: string | null;
  tracked: boolean;
}): SkillVersionDirection {
  if (input.databaseHash === input.targetHash) return "UNCHANGED";
  if (input.tracked) return "CONFLICT";
  if (input.baselineHash === input.databaseHash) return "IMPORT";
  if (input.baselineHash === input.targetHash) return "EXPORT";
  return "CONFLICT";
}
