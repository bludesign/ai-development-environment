import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  decodePreparationContents,
  normalizePreparationPath,
  overallPreparationState,
  preparationContentSha256,
  preparationDefinitionHash,
  preparationPayload,
} from "./preparations";

describe("repository preparations", () => {
  test.each([
    "",
    "/absolute",
    "C:/absolute",
    "../secret",
    "config/../secret",
    "config//secret",
    ".git/config",
    ".GIT/config",
    "nested/.git/config",
    "config\\secret",
    "config/*.json",
    "config/[ab].json",
    "config/line\nfeed",
  ])("rejects non-exact POSIX path %j", (path) => {
    expect(() => normalizePreparationPath(path)).toThrow(
      "exact repository-relative file path",
    );
  });

  test("keeps an exact repository-relative path", () => {
    expect(normalizePreparationPath("config/local.json")).toBe(
      "config/local.json",
    );
  });

  test("validates base64 and limits an individual upload", () => {
    expect(decodePreparationContents("AAEC")).toEqual(Buffer.from([0, 1, 2]));
    expect(() => decodePreparationContents("not base64!")).toThrow(
      "not valid base64",
    );
    expect(() =>
      decodePreparationContents(
        Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      ),
    ).toThrow("10 MiB or smaller");
  });

  test("hashes binary content and every behavior-affecting definition field", () => {
    const contents = Buffer.from([0, 255, 4]);
    expect(preparationContentSha256(contents)).toBe(
      createHash("sha256").update(contents).digest("hex"),
    );
    expect(
      preparationDefinitionHash({ kind: "WRITE", path: "a", contents }),
    ).not.toBe(
      preparationDefinitionHash({ kind: "WRITE", path: "b", contents }),
    );
    expect(
      preparationDefinitionHash({ kind: "WRITE", path: "a", contents }),
    ).not.toBe(
      preparationDefinitionHash({ kind: "DELETE", path: "a", contents: null }),
    );
  });

  test("serializes binary definitions for agents without exposing bytes elsewhere", () => {
    expect(
      preparationPayload({
        id: "preparation-1",
        kind: "WRITE",
        path: "binary.dat",
        contents: Uint8Array.from([0, 255]),
        definitionHash: "definition",
      }),
    ).toEqual({
      id: "preparation-1",
      kind: "WRITE",
      path: "binary.dat",
      contentBase64: "AP8=",
      definitionHash: "definition",
    });
  });

  test("derives the most actionable overall state", () => {
    expect(overallPreparationState([])).toBe("NOT_CONFIGURED");
    expect(overallPreparationState(["APPLIED", "PENDING"])).toBe("PENDING");
    expect(overallPreparationState(["APPLIED", "DRIFTED"])).toBe("DRIFTED");
    expect(overallPreparationState(["NOT_APPLICABLE"])).toBe("NOT_APPLICABLE");
    expect(overallPreparationState(["NOT_APPLICABLE", "APPLIED"])).toBe(
      "APPLIED",
    );
  });
});
