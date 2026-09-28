import {
  setReference,
  type TransferEntity,
  type TransferPackage,
} from "./package";
import { workflowReferences } from "./references";

/** A package's reference metadata cannot redirect an arbitrary authored field. */
export function validateTransferReferences(pack: TransferPackage): void {
  const referenceKeys = new Set<string>();
  for (const entity of pack.entities) {
    const probe = structuredClone(entity.fields);
    for (const ref of entity.references) {
      let location: unknown = probe;
      for (const part of ref.path) {
        if (
          !location ||
          typeof location !== "object" ||
          !Object.hasOwn(location, part)
        )
          throw new Error(`${entity.name}: reference path does not exist`);
        location = (location as Record<string, unknown>)[part];
      }
      const target = ref.entityKey
        ? pack.entities.find((e) => e.key === ref.entityKey)
        : null;
      if (target && target.kind !== ref.kind)
        throw new Error(
          `${entity.name}: bundled reference has the wrong resource kind`,
        );
      if (referenceKeys.has(ref.key))
        throw new Error("Duplicate package reference key");
      referenceKeys.add(ref.key);
      setReference(probe, ref.path, "portable-reference");
    }
    const expected = expectedReferences(entity, probe);
    const declared = new Map(
      entity.references.map((ref) => [JSON.stringify(ref.path), ref.kind]),
    );
    for (const ref of entity.references)
      if (expected.get(JSON.stringify(ref.path)) !== ref.kind)
        throw new Error(
          `${entity.name}: unsupported reference path or resource kind`,
        );
    for (const [path, kind] of expected)
      if (declared.get(path) !== kind)
        throw new Error(
          `${entity.name}: a local resource identifier is missing portable reference metadata`,
        );
  }
}
function expectedReferences(
  entity: TransferEntity,
  fields: Record<string, unknown>,
): Map<string, string> {
  const result = new Map<string, string>();
  const scalar = (path: (string | number)[], kind: string) => {
    let value: unknown = fields;
    for (const part of path) {
      if (!value || typeof value !== "object") return;
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === "string" && value)
      result.set(JSON.stringify(path), kind);
  };
  const array = (field: string, kind: string) => {
    if (Array.isArray(fields[field]))
      fields[field].forEach((_, i) => scalar([field, i], kind));
  };
  switch (entity.kind) {
    case "APP":
      array("repositoryIds", "REPOSITORY");
      break;
    case "COMMAND":
      array("targetRepositoryIds", "REPOSITORY");
      scalar(["targetAgentId"], "AGENT");
      break;
    case "WORKFLOW":
      array("repositoryIds", "REPOSITORY");
      scalar(["activeVersionId"], "WORKFLOW_VERSION");
      break;
    case "WORKFLOW_VERSION":
      scalar(["workflowId"], "WORKFLOW");
      break;
    case "SKILL_GROUP":
      scalar(["groupId"], "SKILL_GROUP_RESOURCE");
      break;
    case "BUILD_SCRIPT":
      if (Array.isArray(fields.assignments))
        fields.assignments.forEach((_, i) =>
          scalar(["assignments", i, "repositoryId"], "REPOSITORY"),
        );
      break;
    case "AUTO_RETRY":
      if (Array.isArray(fields.targets))
        fields.targets.forEach((_, i) =>
          scalar(["targets", i, "workflowId"], "GITHUB_WORKFLOW"),
        );
      break;
  }
  for (const field of entity.kind === "WORKFLOW"
    ? ["draftDefinition"]
    : entity.kind === "WORKFLOW_VERSION"
      ? ["definition"]
      : []) {
    if (fields[field] && typeof fields[field] === "object")
      for (const ref of workflowReferences(
        fields[field] as Record<string, unknown>,
        [field],
      ))
        result.set(JSON.stringify(ref.path), ref.kind);
  }
  return result;
}
