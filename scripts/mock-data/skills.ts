import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo } from "./time";

function skillFile(body: string) {
  return Buffer.from(body, "utf8");
}

/**
 * The rest of the catalog. These carry one SKILL.md apiece and no installations of their own —
 * enough to fill the Skills table without changing what the sync and installation panels show.
 */
const MORE_SKILLS = [
  {
    id: ids.skills.review,
    name: "code-reviewer",
    title: "Code Reviewer",
    description: "Reviews diffs for correctness, security, and performance.",
    instruction: "Read the diff, flag defects, and suggest concrete fixes.",
    syncGlobally: true,
    createdDaysAgo: 36,
  },
  {
    id: ids.skills.migrations,
    name: "migration-planner",
    title: "Migration Planner",
    description: "Plans and reviews database schema migrations.",
    instruction: "Check every migration for backfills and rollback safety.",
    syncGlobally: true,
    createdDaysAgo: 33,
  },
  {
    id: ids.skills.release,
    name: "release-notes",
    title: "Release Notes",
    description: "Drafts release notes from merged pull requests.",
    instruction: "Group merged PRs by area and summarize user-visible changes.",
    syncGlobally: false,
    createdDaysAgo: 29,
  },
  {
    id: ids.skills.triage,
    name: "bug-triage",
    title: "Bug Triage",
    description: "Reproduces reported bugs and proposes a severity.",
    instruction:
      "Reproduce the report, isolate the cause, then assign severity.",
    syncGlobally: true,
    createdDaysAgo: 26,
  },
  {
    id: ids.skills.perf,
    name: "perf-profiler",
    title: "Performance Profiler",
    description: "Profiles hot paths and reports regressions with traces.",
    instruction: "Measure before and after, and attach traces to every claim.",
    syncGlobally: false,
    createdDaysAgo: 22,
  },
  {
    id: ids.skills.a11y,
    name: "accessibility-audit",
    title: "Accessibility Audit",
    description: "Audits screens against WCAG 2.2 AA and files findings.",
    instruction: "Check contrast, focus order, and labels on every new screen.",
    syncGlobally: true,
    createdDaysAgo: 17,
  },
  {
    id: ids.skills.apiDocs,
    name: "api-contract",
    title: "API Contract",
    description: "Keeps GraphQL and REST contracts in step with the code.",
    instruction: "Diff the schema against the resolvers and flag drift.",
    syncGlobally: false,
    createdDaysAgo: 11,
  },
];

