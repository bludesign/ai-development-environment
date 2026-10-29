import * as z from "zod/v4";

import type { RepositoryTransferService } from "@/services/repository-transfer/repository-transfer.service";
import {
  MAX_TRANSFER_BYTES,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  entityKinds,
} from "@/services/repository-transfer/package";
import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

const Id = z.string().trim().min(1).max(256);
const Key = z.string().min(1).max(500);
const Keys = z.array(Key).max(10000);
const Json = z.json();
const Candidate = z.object({ id: z.string(), label: z.string() });
const Selection = z.object({
  key: z.string(),
  parentKey: z.string().nullable(),
  kind: z.string(),
  label: z.string(),
  repositoryKey: z.string().nullable(),
  selected: z.boolean(),
  dependency: z.boolean(),
  action: z.enum(["IMPORT", "KEEP", "COPY"]),
  targetId: z.string().nullable(),
  candidates: z.array(Candidate),
  current: Json,
  incoming: Json,
  affectedRepositories: z.array(z.string()),
  warnings: z.array(z.string()),
});
const Agent = z.object({
  id: z.string(),
  name: z.string(),
  baseRepoDirectory: z.string().nullable(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
});
const Destination = z.object({
  repositoryKey: z.string(),
  repositoryId: z.string().nullable(),
  agentId: z.string(),
  remoteUrl: z.string(),
  relativePath: z.string(),
  destinationPath: z.string(),
  status: z.string(),
  error: z.string().nullable(),
});
const DestinationInput = z.object({
  repositoryKey: Key,
  agentId: Id,
  relativePath: z.string().max(4096).nullable().optional(),
  remoteUrl: z.string().max(4096).nullable().optional(),
});
const Package = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.literal(TRANSFER_VERSION),
  scope: z.enum(["APP", "REPOSITORY"]),
  rootKey: z.string(),
  entities: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(entityKinds),
      name: z.string(),
      repositoryKey: z.string().optional(),
      parentKey: z.string().optional(),
      dependency: z.boolean(),
      fields: z.record(z.string(), Json),
      references: z.array(
        z.object({
          key: z.string(),
          kind: z.string(),
          label: z.string(),
          path: z.array(z.union([z.string(), z.number().int()])),
          entityKey: z.string().optional(),
          identity: z.record(z.string(), Json),
        }),
      ),
    }),
  ),
});
const ExportInput = z.object({
  scope: z.enum(["APP", "REPOSITORY"]),
  id: Id,
  excludedKeys: Keys.nullable().optional(),
  includedKeys: Keys.nullable().optional(),
});
const ImportInput = z.object({
  payload: z
    .union([z.string().max(MAX_TRANSFER_BYTES), Json])
    .refine(
      (value) =>
        Buffer.byteLength(
          typeof value === "string" ? value : JSON.stringify(value),
        ) <= MAX_TRANSFER_BYTES,
      "Transfer package must be 100 MiB or smaller",
    ),
  excludedKeys: Keys.nullable().optional(),
  includedKeys: Keys.nullable().optional(),
  choices: z
    .array(
      z.object({
        key: Key,
        action: z.enum(["IMPORT", "KEEP", "COPY"]),
        targetId: Id.nullable().optional(),
        name: z.string().max(120).nullable().optional(),
      }),
    )
    .max(10000)
    .nullable()
    .optional(),
  mappings: z
    .array(z.object({ key: Key, targetId: Id }))
    .max(10000)
    .nullable()
    .optional(),
  targetRepositoryId: Id.nullable().optional(),
  sourceRepositoryKey: Key.nullable().optional(),
  destinations: z.array(DestinationInput).max(10000).nullable().optional(),
  enableWorkflowKeys: Keys.nullable().optional(),
});
const Preview = z.object({
  fingerprint: z.string(),
  items: z.array(Selection),
  dependencies: z.array(
    z.object({
      key: z.string(),
      itemKey: z.string(),
      kind: z.string(),
      label: z.string(),
      targetId: z.string().nullable(),
      resolved: z.boolean(),
      candidates: z.array(Candidate),
    }),
  ),
  agents: z.array(Agent),
  destinations: z.array(Destination),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
});
const Overview = z.object({
  appId: z.string(),
  fingerprint: z.string(),
  selectedAgentIds: z.array(z.string()),
  agents: z.array(Agent),
  repositories: z.array(Selection),
  destinations: z.array(Destination),
});
const Operation = z.object({
  id: z.string(),
  requestId: z.string(),
  kind: z.string(),
  status: z.string(),
  appId: z.string().nullable(),
  result: Json,
  items: z.array(
    z.object({
      id: z.string(),
      repositoryId: z.string(),
      agentId: z.string(),
      codebaseId: z.string().nullable(),
      destinationPath: z.string(),
      status: z.string(),
      jobId: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
function operationView(
  value: Awaited<ReturnType<RepositoryTransferService["clones"]["read"]>>,
) {
  if (!value) return null;
  // Omit the persisted request hash, clone credentials and internal scheduling fields.
  return Operation.parse({
    ...value,
    result: JSON.parse(value.resultJson),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  });
}

export function createRepositoryTransferToolGroup(
  service: RepositoryTransferService,
): BuiltInToolGroup {
  return {
    id: "builtin:repository-transfer",
    name: "Repository Transfer",
    children: [],
    tools: [
      defineTool({
        name: "get_repository_transfer_export_preview",
        title: "Preview repository export",
        description:
          "Review portable configuration and selectable dependencies before exporting. Authored scripts and selected preparation contents are included.",
        inputSchema: z.object({ input: ExportInput }),
        outputSchema: z.object({
          preview: z.object({
            payload: Package,
            items: z.array(Selection),
            warnings: z.array(z.string()),
          }),
        }),
        handler: async ({ input }) => ({
          preview: await service.exportPreview(input),
        }),
      }),
      defineTool({
        name: "export_repository_transfer",
        title: "Export repository configuration",
        description:
          "Export the selected versioned app or repository configuration package, without credentials.",
        inputSchema: z.object({ input: ExportInput }),
        outputSchema: z.object({ payload: Package }),
        handler: async ({ input }) => ({
          payload: await service.export(input),
        }),
      }),
      defineTool({
        name: "preview_repository_transfer",
        title: "Preview repository import",
        description:
          "Review incoming configuration, mappings and clone destinations. Resolve blockers and use this fingerprint when applying the same choices.",
        inputSchema: z.object({ input: ImportInput }),
        outputSchema: z.object({ preview: Preview }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ input }) => ({
          preview: await service.preview(input),
        }),
      }),
      defineTool({
        name: "apply_repository_transfer",
        title: "Apply repository import",
        description:
          "Apply the reviewed package and queue selected checkouts. Requires the matching preview fingerprint and a unique idempotent request ID.",
        inputSchema: z.object({
          input: ImportInput,
          fingerprint: z.string().min(1).max(256),
          requestId: Id,
        }),
        outputSchema: z.object({ operation: Operation.nullable() }),
        annotations: { ...DESTRUCTIVE_ANNOTATIONS, openWorldHint: true },
        handler: async ({ input, fingerprint, requestId }) => ({
          operation: operationView(
            await service.apply(input, fingerprint, requestId),
          ),
        }),
      }),
      defineTool({
        name: "get_repository_transfer_operation",
        title: "Get repository transfer operation",
        description:
          "Read durable transfer progress and per-checkout errors without dispatching new work.",
        inputSchema: z.object({ id: Id }),
        outputSchema: z.object({ operation: Operation.nullable() }),
        handler: async ({ id }) => ({
          operation: operationView(await service.clones.read(id)),
        }),
      }),
      defineTool({
        name: "retry_repository_transfer",
        title: "Retry repository transfer",
        description:
          "Retry failed checkouts without reapplying imported configuration. Requires an idempotent retry request ID.",
        inputSchema: z.object({ id: Id, requestId: Id }),
        outputSchema: z.object({ operation: Operation.nullable() }),
        annotations: { ...WRITE_ANNOTATIONS, openWorldHint: true },
        handler: async ({ id, requestId }) => ({
          operation: operationView(await service.clones.retry(id, requestId)),
        }),
      }),
      defineTool({
        name: "get_app_repository_sync",
        title: "Get app repository sync",
        description:
          "Read repository checkout coverage across registered agents and the fingerprint required to queue missing checkouts.",
        inputSchema: z.object({ appId: Id }),
        outputSchema: z.object({ overview: Overview }),
        handler: async ({ appId }) => ({
          overview: await service.syncOverview(appId),
        }),
      }),
      defineTool({
        name: "sync_app_repositories",
        title: "Sync app repositories",
        description:
          "Queue missing app checkouts on reviewed destinations using the current coverage fingerprint and idempotent request ID.",
        inputSchema: z.object({
          appId: Id,
          destinations: z.array(DestinationInput).min(1).max(10000),
          fingerprint: z.string().min(1).max(256),
          requestId: Id,
        }),
        outputSchema: z.object({ operation: Operation.nullable() }),
        annotations: { ...WRITE_ANNOTATIONS, openWorldHint: true },
        handler: async ({ appId, destinations, fingerprint, requestId }) => ({
          operation: operationView(
            await service.sync(appId, destinations, fingerprint, requestId),
          ),
        }),
      }),
    ],
  };
}
