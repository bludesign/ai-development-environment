import { describe, expect, test } from "vitest";

import { WORKFLOW_STEP_CATALOG, WORKFLOW_TRIGGER_CATALOG } from "./definition";
import { SESSION_NAMESPACE_FIELDS, expandSessionPaths } from "./session-schema";

describe("expandSessionPaths", () => {
  test("expands a namespace wildcard into concrete described keys", () => {
    const result = expandSessionPaths(["ticket.*"]);
    const paths = result.map((info) => info.path);
    expect(paths).toContain("ticket.key");
    expect(paths).toContain("ticket.statusCategory");
    expect(paths).not.toContain("ticket.*");
    expect(
      result.find((info) => info.path === "ticket.key")?.description,
    ).toBeTruthy();
  });

  test("expands owning agent context exposed by resource triggers", () => {
    const paths = expandSessionPaths(["agent.*"]).map((info) => info.path);
    expect(paths).toEqual(
      expect.arrayContaining(["agent.id", "agent.name", "agent.hostname"]),
    );
  });

  test("expands an id-qualified wildcard prefix", () => {
    const paths = expandSessionPaths(["steps.load.*"]).map((info) => info.path);
    expect(paths).toContain("steps.load.output");
    expect(paths).toContain("steps.load.status");
  });

  test("keeps unknown-namespace wildcards verbatim", () => {
    expect(expandSessionPaths(["mystery.*"]).map((info) => info.path)).toEqual([
      "mystery.*",
    ]);
  });

  test("passes concrete paths through and attaches known descriptions", () => {
    const [info] = expandSessionPaths(["ticket.key"]);
    expect(info?.path).toBe("ticket.key");
    expect(info?.description).toBeTruthy();
  });

  test("de-duplicates and sorts by path", () => {
    const paths = expandSessionPaths([
      "ticket.*",
      "ticket.key",
      "pr.number",
    ]).map((info) => info.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("ignores blanks and bare wildcards", () => {
    expect(expandSessionPaths(["", "  ", "*"])).toEqual([]);
  });
});

describe("schema stays in sync with the catalog", () => {
  test("every concrete catalog path is represented in the schema", () => {
    const known = new Set(
      Object.entries(SESSION_NAMESPACE_FIELDS).flatMap(([namespace, fields]) =>
        fields.map((field) => `${namespace}.${field.name}`),
      ),
    );
    const concrete = new Set<string>();
    const collect = (path: string) => {
      if (path.includes("<stepId>") || path.endsWith(".*") || path === "*")
        return;
      concrete.add(path);
    };
    for (const entry of WORKFLOW_STEP_CATALOG)
      for (const path of [...entry.requiredPaths, ...entry.providedPaths])
        collect(path);
    for (const entry of WORKFLOW_TRIGGER_CATALOG)
      for (const path of entry.seedPaths) collect(path);

    const missing = [...concrete].filter((path) => !known.has(path));
    expect(missing).toEqual([]);
  });
});