export async function seedSkills(prisma: PrismaClient): Promise<void> {
  await prisma.skill.create({
    data: {
      id: ids.skills.lint,
      name: "lint-guardrails",
      description: "Runs project linters and reports actionable fixes.",
      syncGlobally: true,
      packageHash: "sha256-lint-guardrails-0001",
      createdAt: daysAgo(40),
      files: {
        create: [
          {
            id: "skill-file-lint-md",
            path: "SKILL.md",
            contents: skillFile(
              "# Lint Guardrails\n\nRun `npm run lint` and summarize violations.",
            ),
            contentHash: "sha256-lint-md-0001",
          },
        ],
      },
    },
  });

  await prisma.skill.create({
    data: {
      id: ids.skills.docs,
      name: "doc-writer",
      description: "Generates and updates documentation from code changes.",
      syncGlobally: true,
      packageHash: "sha256-doc-writer-0001",
      createdAt: daysAgo(38),
      files: {
        create: [
          {
            id: "skill-file-docs-md",
            path: "SKILL.md",
            contents: skillFile(
              "# Doc Writer\n\nKeep README and API docs current.",
            ),
            contentHash: "sha256-docs-md-0001",
          },
        ],
      },
    },
  });

  await prisma.skill.create({
    data: {
      id: ids.skills.tests,
      name: "test-author",
      description: "Writes unit and integration tests for new code.",
      syncGlobally: false,
      packageHash: "sha256-test-author-0001",
      createdAt: daysAgo(20),
      files: {
        create: [
          {
            id: "skill-file-tests-md",
            path: "SKILL.md",
            contents: skillFile(
              "# Test Author\n\nCreate focused, deterministic tests.",
            ),
            contentHash: "sha256-tests-md-0001",
          },
        ],
      },
    },
  });

  for (const skill of MORE_SKILLS) {
    await prisma.skill.create({
      data: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        syncGlobally: skill.syncGlobally,
        packageHash: `sha256-${skill.name}-0001`,
        createdAt: daysAgo(skill.createdDaysAgo),
        files: {
          create: [
            {
              id: `skill-file-${skill.name}-md`,
              path: "SKILL.md",
              contents: skillFile(`# ${skill.title}\n\n${skill.instruction}`),
              contentHash: `sha256-${skill.name}-md-0001`,
            },
          ],
        },
      },
    });
  }

  await prisma.skillGroup.create({
    data: {
      id: ids.skillGroups.core,
      name: "Core Engineering",
      createdAt: daysAgo(40),
      skills: {
        create: [
          { skillId: ids.skills.lint },
          { skillId: ids.skills.docs },
          { skillId: ids.skills.tests },
          ...MORE_SKILLS.map((skill) => ({ skillId: skill.id })),
        ],
      },
      repositories: {
        create: [{ repositoryId: ids.repositories.web }],
      },
    },
  });

  await prisma.skillInstallation.createMany({
    data: [
      {
        id: "skill-install-lint-studio",
        skillId: ids.skills.lint,
        agentId: ids.agents.studio,
        scope: "GLOBAL",
        rootKind: "CLAUDE",
        rootPath: "/Users/acme/.claude/skills",
        skillName: "lint-guardrails",
        description: "Runs project linters and reports actionable fixes.",
        packageHash: "sha256-lint-guardrails-0001",
        present: true,
        fileCount: 1,
        totalBytes: 640,
        tracked: true,
        lastSeenAt: hoursAgo(1),
      },
      {
        id: "skill-install-docs-studio",
        skillId: ids.skills.docs,
        agentId: ids.agents.studio,
        codebaseId: ids.codebases.web,
        scope: "PROJECT",
        rootKind: "CLAUDE",
        rootPath: "/Users/acme/Repositories/web-app/.claude/skills",
        skillName: "doc-writer",
        description: "Generates and updates documentation from code changes.",
        packageHash: "sha256-doc-writer-0001",
        present: true,
        fileCount: 1,
        totalBytes: 512,
        tracked: true,
        lastSeenAt: hoursAgo(2),
      },
    ],
  });

  await prisma.skillDeployment.createMany({
    data: [
      {
        id: "skill-deploy-lint-studio",
        skillId: ids.skills.lint,
        agentId: ids.agents.studio,
        scope: "GLOBAL",
        rootKind: "CLAUDE",
        targetPath: "/Users/acme/.claude/skills/lint-guardrails",
        desiredHash: "sha256-lint-guardrails-0001",
        installedHash: "sha256-lint-guardrails-0001",
        status: "SYNCED",
      },
    ],
  });

  await prisma.skillToolObservation.createMany({
    data: [
      {
        agentId: ids.agents.studio,
        tool: "CLAUDE",
        configured: true,
        homePath: "/Users/acme/.claude",
        checkedAt: hoursAgo(1),
      },
      {
        agentId: ids.agents.studio,
        tool: "CODEX",
        configured: true,
        homePath: "/Users/acme/.codex",
        checkedAt: hoursAgo(1),
      },
      {
        agentId: ids.agents.studio,
        tool: "CURSOR",
        configured: false,
        homePath: "/Users/acme/.cursor",
        checkedAt: hoursAgo(1),
      },
    ],
  });

  await prisma.skillSyncRun.create({
    data: {
      id: ids.skillSyncRuns.latest,
      kind: "GROUP",
      groupId: ids.skillGroups.core,
      automatic: true,
      status: "COMPLETED",
      createdAt: hoursAgo(2),
      finishedAt: hoursAgo(2),
      items: {
        create: [
          {
            id: "skill-sync-item-1",
            skillId: ids.skills.lint,
            agentId: ids.agents.studio,
            direction: "PUSH",
            status: "SYNCED",
            sourceHash: "sha256-lint-guardrails-0001",
            targetHash: "sha256-lint-guardrails-0001",
          },
          {
            id: "skill-sync-item-2",
            skillId: ids.skills.docs,
            agentId: ids.agents.studio,
            direction: "PUSH",
            status: "SKIPPED",
            resolution: "UP_TO_DATE",
          },
        ],
      },
    },
  });
}
