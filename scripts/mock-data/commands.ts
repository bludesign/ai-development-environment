import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, minutesAgo } from "./time";

const BASE = "/Users/acme/Repositories";

const TARGETS = {
  webMain: {
    worktreeId: ids.worktrees.webMain,
    worktreePath: `${BASE}/web-app`,
    worktreeBranch: "main",
  },
  webFeature: {
    worktreeId: ids.worktrees.webFeature,
    worktreePath: `${BASE}/web-app-quick-search`,
    worktreeBranch: "feature/quick-search",
  },
  iosMain: {
    worktreeId: ids.worktrees.iosMain,
    worktreePath: `${BASE}/ios-app`,
    worktreeBranch: "main",
  },
  apiFeature: {
    worktreeId: ids.worktrees.apiFeature,
    worktreePath: `${BASE}/api-feature-auth`,
    worktreeBranch: "feature/oauth-device-flow",
  },
} as const;

const AGENTS = {
  studio: { agentId: ids.agents.studio, agentName: "Studio Mac", agentHostname: "studio-mac.local" },
  build: { agentId: ids.agents.build, agentName: "Build Mac", agentHostname: "build-mac.local" },
} as const;

const DEFINITIONS = {
  runTests: {
    commandId: ids.commands.runTests,
    snapshotName: "Run Tests",
    snapshotDescription: "Runs the full test suite in the selected worktree.",
    snapshotScript: "npm test",
    snapshotTargetKind: "REPOSITORY_WORKTREE",
    snapshotRestartPolicy: "ON_FAILURE",
    snapshotRestartLimit: 2,
  },
  deployStaging: {
    commandId: ids.commands.deployStaging,
    snapshotName: "Deploy to Staging",
    snapshotDescription: "Builds and deploys the API to the staging environment.",
    snapshotScript: "./scripts/deploy.sh staging",
    snapshotTargetKind: "SPECIFIC_AGENT_HOME",
    snapshotRestartPolicy: "NEVER",
    snapshotRestartLimit: null,
  },
} as const;

/**
 * History behind the #3001 run the `command-run` screenshot route opens. Ages are minutes
 * before `NOW` so the list spans several day groups, and `displayNumber` counts down from
 * 3000 to keep #3001 the newest run and the number sequence (3002) untouched.
 *
 * Every run is terminal on purpose. A seeded QUEUED or RUNNING run gets reconciled the moment
 * the server starts — no agent is connected to claim it, so the command service fails it and
 * raises a "command failed" notification that then appears in every captured screenshot.
 */
