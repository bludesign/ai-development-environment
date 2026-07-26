import type { BuildDestination } from "@/components/builds/types";

export type ActionCenterResourceKind =
  "PLAN" | "SESSION" | "BUILD" | "WORKFLOW";

export type ActionCenterReason =
  "QUESTION" | "BLOCKED" | "FAILED" | "UNRUN_BUILD" | "ACTIVE";

export type ActionCenterQuestion = {
  id: string;
  position: number;
  header: string | null;
  prompt: string;
  multiSelect: boolean;
  allowCustom: boolean;
  options: Array<{
    id: string;
    position: number;
    label: string;
    description: string | null;
  }>;
};

export type ActionCenterQuestionBatch = {
  id: string;
  sourceKind: string | null;
  createdAt: string;
  questions: ActionCenterQuestion[];
};

export type ActionCenterItem = {
  key: string;
  resourceKind: ActionCenterResourceKind;
  reason: ActionCenterReason;
  resourceId: string;
  href: string;
  displayNumber: number | null;
  label: string;
  summary: string | null;
  status: string;
  phase: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  worktree: {
    id: string;
    folder: string;
    branch: string | null;
    highlightColor: string | null;
  } | null;
  questionBatches: ActionCenterQuestionBatch[];
  buildRun: {
    buildId: string;
    destinationType: BuildDestination["type"];
    preferredDestination: BuildDestination;
  } | null;
  failureFingerprint: string | null;
};

export type ActionCenterPageView = {
  items: ActionCenterItem[];
  nextCursor: string | null;
  totalCount: number;
  needsAttentionCount: number;
  activeCount: number;
};

export const ACTION_CENTER_ITEM_FIELDS = `
  key resourceKind reason resourceId href displayNumber label summary status phase error
  createdAt updatedAt failureFingerprint
  worktree { id folder branch highlightColor }
  questionBatches {
    id sourceKind createdAt
    questions {
      id position header prompt multiSelect allowCustom
      options { id position label description }
    }
  }
  buildRun { buildId destinationType preferredDestination }
`;
