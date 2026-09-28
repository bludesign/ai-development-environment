export type TransferAction = "IMPORT" | "KEEP" | "COPY";
export type TransferItem = {
  key: string;
  parentKey: string | null;
  kind: string;
  label: string;
  repositoryKey: string | null;
  selected: boolean;
  dependency: boolean;
  action: TransferAction;
  targetId: string | null;
  candidates: Array<{ id: string; label: string }>;
  current: unknown;
  incoming: unknown;
  affectedRepositories: string[];
  warnings: string[];
};
export type TransferDependency = {
  key: string;
  itemKey: string;
  kind: string;
  label: string;
  targetId: string | null;
  resolved: boolean;
  candidates: Array<{ id: string; label: string }>;
};
export type TransferAgent = {
  id: string;
  name: string;
  baseRepoDirectory: string | null;
  eligible: boolean;
  reason: string | null;
};
export type TransferDestinationInput = {
  repositoryKey: string;
  agentId: string;
  relativePath?: string;
  remoteUrl?: string;
};
export type TransferDestination = TransferDestinationInput & {
  repositoryId: string | null;
  remoteUrl: string;
  relativePath: string;
  destinationPath: string;
  status: string;
  error: string | null;
};
export type TransferChoice = {
  key: string;
  action: TransferAction;
  targetId?: string;
  name?: string;
};
export type TransferInput = {
  payload: unknown;
  excludedKeys: string[];
  includedKeys: string[];
  choices: TransferChoice[];
  mappings: Array<{ key: string; targetId: string }>;
  targetRepositoryId?: string;
  sourceRepositoryKey?: string;
  destinations: TransferDestinationInput[];
  enableWorkflowKeys: string[];
};
export type TransferPreview = {
  fingerprint: string;
  items: TransferItem[];
  dependencies: TransferDependency[];
  agents: TransferAgent[];
  destinations: TransferDestination[];
  warnings: string[];
  blockers: string[];
};
export type TransferExportPreview = {
  payload: unknown;
  items: TransferItem[];
  warnings: string[];
};
export type TransferOperation = {
  id: string;
  requestId: string;
  kind: string;
  status: string;
  appId: string | null;
  result: unknown;
  items: Array<{
    id: string;
    repositoryId: string;
    agentId: string;
    codebaseId: string | null;
    destinationPath: string;
    status: string;
    jobId: string | null;
    error: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
};
export type SyncOverview = {
  appId: string;
  fingerprint: string;
  selectedAgentIds: string[];
  agents: TransferAgent[];
  repositories: TransferItem[];
  destinations: TransferDestination[];
};

export const TRANSFER_ITEM_FIELDS = `key parentKey kind label repositoryKey selected dependency action targetId candidates { id label } current incoming affectedRepositories warnings`;
export const TRANSFER_AGENT_FIELDS = `id name baseRepoDirectory eligible reason`;
export const TRANSFER_DESTINATION_FIELDS = `repositoryKey repositoryId agentId remoteUrl relativePath destinationPath status error`;
export const TRANSFER_PREVIEW_FIELDS = `
  fingerprint items { ${TRANSFER_ITEM_FIELDS} }
  dependencies { key itemKey kind label targetId resolved candidates { id label } }
  agents { ${TRANSFER_AGENT_FIELDS} }
  destinations { ${TRANSFER_DESTINATION_FIELDS} }
  warnings blockers
`;
export const TRANSFER_OPERATION_FIELDS = `
  id requestId kind status appId result createdAt updatedAt
  items { id repositoryId agentId codebaseId destinationPath status jobId error }
`;
export const SYNC_OVERVIEW_FIELDS = `
  appId fingerprint selectedAgentIds
  agents { ${TRANSFER_AGENT_FIELDS} }
  repositories { ${TRANSFER_ITEM_FIELDS} }
  destinations { ${TRANSFER_DESTINATION_FIELDS} }
`;

export function isRepositoryItem(item: TransferItem) {
  return item.kind.toUpperCase() === "REPOSITORY";
}
export function isWorkflowItem(item: TransferItem) {
  return item.kind.toUpperCase() === "WORKFLOW";
}
