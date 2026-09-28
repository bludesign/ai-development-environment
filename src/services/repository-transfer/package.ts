import { createHash } from "node:crypto";
import { z } from "zod";

export const TRANSFER_FORMAT = "aide.repository-transfer";
export const TRANSFER_VERSION = 1;
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
export const entityKinds = [
  "APP",
  "REPOSITORY",
  "PREPARATION",
  "BUILD_CONFIGURATION",
  "BUILD_SCRIPT",
  "SKILL_GROUP",
  "AUTO_RETRY",
  "COMMAND",
  "WORKFLOW",
  "WORKFLOW_VERSION",
] as const;
const safePath = z
  .array(
    z.union([
      z
        .string()
        .refine((v) => !["__proto__", "prototype", "constructor"].includes(v)),
      z.number().int().nonnegative(),
    ]),
  )
  .min(1)
  .max(30);
const referenceSchema = z
  .object({
    key: z.string().min(1).max(500),
    kind: z.string().max(80),
    label: z.string().max(500),
    path: safePath,
    entityKey: z.string().optional(),
    identity: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const entitySchema = z
  .object({
    key: z.string().min(1).max(500),
    kind: z.enum(entityKinds),
    name: z.string().min(1).max(500),
    repositoryKey: z.string().optional(),
    parentKey: z.string().optional(),
    dependency: z.boolean().default(false),
    fields: z.record(z.string(), z.unknown()),
    references: z.array(referenceSchema).max(10000).default([]),
  })
  .strict();
const packageSchema = z
  .object({
    format: z.literal(TRANSFER_FORMAT),
    version: z.literal(TRANSFER_VERSION),
    scope: z.enum(["APP", "REPOSITORY"]),
    rootKey: z.string(),
    entities: z.array(entitySchema).min(1).max(10000),
  })
  .strict();
export type TransferEntity = z.infer<typeof entitySchema>;
export type TransferReference = z.infer<typeof referenceSchema>;
export type TransferPackage = z.infer<typeof packageSchema>;
export type TransferChoice = {
  key: string;
  action: "IMPORT" | "KEEP" | "COPY";
  targetId?: string | null;
  name?: string | null;
};
export type TransferDestinationInput = {
  repositoryKey: string;
  agentId: string;
  relativePath?: string | null;
  remoteUrl?: string | null;
};
export type TransferExportInput = {
  scope: "APP" | "REPOSITORY";
  id: string;
  excludedKeys?: string[] | null;
  includedKeys?: string[] | null;
};
export type TransferImportInput = {
  payload: unknown;
  excludedKeys?: string[] | null;
  includedKeys?: string[] | null;
  choices?: TransferChoice[] | null;
  mappings?: { key: string; targetId: string }[] | null;
  targetRepositoryId?: string | null;
  sourceRepositoryKey?: string | null;
  destinations?: TransferDestinationInput[] | null;
  enableWorkflowKeys?: string[] | null;
};
export type SelectionItem = {
  key: string;
  parentKey: string | null;
  kind: string;
  label: string;
  repositoryKey: string | null;
  selected: boolean;
  dependency: boolean;
  action: "IMPORT" | "KEEP" | "COPY";
  targetId: string | null;
  candidates: { id: string; label: string }[];
  current: unknown;
  incoming: unknown;
  affectedRepositories: string[];
  warnings: string[];
};
export type Dependency = {
  key: string;
  itemKey: string;
  kind: string;
  label: string;
  targetId: string | null;
  resolved: boolean;
  candidates: { id: string; label: string }[];
};
export const repositoryFields = [
  "name",
  "description",
  "jiraBranchRegex",
  "keepBaseBranchUpToDate",
] as const;

export function parseTransferPackage(raw: unknown): TransferPackage {
  const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!serialized || Buffer.byteLength(serialized) > MAX_TRANSFER_BYTES)
    throw new Error("Transfer package must be 100 MiB or smaller");
  const value = packageSchema.parse(JSON.parse(serialized));
  const keys = new Set(value.entities.map((e) => e.key));
  if (keys.size !== value.entities.length)
    throw new Error("Package contains duplicate item keys");
  if (!keys.has(value.rootKey)) throw new Error("Package root is missing");
  if (value.entities.find((e) => e.key === value.rootKey)?.kind !== value.scope)
    throw new Error("Package root does not match its scope");
  for (const entity of value.entities) {
    if (
      entity.repositoryKey &&
      value.entities.find((e) => e.key === entity.repositoryKey)?.kind !==
        "REPOSITORY"
    )
      throw new Error(
        "Item repository owner must reference a packaged repository",
      );
    if (
      [
        "PREPARATION",
        "BUILD_CONFIGURATION",
        "SKILL_GROUP",
        "AUTO_RETRY",
      ].includes(entity.kind) &&
      (!entity.repositoryKey || entity.parentKey !== entity.repositoryKey)
    )
      throw new Error("Repository setting has an invalid owner");
    if (
      entity.kind === "WORKFLOW_VERSION" &&
      value.entities.find((e) => e.key === entity.parentKey)?.kind !==
        "WORKFLOW"
    )
      throw new Error("Workflow version must belong to a packaged workflow");
    if (entity.parentKey && !keys.has(entity.parentKey))
      throw new Error(`Missing parent for ${entity.name}`);
    let parent = entity.parentKey;
    const seen = new Set([entity.key]);
    while (parent) {
      if (seen.has(parent))
        throw new Error("Package selection contains a cycle");
      seen.add(parent);
      parent = value.entities.find((e) => e.key === parent)?.parentKey;
    }
    const refKeys = new Set(entity.references.map((r) => r.key));
    if (refKeys.size !== entity.references.length)
      throw new Error("Duplicate reference keys");
  }
  return value;
}
export function selectedEntity(
  entity: TransferEntity,
  pack: TransferPackage,
  input: { excludedKeys?: string[] | null; includedKeys?: string[] | null },
): boolean {
  const excluded = new Set(input.excludedKeys ?? []);
  if (entity.dependency && !(input.includedKeys ?? []).includes(entity.key))
    return false;
  let key: string | undefined = entity.key;
  while (key) {
    const current = pack.entities.find((e) => e.key === key);
    if (
      excluded.has(key) ||
      (current?.dependency && !(input.includedKeys ?? []).includes(key))
    )
      return false;
    key = current?.parentKey;
  }
  return true;
}
export function selectionItems(
  pack: TransferPackage,
  input: { excludedKeys?: string[] | null; includedKeys?: string[] | null },
): SelectionItem[] {
  return pack.entities.flatMap((entity) => {
    const selected = selectedEntity(entity, pack, input);
    const common = {
      repositoryKey:
        entity.repositoryKey ??
        (entity.kind === "REPOSITORY" ? entity.key : null),
      dependency: entity.dependency,
      action: "IMPORT" as const,
      targetId: null,
      candidates: [],
      current: null,
      affectedRepositories: [],
      warnings: [],
    };
    const item: SelectionItem = {
      ...common,
      key: entity.key,
      parentKey: entity.parentKey ?? null,
      kind: entity.kind,
      label: entity.name,
      selected,
      incoming: entity.fields,
    };
    return [
      item,
      ...(entity.kind === "REPOSITORY"
        ? repositoryFields
            .filter((field) => Object.hasOwn(entity.fields, field))
            .map((field) => ({
              ...common,
              key: `${entity.key}/field/${field}`,
              parentKey: entity.key,
              kind: "SETTING",
              label: field,
              selected:
                selected &&
                !(input.excludedKeys ?? []).includes(
                  `${entity.key}/field/${field}`,
                ),
              incoming: entity.fields[field],
            }))
        : []),
    ];
  });
}
export function filteredPackage(
  pack: TransferPackage,
  input: { excludedKeys?: string[] | null; includedKeys?: string[] | null },
): TransferPackage {
  const entities = pack.entities
    .filter((e) => selectedEntity(e, pack, input))
    .map((e) => {
      const fields = { ...e.fields };
      if (e.kind === "REPOSITORY")
        for (const field of repositoryFields)
          if (input.excludedKeys?.includes(`${e.key}/field/${field}`))
            delete fields[field];
      let references = e.references;
      if (e.kind === "WORKFLOW") {
        const active = e.references.find(
          (r) => r.path[0] === "activeVersionId",
        );
        if (
          active?.entityKey &&
          input.excludedKeys?.includes(active.entityKey)
        ) {
          delete fields.activeVersionId;
          references = references.filter((r) => r !== active);
        }
      }
      return { ...e, fields, references, dependency: false };
    });
  // Excluded package entities retain portable reference metadata for explicit mapping.
  const keys = new Set(entities.map((e) => e.key));
  return {
    ...pack,
    entities: entities.map((e) => ({
      ...pruneAppMembership(e, keys),
      parentKey: e.parentKey && keys.has(e.parentKey) ? e.parentKey : undefined,
    })),
  };
}
export function setReference(
  value: Record<string, unknown>,
  path: (string | number)[],
  replacement: unknown,
): void {
  let current: unknown = value;
  for (const part of path.slice(0, -1)) {
    if (!current || typeof current !== "object")
      throw new Error("Reference path is invalid");
    current = (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== "object")
    throw new Error("Reference path is invalid");
  (current as Record<string, unknown>)[path.at(-1)!] = replacement;
}
export function fingerprint(value: unknown): string {
  const stable = (v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, stable(x)]),
            )
          : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export const jsonValue = (value: unknown): Record<string, unknown> =>
  typeof value === "string"
    ? JSON.parse(value)
    : (value as Record<string, unknown>);
export const pick = (
  value: object,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, (value as Record<string, unknown>)[key]]),
  );

/** App membership follows the repository selection; unrelated command scopes remain explicit dependencies. */
export function pruneAppMembership(
  entity: TransferEntity,
  selectedRepositoryKeys: Set<string>,
): TransferEntity {
  if (entity.kind !== "APP") return entity;
  const references = entity.references.filter(
    (r) => r.path[0] !== "repositoryIds",
  );
  const repositoryIds: unknown[] = [];
  for (const ref of entity.references.filter(
    (r) => r.path[0] === "repositoryIds",
  )) {
    if (ref.entityKey && !selectedRepositoryKeys.has(ref.entityKey)) continue;
    const index = repositoryIds.length;
    repositoryIds.push(null);
    references.push({ ...ref, path: ["repositoryIds", index] });
  }
  return { ...entity, fields: { ...entity.fields, repositoryIds }, references };
}