const HISTORY: Array<{
  definition: keyof typeof DEFINITIONS;
  agent: keyof typeof AGENTS;
  target: keyof typeof TARGETS;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  minutesAge: number;
  durationMinutes: number;
  exitCode?: number;
  error?: string;
  /** Must be a CommandRunOrigin member (schemas/commands.graphql) or the whole query errors. */
  origin?: "MANUAL" | "QUICK_ACTION" | "WORKFLOW" | "RERUN";
  restartCount?: number;
}> = [
  { definition: "runTests", agent: "studio", target: "webFeature", status: "SUCCEEDED", minutesAge: 16, durationMinutes: 2, exitCode: 0 },
  { definition: "deployStaging", agent: "build", target: "iosMain", status: "SUCCEEDED", minutesAge: 24, durationMinutes: 5, exitCode: 0 },
  { definition: "runTests", agent: "studio", target: "apiFeature", status: "SUCCEEDED", minutesAge: 42, durationMinutes: 2, exitCode: 0, origin: "QUICK_ACTION" },
  { definition: "runTests", agent: "build", target: "iosMain", status: "FAILED", minutesAge: 96, durationMinutes: 4, exitCode: 1, error: "Test Suites: 2 failed, 40 passed, 42 total" },
  { definition: "runTests", agent: "build", target: "iosMain", status: "SUCCEEDED", minutesAge: 108, durationMinutes: 3, exitCode: 0, origin: "RERUN", restartCount: 1 },
  { definition: "deployStaging", agent: "studio", target: "webMain", status: "SUCCEEDED", minutesAge: 180, durationMinutes: 6, exitCode: 0 },
  { definition: "runTests", agent: "studio", target: "webMain", status: "CANCELLED", minutesAge: 240, durationMinutes: 1, error: "Cancelled by operator" },
  { definition: "runTests", agent: "studio", target: "webFeature", status: "SUCCEEDED", minutesAge: 305, durationMinutes: 2, exitCode: 0 },
  { definition: "runTests", agent: "build", target: "iosMain", status: "SUCCEEDED", minutesAge: 420, durationMinutes: 5, exitCode: 0, origin: "QUICK_ACTION" },
  { definition: "deployStaging", agent: "studio", target: "apiFeature", status: "FAILED", minutesAge: 1_500, durationMinutes: 2, exitCode: 2, error: "Staging health check timed out after 120s" },
  { definition: "runTests", agent: "studio", target: "apiFeature", status: "SUCCEEDED", minutesAge: 1_560, durationMinutes: 3, exitCode: 0 },
  { definition: "runTests", agent: "studio", target: "webMain", status: "SUCCEEDED", minutesAge: 1_680, durationMinutes: 2, exitCode: 0 },
  { definition: "runTests", agent: "build", target: "iosMain", status: "FAILED", minutesAge: 1_805, durationMinutes: 7, exitCode: 65, error: "xcodebuild exited with code 65" },
  { definition: "deployStaging", agent: "studio", target: "webMain", status: "SUCCEEDED", minutesAge: 2_940, durationMinutes: 5, exitCode: 0 },
  { definition: "runTests", agent: "studio", target: "webFeature", status: "SUCCEEDED", minutesAge: 3_015, durationMinutes: 2, exitCode: 0, origin: "QUICK_ACTION" },
  { definition: "runTests", agent: "studio", target: "webMain", status: "CANCELLED", minutesAge: 3_120, durationMinutes: 1, error: "Superseded by a newer run" },
  { definition: "runTests", agent: "build", target: "iosMain", status: "SUCCEEDED", minutesAge: 4_380, durationMinutes: 4, exitCode: 0 },
  { definition: "deployStaging", agent: "studio", target: "apiFeature", status: "SUCCEEDED", minutesAge: 4_500, durationMinutes: 6, exitCode: 0 },
  { definition: "runTests", agent: "studio", target: "apiFeature", status: "SUCCEEDED", minutesAge: 5_760, durationMinutes: 3, exitCode: 0 },
];

