import { describe, expect, test } from "vitest";

import {
  normalizeOperationOrigin,
  normalizeOperationResources,
  operationDescriptorsConflict,
  operationResourcesConflict,
  parseOperationDescriptor,
  sourceBranchResource,
  type OperationDescriptor,
  type OperationResource,
} from "./operation-resources.js";

const target = (
  key: string,
  mode: OperationResource["mode"] = "BUILD",
  codebaseId = "repository",
  agentId = "builder",
): OperationResource => ({
  kind: "WORKTREE",
  key: `${agentId}:${key}`,
  mode,
  agentId,
  codebaseId,
});
const path = (
  value: string,
  mode: OperationResource["mode"] = "WRITE",
  agentId = "builder",
): OperationResource => ({
  kind: "PATH",
  key: value,
  path: value,
  mode,
  agentId,
});
const descriptor = (
  ...resources: OperationResource[]
): OperationDescriptor => ({ version: 1, resources });

function expectConflict(
  a: OperationResource,
  b: OperationResource,
  expected: boolean,
) {
  expect(operationResourcesConflict(a, b)).toBe(expected);
  expect(operationResourcesConflict(b, a)).toBe(expected);
}

describe("operation resource conflict policy", () => {
  test.each([
    ["READ", "READ", false],
    ["READ", "BUILD", false],
    ["READ", "WRITE", true],
    ["BUILD", "BUILD", true],
    ["BUILD", "WRITE", true],
    ["WRITE", "WRITE", true],
  ] as const)(
    "applies same-worktree %s / %s compatibility",
    (a, b, conflict) => {
      expectConflict(target("feature", a), target("feature", b), conflict);
      expectConflict(target("feature", a), target("sibling", b), false);
    },
  );

  test("limits codebase barriers to that checkout and agent barriers to that machine", () => {
    const codebase: OperationResource = {
      kind: "CODEBASE",
      key: "builder:repository",
      mode: "WRITE",
      agentId: "builder",
      codebaseId: "repository",
    };
    const agent: OperationResource = {
      kind: "AGENT",
      key: "builder",
      mode: "WRITE",
      agentId: "builder",
    };
    expectConflict(codebase, target("feature"), true);
    expectConflict(
      codebase,
      target("other", "BUILD", "another-repository"),
      false,
    );
    expectConflict(
      codebase,
      target("feature", "BUILD", "repository", "another-builder"),
      false,
    );
    expectConflict(agent, target("other", "READ", "another-repository"), true);
    expectConflict(
      agent,
      target("other", "BUILD", "repository", "another-builder"),
      false,
    );
  });

  test("coordinates remote merge guards across clones while builds share branch intent", () => {
    const a = sourceBranchResource(
      "git@github.com:Example/App.git",
      "feature/CaseSensitive",
    );
    const b = sourceBranchResource(
      "https://github.com/example/app",
      "feature/CaseSensitive",
    );
    const merge = sourceBranchResource(
      "https://github.com/example/app.git",
      "feature/CaseSensitive",
      "WRITE",
    );
    expectConflict(a, b, false);
    expectConflict(a, merge, true);
    expectConflict(
      merge,
      sourceBranchResource("github.com/example/app", "feature/casesensitive"),
      false,
    );
    expectConflict(
      merge,
      sourceBranchResource("github.com/fork/app", "feature/CaseSensitive"),
      false,
    );
  });

  test.each([
    ["/cache/project", "/cache/project", true],
    ["/cache/project", "/cache/project/Build/Products", true],
    ["/cache/project", "/cache/project-other", false],
    ["/", "/cache/project", true],
    ["C:\\Cache\\PROJECT", "c:/cache/project/Products", true],
  ])(
    "checks overlapping paths at directory boundaries: %s and %s",
    (a, b, expected) => {
      expectConflict(path(String(a)), path(String(b)), Boolean(expected));
      expectConflict(
        path(String(a)),
        path(String(b), "WRITE", "another-builder"),
        false,
      );
    },
  );

  test("allows readers of separate artifacts and blocks shared writers and destinations", () => {
    expectConflict(
      path("/Artifacts/build", "READ"),
      path("/Artifacts/build/log", "READ"),
      false,
    );
    expectConflict(
      path("/Artifacts/build", "READ"),
      path("/Artifacts/build", "WRITE"),
      true,
    );
    const simulator: OperationResource = {
      kind: "DESTINATION",
      key: "builder:simulator",
      mode: "WRITE",
      agentId: "builder",
    };
    expectConflict(
      simulator,
      { ...simulator, codebaseId: "another-repository" },
      true,
    );
    expectConflict(
      simulator,
      { ...simulator, key: "builder:another-simulator" },
      false,
    );
    expect(
      operationDescriptorsConflict(
        descriptor(target("one"), simulator),
        descriptor(target("two"), simulator),
      ),
    ).toBe(true);
    expect(
      operationDescriptorsConflict(
        descriptor(target("one")),
        descriptor(target("two")),
      ),
    ).toBe(false);
  });
});

describe("operation resource normalization and validation", () => {
  test("deduplicates resource identities using their strongest requested mode and stable order", () => {
    const normalized = normalizeOperationResources([
      target("z", "READ"),
      target("a", "BUILD"),
      target("z", "WRITE"),
      target("a", "READ"),
    ]);
    expect(normalized.map(({ key, mode }) => [key, mode])).toEqual([
      ["builder:a", "BUILD"],
      ["builder:z", "WRITE"],
    ]);
    expect(
      parseOperationDescriptor({ version: 1, resources: normalized }),
    ).toEqual(descriptor(...normalized));
  });

  test.each([
    null,
    [],
    { version: 2, resources: [] },
    { version: 1, resources: null },
    { version: 1, resources: [null] },
    { version: 1, resources: [{ kind: "UNKNOWN", key: "a", mode: "WRITE" }] },
    { version: 1, resources: [{ kind: "WORKTREE", key: "", mode: "READ" }] },
    {
      version: 1,
      resources: [{ kind: "WORKTREE", key: "a", mode: "EXCLUSIVE" }],
    },
    {
      version: 1,
      resources: [{ kind: "PATH", key: "a", mode: "READ", path: 3 }],
    },
  ])("rejects malformed wire descriptors %#", (value) => {
    expect(() => parseOperationDescriptor(value)).toThrow();
  });

  test("preserves origin ports and distinguishes port-bearing hosts from path names", () => {
    expect(
      normalizeOperationOrigin("https://git.example.com:8443/group/repo.git"),
    ).toBe("git.example.com:8443/group/repo");
    expect(
      normalizeOperationOrigin("https://git.example.com:8443/group/repo.git"),
    ).not.toBe(
      normalizeOperationOrigin("https://git.example.com/8443/group/repo.git"),
    );
  });
});
