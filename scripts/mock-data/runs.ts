import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

export async function seedRuns(prisma: PrismaClient): Promise<void> {
  // Plan that was played into a session.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planSearch,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planSearch,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      jiraIssueKey: ids.jira.issueKey,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: true,
      initialPrompt:
        "Design a quick-search feature for the global navigation bar. Outline the component structure, data fetching, and keyboard shortcuts.",
      finalOutput:
        "## Quick Search Plan\n\n1. Add a `QuickSearch` command palette triggered by ⌘K.\n2. Debounce queries and call the `/api/search` endpoint.\n3. Surface recent items and keyboard navigation.\n\nReady to implement.",
      estimatedCost: 0.42,
      pricingSource: "catalog",
      pricingUpdatedAt: hoursAgo(6),
      inputTokens: 48210,
      outputTokens: 6120,
      reasoningTokens: 3040,
      cacheReadTokens: 18400,
      cacheWriteTokens: 5200,
      toolCallCount: 4,
      playedAt: daysAgo(4),
      playedSessionNumber: displayNumbers.runs.sessionSearch,
      startedAt: daysAgo(5),
      finishedAt: daysAgo(5),
      createdAt: daysAgo(5),
      attempts: {
        create: [
          {
            id: "attempt-plan-search-1",
            generation: 1,
            nativeId: "claude-plan-abc123",
            status: "COMPLETED",
            startedAt: daysAgo(5),
            finishedAt: daysAgo(5),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-plan-search-1",
            sequence: 1,
            kind: "INITIAL",
            prompt:
              "Design a quick-search feature for the global navigation bar.",
            createdAt: daysAgo(5),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-plan-search-1",
            sequence: 1,
            type: "REASONING",
            summary: "Analyzing existing navigation components",
            searchText: "analyzing existing navigation components",
            detailMarkdown:
              "Reviewed `NavigationBar` and existing search endpoints to plan the palette.",
            createdAt: daysAgo(5),
          },
          {
            id: "event-plan-search-2",
            sequence: 2,
            type: "MESSAGE",
            summary: "Proposed the quick-search plan",
            searchText: "proposed the quick-search plan",
            detailMarkdown: "Outlined a ⌘K command palette with debounced search.",
            createdAt: daysAgo(5),
          },
        ],
      },
      toolCalls: {
        create: [
          {
            id: "tool-plan-search-1",
            sequence: 1,
            name: "read_file",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({ path: "src/components/navigation-bar.tsx" }),
            outputJson: JSON.stringify({ lines: 180 }),
            startedAt: daysAgo(5),
            finishedAt: daysAgo(5),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-plan-search-1",
            model: "claude-sonnet-4.5",
            inputTokens: 48210,
            outputTokens: 6120,
            reasoningTokens: 3040,
            cacheReadTokens: 18400,
            cacheWriteTokens: 5200,
            estimatedCost: 0.42,
          },
        ],
      },
    },
  });

  // Session played from the plan above.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.sessionSearch,
      kind: "SESSION",
      displayNumber: displayNumbers.runs.sessionSearch,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      jiraIssueKey: ids.jira.issueKey,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: false,
      initialPrompt: "Implement the quick-search command palette from the plan.",
      finalOutput:
        "Implemented the ⌘K command palette, wired it to `/api/search`, and added keyboard navigation with tests.",
      error: null,
      estimatedCost: 1.28,
      pricingSource: "catalog",
      pricingUpdatedAt: hoursAgo(6),
      inputTokens: 132400,
      outputTokens: 21850,
      reasoningTokens: 9800,
      cacheReadTokens: 64200,
      cacheWriteTokens: 12100,
      toolCallCount: 12,
      sourcePlanId: ids.runs.planSearch,
      sourcePlanNumber: displayNumbers.runs.planSearch,
      startedAt: daysAgo(4),
      finishedAt: daysAgo(4),
      createdAt: daysAgo(4),
      attempts: {
        create: [
          {
            id: "attempt-session-search-1",
            generation: 1,
            nativeId: "claude-session-def456",
            status: "COMPLETED",
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-session-search-1",
            sequence: 1,
            kind: "INITIAL",
            prompt: "Implement the quick-search command palette from the plan.",
            createdAt: daysAgo(4),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-session-search-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Created quick-search component",
            searchText: "created quick-search component",
            detailMarkdown: "Added `src/components/quick-search.tsx`.",
            createdAt: daysAgo(4),
          },
          {
            id: "event-session-search-2",
            sequence: 2,
            type: "MESSAGE",
            summary: "Summarized the implementation",
            searchText: "summarized the implementation",
            createdAt: daysAgo(4),
          },
        ],
      },
      toolCalls: {
        create: [
          {
            id: "tool-session-search-1",
            sequence: 1,
            name: "apply_patch",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({ file: "src/components/quick-search.tsx" }),
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
          {
            id: "tool-session-search-2",
            sequence: 2,
            name: "run_terminal",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({ command: "npm test" }),
            outputJson: JSON.stringify({ exitCode: 0 }),
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-session-search-1",
            model: "claude-sonnet-4.5",
            inputTokens: 132400,
            outputTokens: 21850,
            reasoningTokens: 9800,
            cacheReadTokens: 64200,
            cacheWriteTokens: 12100,
            estimatedCost: 1.28,
          },
        ],
      },
    },
  });

  // In-progress session on another worktree.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.sessionAuth,
      kind: "SESSION",
      displayNumber: displayNumbers.runs.sessionAuth,
      status: "IN_PROGRESS",
      phase: "EXECUTING",
      origin: "MANAGED",
      provider: "CODEX",
      providerVersion: "codex-sdk 0.14",
      worktreeId: ids.worktrees.apiFeature,
      agentId: ids.agents.studio,
      repositoryName: "acme/api",
      branch: "feature/oauth-device-flow",
      model: "gpt-5-codex",
      effort: "medium",
      webSearchEnabled: false,
      initialPrompt: "Add the OAuth 2.0 device authorization flow to the API.",
      estimatedCost: 0.64,
      inputTokens: 74100,
      outputTokens: 8300,
      reasoningTokens: 5200,
      cacheReadTokens: 21000,
      toolCallCount: 6,
      startedAt: minutesAgo(18),
      createdAt: minutesAgo(20),
      attempts: {
        create: [
          {
            id: "attempt-session-auth-1",
            generation: 1,
            nativeId: "codex-session-ghi789",
            status: "RUNNING",
            startedAt: minutesAgo(18),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-session-auth-1",
            sequence: 1,
            kind: "INITIAL",
            prompt: "Add the OAuth 2.0 device authorization flow to the API.",
            createdAt: minutesAgo(20),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-session-auth-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Reading existing auth middleware",
            searchText: "reading existing auth middleware",
            createdAt: minutesAgo(17),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-session-auth-1",
            model: "gpt-5-codex",
            inputTokens: 74100,
            outputTokens: 8300,
            reasoningTokens: 5200,
            cacheReadTokens: 21000,
            estimatedCost: 0.64,
          },
        ],
      },
    },
  });

  /**
   * Paused waiting on an answer. A PENDING RunQuestionBatch on a non-FAILED run is what the
   * Action Center index classifies as reason QUESTION — its highest priority — so this is the
   * item that renders the answer form at the top of the Action Center and the sidebar.
   */
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planCheckoutQuestion,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planCheckoutQuestion,
      status: "PAUSED",
      phase: "WAITING_FOR_ANSWER",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: false,
      initialPrompt:
        "Plan a migration of the checkout flow onto the new payments SDK, keeping the existing gift-card path working.",
      estimatedCost: 0.18,
      inputTokens: 22600,
      outputTokens: 2840,
      reasoningTokens: 1420,
      cacheReadTokens: 8100,
      toolCallCount: 3,
      startedAt: minutesAgo(26),
      createdAt: minutesAgo(28),
      attempts: {
        create: [
          {
            id: "attempt-plan-checkout-1",
            generation: 1,
            nativeId: "claude-plan-jkl012",
            status: "RUNNING",
            startedAt: minutesAgo(26),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-plan-checkout-1",
            sequence: 1,
            kind: "INITIAL",
            prompt:
              "Plan a migration of the checkout flow onto the new payments SDK.",
            createdAt: minutesAgo(28),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-plan-checkout-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Reviewed the current payments integration",
            searchText: "reviewed the current payments integration",
            createdAt: minutesAgo(25),
          },
          {
            id: "event-plan-checkout-2",
            sequence: 2,
            type: "QUESTION",
            summary: "Asked how to handle gift cards during the migration",
            searchText: "asked how to handle gift cards during the migration",
            createdAt: minutesAgo(21),
          },
        ],
      },
      questionBatches: {
        create: [
          {
            id: ids.runQuestionBatches.planCheckout,
            nativeRequestId: "claude-question-checkout-1",
            eventSequence: 2,
            status: "PENDING",
            createdAt: minutesAgo(21),
            questions: {
              create: [
                {
                  id: "question-plan-checkout-1",
                  position: 0,
                  header: "Gift cards",
                  prompt:
                    "The new payments SDK has no gift-card primitive. How should the migration handle existing gift-card balances?",
                  multiSelect: false,
                  allowCustom: true,
                  options: {
                    create: [
                      {
                        id: "question-option-checkout-1",
                        position: 0,
                        label: "Keep the legacy path",
                        description:
                          "Route gift-card orders through the current integration until the SDK ships support.",
                      },
                      {
                        id: "question-option-checkout-2",
                        position: 1,
                        label: "Model them as store credit",
                        description:
                          "Convert balances to store credit and apply them as a discount line.",
                      },
                      {
                        id: "question-option-checkout-3",
                        position: 2,
                        label: "Block the migration",
                        description:
                          "Wait for first-class gift-card support before migrating checkout.",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-plan-checkout-1",
            model: "claude-sonnet-4.5",
            inputTokens: 22600,
            outputTokens: 2840,
            reasoningTokens: 1420,
            cacheReadTokens: 8100,
            estimatedCost: 0.18,
          },
        ],
      },
    },
  });

  // Imported plan (no managed worktree relationship).
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planImported,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planImported,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "IMPORTED",
      provider: "CODEX",
      agentId: ids.agents.studio,
      repositoryName: "acme/api",
      model: "gpt-5-codex",
      webSearchEnabled: false,
      initialPrompt: "Investigate flaky integration tests in the payments module.",
      finalOutput:
        "Identified a race condition in the payment webhook handler and proposed a locking strategy.",
      estimatedCost: 0.21,
      inputTokens: 28400,
      outputTokens: 3900,
      toolCallCount: 2,
      startedAt: daysAgo(8),
      finishedAt: daysAgo(8),
      createdAt: daysAgo(8),
    },
  });

  await prisma.runNumberSequence.createMany({
    data: [
      { kind: "PLAN", nextValue: 1004 },
      { kind: "SESSION", nextValue: 2003 },
    ],
  });

  await prisma.runDraft.create({
    data: {
      id: ids.runDrafts.refactor,
      kind: "SESSION",
      worktreeId: ids.worktrees.webMain,
      agentId: ids.agents.studio,
      provider: "CLAUDE",
      model: "claude-sonnet-4.5",
      effort: "medium",
      webSearchEnabled: false,
      prompt:
        "Refactor the checkout flow to extract a reusable payment form component.",
      createdAt: hoursAgo(3),
    },
  });
}
