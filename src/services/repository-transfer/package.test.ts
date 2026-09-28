import { expect, test } from "vitest";

import {
  filteredPackage,
  fingerprint,
  parseTransferPackage,
  selectionItems,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  type TransferEntity,
  type TransferPackage,
} from "./package";

test("review fingerprints retain date revisions and ignore object key order", () => {
  const first = new Date("2026-09-27T12:00:00Z");
  const second = new Date("2026-09-27T12:01:00Z");
  expect(fingerprint({ revision: first, name: "Repo" })).toBe(
    fingerprint({ name: "Repo", revision: first }),
  );
  expect(fingerprint({ revision: first })).not.toBe(
    fingerprint({ revision: second }),
  );
});

const entity = (
  key: string,
  kind: TransferEntity["kind"],
  extra: Partial<TransferEntity> = {},
): TransferEntity => ({
  key,
  kind,
  name: key,
  dependency: false,
  fields: {},
  references: [],
  ...extra,
});
const pack = (entities: TransferEntity[]): TransferPackage => ({
  format: TRANSFER_FORMAT,
  version: TRANSFER_VERSION,
  scope: "REPOSITORY",
  rootKey: "root",
  entities: [entity("root", "REPOSITORY"), ...entities],
});

test("an optional repository excludes its nested settings and definitions until included", () => {
  const payload = pack([
    entity("optional", "REPOSITORY", {
      dependency: true,
      fields: { name: "Optional", description: "Keep" },
    }),
    entity("configuration", "BUILD_CONFIGURATION", {
      parentKey: "optional",
      repositoryKey: "optional",
    }),
  ]);
  const selected = (input: Parameters<typeof selectionItems>[1]) =>
    selectionItems(payload, input)
      .filter((item) => item.selected)
      .map((item) => item.key);
  expect(selected({})).toEqual(["root"]);
  expect(selected({ includedKeys: ["configuration"] })).toEqual(["root"]);
  expect(
    selected({
      includedKeys: ["optional"],
      excludedKeys: ["optional/field/description"],
    }),
  ).toEqual(["root", "optional", "optional/field/name", "configuration"]);
  expect(
    selected({ includedKeys: ["optional"], excludedKeys: ["optional"] }),
  ).toEqual(["root"]);
});

test("filtering preserves unmapped dependency identity while pruning only app membership", () => {
  const reference = (key: string, path: (string | number)[]) => ({
    key,
    kind: "REPOSITORY",
    entityKey: "optional",
    path,
    label: "Optional",
    identity: { canonicalOrigin: "github.com/acme/optional" },
  });
  const payload = pack([
    entity("optional", "REPOSITORY", { dependency: true }),
    entity("app", "APP", {
      fields: { repositoryIds: [null] },
      references: [reference("app-ref", ["repositoryIds", 0])],
    }),
    entity("command", "COMMAND", {
      fields: { targetRepositoryIds: [null] },
      references: [reference("command-ref", ["targetRepositoryIds", 0])],
    }),
  ]);
  const result = filteredPackage(payload, {});
  expect(result.entities.find(({ key }) => key === "app")).toMatchObject({
    fields: { repositoryIds: [] },
    references: [],
  });
  expect(
    result.entities.find(({ key }) => key === "command")?.references,
  ).toEqual(payload.entities.find(({ key }) => key === "command")?.references);
  expect(result.entities.some(({ key }) => key === "optional")).toBe(false);
});

test("a draft-only export omits the selected workflow snapshot reference without mutating source", () => {
  const workflow = entity("workflow", "WORKFLOW", {
    fields: { activeVersionId: null, draftDefinition: { name: "Draft" } },
    references: [
      {
        key: "active",
        kind: "WORKFLOW_VERSION",
        label: "Published",
        entityKey: "snapshot",
        path: ["activeVersionId"],
        identity: {},
      },
    ],
  });
  const payload = pack([
    workflow,
    entity("snapshot", "WORKFLOW_VERSION", { parentKey: "workflow" }),
  ]);
  const result = filteredPackage(payload, { excludedKeys: ["snapshot"] });
  expect(result.entities.find(({ key }) => key === "workflow")).toMatchObject({
    fields: { draftDefinition: { name: "Draft" } },
    references: [],
  });
  expect(
    result.entities.find(({ key }) => key === "workflow")?.fields,
  ).not.toHaveProperty("activeVersionId");
  expect(workflow.fields).toHaveProperty("activeVersionId", null);
  expect(workflow.references).toHaveLength(1);
});

test("package parsing validates root scope and repository ownership", () => {
  expect(() => parseTransferPackage({ ...pack([]), scope: "APP" })).toThrow(
    /scope/,
  );
  expect(() =>
    parseTransferPackage(
      pack([
        entity("config", "BUILD_CONFIGURATION", { repositoryKey: "missing" }),
      ]),
    ),
  ).toThrow(/repository owner/);
  expect(() =>
    parseTransferPackage(pack([entity("config", "BUILD_CONFIGURATION")])),
  ).toThrow(/repository/i);
});

test("package parsing rejects cyclic parents and prototype reference paths", () => {
  expect(() =>
    parseTransferPackage(
      pack([
        entity("one", "WORKFLOW", { parentKey: "two" }),
        entity("two", "WORKFLOW_VERSION", { parentKey: "one" }),
      ]),
    ),
  ).toThrow(/cycle/);
  const payload = pack([
    entity("workflow", "WORKFLOW", {
      references: [
        {
          key: "unsafe",
          kind: "AGENT",
          label: "Agent",
          path: ["__proto__", "modified"],
          identity: {},
        },
      ],
    }),
  ]);
  expect(() => parseTransferPackage(payload)).toThrow();
  expect({}).not.toHaveProperty("modified");
});
