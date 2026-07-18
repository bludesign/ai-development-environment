import type { Agent } from "@/components/agents/types";

export type SkillFile = {
  id: string;
  path: string;
  contentsBase64: string;
  executable: boolean;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  syncGlobally: boolean;
  packageHash: string;
  files: SkillFile[];
  groups: SkillGroupSummary[];
  createdAt: string;
  updatedAt: string;
};

export type SkillGroupSummary = {
  id: string;
  name: string;
  skills?: SkillSummary[];
  repositories?: RepositorySummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type RepositorySummary = {
  id: string;
  name: string;
  displayOrigin: string;
};

export type SkillSettings = {
  autoSyncProjectGroups: boolean;
  cursorEnabled: boolean;
  githubCopilotEnabled: boolean;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  openCodeEnabled: boolean;
  updatedAt: string;
};

export type SkillTool =
  "CURSOR" | "GITHUB_COPILOT" | "CODEX" | "CLAUDE" | "OPENCODE";

export type SkillToolObservation = {
  tool: SkillTool;
  configured: boolean;
  homePath: string;
  checkedAt: string;
  agent: Agent;
};

export type SkillInstallation = {
  id: string;
  scope: "GLOBAL" | "PROJECT";
  rootKind: string;
  rootPath: string;
  skillName: string;
  description: string;
  packageHash: string;
  fileCount: number;
  totalBytes: number;
  tracked: boolean;
  consumers: SkillTool[];
  lastSeenAt: string;
  agent: Agent;
  codebase: {
    id: string;
    folder: string;
    repository: RepositorySummary;
  } | null;
  worktree: { id: string; folder: string } | null;
  skill: Pick<SkillSummary, "id" | "name" | "packageHash"> | null;
};

export type SkillsOverview = {
  skills: SkillSummary[];
  groups: SkillGroupSummary[];
  observations: SkillToolObservation[];
  installations: SkillInstallation[];
  settings: SkillSettings;
  repositories: RepositorySummary[];
};

export type SkillSyncItem = {
  id: string;
  direction: string;
  status: string;
  sourceHash: string | null;
  targetHash: string | null;
  resolution: string | null;
  candidatePackage: {
    package?: {
      name: string;
      description: string;
      packageHash: string;
      files: Array<{
        path: string;
        contentsBase64: string;
        executable: boolean;
      }>;
    };
    projectGroupRequired?: boolean;
  } | null;
  error: string | null;
  skill: Pick<SkillSummary, "id" | "name" | "description"> | null;
  installation: (SkillInstallation & { agent: Agent }) | null;
  agent: Agent | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillSyncRun = {
  id: string;
  kind: "ALL" | "GROUP";
  status: string;
  error: string | null;
  group: SkillGroupSummary | null;
  items: SkillSyncItem[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export const SKILL_FIELDS = `
  id name description syncGlobally packageHash createdAt updatedAt
  files { id path contentsBase64 executable contentHash createdAt updatedAt }
  groups { id name createdAt updatedAt }
`;

export const SKILL_SYNC_RUN_FIELDS = `
  id kind status error createdAt updatedAt finishedAt
  group { id name }
  items {
    id direction status sourceHash targetHash resolution candidatePackage error createdAt updatedAt
    skill { id name description }
    agent { id name hostname connectionStatus }
    installation {
      id scope rootKind rootPath skillName description packageHash fileCount totalBytes tracked consumers lastSeenAt
      agent { id name hostname connectionStatus }
      codebase { id folder repository { id name displayOrigin } }
      worktree { id folder }
      skill { id name packageHash }
    }
  }
`;