export async function seedCommands(prisma: PrismaClient): Promise<void> {
  await prisma.commandDefinition.create({
    data: {
      id: ids.commands.runTests,
      name: "Run Tests",
      description: "Runs the full test suite in the selected worktree.",
      script: "npm test",
      targetKind: "REPOSITORY_WORKTREE",
      targetRepositoryId: ids.repositories.web,
      restartPolicy: "ON_FAILURE",
      restartLimit: 2,
      quickActionEnabled: true,
      quickActionIconKey: "test-tube",
      notificationsEnabled: true,
      createdAt: daysAgo(25),
    },
  });

  await prisma.commandDefinition.create({
    data: {
      id: ids.commands.deployStaging,
      name: "Deploy to Staging",
      description: "Builds and deploys the API to the staging environment.",
      script: "./scripts/deploy.sh staging",
      targetKind: "SPECIFIC_AGENT_HOME",
      targetAgentId: ids.agents.studio,
      restartPolicy: "NEVER",
      quickActionEnabled: false,
      quickActionIconKey: "rocket",
      notificationsEnabled: true,
      createdAt: daysAgo(18),
    },
  });

  await prisma.commandRunNumberSequence.create({
    data: { id: "default", nextValue: displayNumbers.commandRuns.latest + 1 },
  });

  await prisma.commandRun.create({
    data: {
      id: ids.commandRuns.latest,
      displayNumber: displayNumbers.commandRuns.latest,
      commandId: ids.commands.runTests,
      idempotencyKey: "command-run-latest-key",
      origin: "MANUAL",
      status: "SUCCEEDED",
      snapshotName: "Run Tests",
      snapshotDescription: "Runs the full test suite in the selected worktree.",
      snapshotScript: "npm test",
      snapshotTargetKind: "REPOSITORY_WORKTREE",
      snapshotRestartPolicy: "ON_FAILURE",
      snapshotRestartLimit: 2,
      snapshotNotificationsEnabled: true,
      agentId: ids.agents.studio,
      worktreeId: ids.worktrees.webMain,
      agentName: "Studio Mac",
      agentHostname: "studio-mac.local",
      worktreePath: "/Users/acme/Repositories/web-app",
      worktreeBranch: "main",
      exitCode: 0,
      queuedAt: minutesAgo(12),
      startedAt: minutesAgo(12),
      finishedAt: minutesAgo(11),
      createdAt: minutesAgo(12),
      attempts: {
        create: [
          {
            id: "command-run-attempt-1",
            attempt: 1,
            status: "SUCCEEDED",
            exitCode: 0,
            startedAt: minutesAgo(12),
            finishedAt: minutesAgo(11),
            outputChunks: {
              create: [
                {
                  id: "command-output-1",
                  sequence: 1,
                  stream: "STDOUT",
                  dataBase64: Buffer.from("> npm test\n").toString("base64"),
                  byteLength: 11,
                },
                {
                  id: "command-output-2",
                  sequence: 2,
                  stream: "STDOUT",
                  dataBase64: Buffer.from(
                    "Test Suites: 42 passed, 42 total\n",
                  ).toString("base64"),
                  byteLength: 33,
                },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.commandRun.createMany({
    data: HISTORY.map((entry, index) => {
      const definition = DEFINITIONS[entry.definition];
      const queuedAt = minutesAgo(entry.minutesAge);
      const finishedAt = minutesAgo(entry.minutesAge - entry.durationMinutes);
      return {
        id: `command-run-history-${index + 1}`,
        displayNumber: displayNumbers.commandRuns.latest - 1 - index,
        idempotencyKey: `command-run-history-${index + 1}-key`,
        origin: entry.origin ?? "MANUAL",
        status: entry.status,
        ...definition,
        snapshotNotificationsEnabled: true,
        ...AGENTS[entry.agent],
        ...TARGETS[entry.target],
        restartCount: entry.restartCount ?? 0,
        exitCode: entry.exitCode ?? null,
        error: entry.error ?? null,
        queuedAt,
        startedAt: queuedAt,
        finishedAt,
        createdAt: queuedAt,
      };
    }),
  });

  // One attempt per history run so the run detail pages have output to render.
  await prisma.commandRunAttempt.createMany({
    data: HISTORY.map((entry, index) => ({
      id: `command-run-history-${index + 1}-attempt-1`,
      runId: `command-run-history-${index + 1}`,
      attempt: 1,
      status: entry.status,
      exitCode: entry.exitCode ?? null,
      error: entry.error ?? null,
      startedAt: minutesAgo(entry.minutesAge),
      finishedAt: minutesAgo(entry.minutesAge - entry.durationMinutes),
    })),
  });

  await prisma.commandRunOutputChunk.createMany({
    data: HISTORY.flatMap((entry, index) => {
      const definition = DEFINITIONS[entry.definition];
      const lines = [
        `> ${definition.snapshotScript}\n`,
        entry.status === "SUCCEEDED"
          ? "Completed successfully.\n"
          : `${entry.error ?? "Command did not complete."}\n`,
      ];
      return lines.map((line, lineIndex) => ({
        id: `command-run-history-${index + 1}-output-${lineIndex + 1}`,
        attemptId: `command-run-history-${index + 1}-attempt-1`,
        sequence: lineIndex + 1,
        stream: entry.status === "SUCCEEDED" ? "STDOUT" : "STDERR",
        dataBase64: Buffer.from(line).toString("base64"),
        byteLength: Buffer.byteLength(line),
      }));
    }),
  });
}
