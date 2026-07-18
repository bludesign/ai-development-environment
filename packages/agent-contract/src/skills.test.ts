import { describe, expect, test } from "vitest";

import {
  hashSkillFiles,
  parseSkillMetadata,
  parseSkillPackage,
  validateSkillRelativePath,
  type SkillPackageFile,
} from "./skills";

function packageFiles(): SkillPackageFile[] {
  return [
    {
      path: "SKILL.md",
      contentsBase64: Buffer.from(
        "---\nname: swift-review\ndescription: Review Swift code safely.\n---\n\n# Swift review\n",
      ).toString("base64"),
      executable: false,
    },
    {
      path: "scripts/check.sh",
      contentsBase64: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"),
      executable: true,
    },
  ];
}

describe("skill package contract", () => {
  test("parses metadata and produces a stable package hash", () => {
    const files = packageFiles();
    const hash = hashSkillFiles(files);
    expect(hash).toBe(hashSkillFiles([...files].reverse()));
    expect(
      parseSkillMetadata(
        Buffer.from(files[0]!.contentsBase64, "base64").toString(),
      ),
    ).toEqual({
      name: "swift-review",
      description: "Review Swift code safely.",
    });
    expect(
      parseSkillPackage({
        name: "swift-review",
        description: "Review Swift code safely.",
        packageHash: hash,
        files,
      }),
    ).toMatchObject({ name: "swift-review", packageHash: hash });
  });

  test("rejects traversal and mismatched frontmatter", () => {
    expect(() => validateSkillRelativePath("../secret")).toThrow(/within/);
    const files = packageFiles();
    expect(() =>
      parseSkillPackage({
        name: "different-name",
        description: "Review Swift code safely.",
        packageHash: hashSkillFiles(files),
        files,
      }),
    ).toThrow(/frontmatter/);
  });
});
