import { expect, test } from "vitest";

import { validateTransferReferences } from "./integrity";
import {
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  type TransferPackage,
  type TransferReference,
} from "./package";

function packageWithNode(
  kind: string,
  config: Record<string, unknown>,
  references: TransferReference[] = [],
): TransferPackage {
  return {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    scope: "REPOSITORY",
    rootKey: "repo",
    entities: [
      {
        key: "repo",
        kind: "REPOSITORY",
        name: "Repo",
        dependency: false,
        fields: {},
        references: [],
      },
      {
        key: "workflow",
        kind: "WORKFLOW",
        name: "Workflow",
        dependency: false,
        fields: { draftDefinition: { nodes: [{ kind, config }] } },
        references,
      },
    ],
  };
}
const ref = (
  kind: string,
  field: string,
  extra: Partial<TransferReference> = {},
): TransferReference => ({
  key: "reference",
  kind,
  label: field,
  path: ["draftDefinition", "nodes", 0, "config", field],
  identity: {},
  ...extra,
});

test("static resource references require the correct declared kind and path", () => {
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", { configurationId: "source-id" }),
    ),
  ).toThrow(/missing portable reference/);
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", { configurationId: null }, [
        ref("AGENT", "configurationId"),
      ]),
    ),
  ).toThrow(/unsupported reference/);
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", { configurationId: null }, [
        ref("BUILD_CONFIGURATION", "configurationId"),
      ]),
    ),
  ).not.toThrow();
});

test("reference metadata cannot replace authored scripts or graph fields", () => {
  expect(() =>
    validateTransferReferences(
      packageWithNode("TERMINAL_RUN", { script: "echo keep-me" }, [
        ref("AGENT", "script"),
      ]),
    ),
  ).toThrow(/unsupported reference/);
  expect(() =>
    validateTransferReferences(
      packageWithNode(
        "CONTROL_SET_VARIABLE",
        { value: { repositoryId: "authored" } },
        [
          ref("REPOSITORY", "value", {
            path: [
              "draftDefinition",
              "nodes",
              0,
              "config",
              "value",
              "repositoryId",
            ],
          }),
        ],
      ),
    ),
  ).toThrow(/unsupported reference/);
});

test("runtime bindings remain untouched while wrapped literals require an exact value path", () => {
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", {
        configurationId: { source: "SESSION", path: "build.configurationId" },
        worktreeId: "{{worktree.id}}",
      }),
    ),
  ).not.toThrow();
  const payload = packageWithNode(
    "BUILD_START",
    {
      configurationId: { source: "LITERAL", value: null },
    },
    [
      ref("BUILD_CONFIGURATION", "configurationId", {
        path: [
          "draftDefinition",
          "nodes",
          0,
          "config",
          "configurationId",
          "value",
        ],
      }),
    ],
  );
  expect(() => validateTransferReferences(payload)).not.toThrow();
  expect(payload.entities[1]?.fields).toMatchObject({
    draftDefinition: {
      nodes: [
        { config: { configurationId: { source: "LITERAL", value: null } } },
      ],
    },
  });
});

test("present bundled targets must match resource kind but excluded dependencies can still be mapped", () => {
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", { configurationId: null }, [
        ref("BUILD_CONFIGURATION", "configurationId", { entityKey: "repo" }),
      ]),
    ),
  ).toThrow(/wrong resource kind/);
  expect(() =>
    validateTransferReferences(
      packageWithNode("BUILD_START", { configurationId: null }, [
        ref("BUILD_CONFIGURATION", "configurationId", {
          entityKey: "excluded-config",
        }),
      ]),
    ),
  ).not.toThrow();
});

test("portable reference keys are unique across entities", () => {
  const payload = packageWithNode("BUILD_START", { configurationId: null }, [
    ref("BUILD_CONFIGURATION", "configurationId"),
  ]);
  payload.entities.push({
    ...structuredClone(payload.entities[1]!),
    key: "second-workflow",
  });
  expect(() => validateTransferReferences(payload)).toThrow(
    /Duplicate package reference key/,
  );
});

test("reference paths cannot create new properties or expand sparse arrays", () => {
  const payload = packageWithNode("BUILD_START", { configurationId: null }, [
    ref("BUILD_CONFIGURATION", "configurationId", {
      path: ["repositoryIds", 4294967294],
    }),
  ]);
  payload.entities[1]!.fields.repositoryIds = [null];
  expect(() => validateTransferReferences(payload)).toThrow(
    /reference path does not exist/,
  );
  expect(payload.entities[1]!.fields.repositoryIds).toEqual([null]);
});
