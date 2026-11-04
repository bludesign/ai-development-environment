import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo } from "./time";

export const sessionSubagentLabels = [
  "Build the command palette",
  "Add keyboard navigation",
  "Review the search API contract",
  "Verify search tests",
] as const;

const tasks = [
  {
    agentType: "general-purpose",
    prompt:
      "Build the command palette with grouped results and an empty state.",
    tool: "Read",
    input: {
      file_path:
        "/Users/acme/Repositories/web-app/src/components/quick-search.tsx",
    },
    output:
      "QuickSearch renders grouped results, loading feedback, and a helpful empty state.",
    summary:
      "Added grouped results, loading feedback, and an empty state to the command palette.",
  },
  {
    agentType: "general-purpose",
    prompt:
      "Add arrow-key navigation, Enter to open a result, and Escape to close.",
    tool: "Bash",
    input: { command: "npm test -- quick-search.keyboard.test.tsx" },
    output: "PASS quick-search.keyboard.test.tsx\n8 tests passed",
    summary:
      "Arrow keys, Enter, and Escape work correctly. All eight keyboard tests pass.",
  },
  {
    agentType: "Explore",
    prompt:
      "Review the search response shape and confirm the palette handles every result kind.",
    tool: "Read",
    input: {
      file_path: "/Users/acme/Repositories/web-app/src/app/api/search/route.ts",
    },
    output:
      "Search returns typed results for codebases, worktrees, tickets, and pull requests.",
    summary:
      "Confirmed every search result kind has a label, destination, and stable identifier.",
  },
  {
    agentType: "test-writer",
    prompt: "Run the search tests and check loading, empty, and error states.",
    tool: "Bash",
    input: { command: "npm test -- quick-search" },
    output: "Test Files 3 passed (3)\nTests 24 passed (24)",
    summary:
      "All 24 search tests pass, including loading, empty results, and API errors.",
  },
] as const;

/** Complete child histories for the Claude session used by the documentation captures. */
export async function seedRunSubagents(prisma: PrismaClient): Promise<void> {
  const started = daysAgo(4).getTime();
  await prisma.agentRun.update({
    where: { id: ids.runs.sessionSearch },
    data: {
      finishedAt: new Date(started + 60_000),
      updatedAt: new Date(started + 60_000),
    },
  });
  for (const [index, task] of tasks.entries()) {
    const id = `subagent-session-search-${index + 1}`;
    const nativeId = `a0b1c2d3e4f5${String(index + 1).padStart(5, "0")}`;
    const toolUseId = `toolu_spawn_search_${index + 1}`;
    const toolCallId = `toolu_search_${index + 1}`;
    const startedAt = new Date(started + 15_000 + index * 2_000);
    const finishedAt = new Date(started + 40_000 + index * 3_000);
    const messages = [
      { role: "user", content: task.prompt },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: task.tool,
            input: task.input,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: task.output,
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: task.summary }],
        stop_reason: "end_turn",
      },
    ];
    await prisma.runSubagent.create({
      data: {
        id,
        runId: ids.runs.sessionSearch,
        attemptId: "attempt-session-search-1",
        nativeId,
        nativeRunId: `0mocksearch-${index + 1}`,
        toolUseId,
        label: sessionSubagentLabels[index]!,
        agentType: task.agentType,
        status: "COMPLETED",
        prompt: task.prompt,
        finalOutput: task.summary,
        startedAt,
        finishedAt,
        transcriptStatus: "AVAILABLE",
        createdAt: startedAt,
        updatedAt: finishedAt,
        messages: {
          create: messages.map((message, sequence) => {
            const nativeMessageId = `4e233c42-67ac-4ee9-9e4e-${String(index * 4 + sequence + 1).padStart(12, "0")}`;
            const createdAt =
              sequence === 3
                ? finishedAt
                : new Date(startedAt.getTime() + sequence * 4_000);
            return {
              id: `${id}-message-${sequence}`,
              nativeId: nativeMessageId,
              sequence,
              createdAt,
              rawJson: JSON.stringify({
                type: message.role,
                uuid: nativeMessageId,
                session_id: "claude-session-def456",
                agent_id: nativeId,
                parent_tool_use_id: toolUseId,
                timestamp: createdAt.toISOString(),
                message,
              }),
            };
          }),
        },
      },
    });
  }
}
