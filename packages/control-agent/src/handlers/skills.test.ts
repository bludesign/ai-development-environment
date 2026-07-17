import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  hashSkillFiles,
  type SkillPackageFile,
} from "@ai-development-environment/agent-contract/skills";

import { applySkills } from "./skills.js";

const executeFile = promisify(execFile);
const folders: string[] = [];
const signal = new AbortController().signal;
const log = async () => undefined;

async function repository() {
  const folder = await mkdtemp(join(tmpdir(), "skill-handler-"));
  folders.push(folder);
  await executeFile("git", ["init", folder]);
  return folder;
}

function files(): SkillPackageFile[] {
  return [
    {
      path: "SKILL.md",
      contentsBase64: Buffer.from(
        "---\nname: swift-review\ndescription: Review Swift code safely.\n---\n",
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

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("skill apply handler", () => {
  test("atomically writes a package and manages the local Git exclude block", async () => {
    const folder = await repository();
    const packageFiles = files();
    const result = await applySkills(
      {
        operations: [
          {
            kind: "WRITE",
            scope: "PROJECT",
            rootKind: "AGENTS",
            folder,
            package: {
              name: "swift-review",
              description: "Review Swift code safely.",
              packageHash: hashSkillFiles(packageFiles),
              files: packageFiles,
            },
            manageGitExclude: true,
          },
        ],
      },
      30_000,
      signal,
      log,
    );
    expect(result.exitCode).toBe(0);
    expect(
      await readFile(
        join(folder, ".agents", "skills", "swift-review", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: swift-review");
    expect(
      (
        await stat(
          join(
            folder,
            ".agents",
            "skills",
            "swift-review",
            "scripts",
            "check.sh",
          ),
        )
      ).mode & 0o111,
    ).not.toBe(0);
    expect(
      await readFile(join(folder, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.agents/skills/swift-review/");
  });

  test("refuses to overwrite a tracked project skill", async () => {
    const folder = await repository();
    const packageFiles = files();
    await applySkills(
      {
        operations: [
          {
            kind: "WRITE",
            scope: "PROJECT",
            rootKind: "AGENTS",
            folder,
            package: {
              name: "swift-review",
              description: "Review Swift code safely.",
              packageHash: hashSkillFiles(packageFiles),
              files: packageFiles,
            },
            manageGitExclude: false,
          },
        ],
      },
      30_000,
      signal,
      log,
    );
    await executeFile("git", [
      "-C",
      folder,
      "add",
      "-f",
      ".agents/skills/swift-review/SKILL.md",
    ]);
    await expect(
      applySkills(
        {
          operations: [
            {
              kind: "DELETE",
              scope: "PROJECT",
              rootKind: "AGENTS",
              folder,
              skillName: "swift-review",
              manageGitExclude: true,
            },
          ],
        },
        30_000,
        signal,
        log,
      ),
    ).rejects.toThrow(/tracked by Git/);
  });
});
