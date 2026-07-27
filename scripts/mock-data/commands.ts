import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, minutesAgo } from "./time";

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
}
