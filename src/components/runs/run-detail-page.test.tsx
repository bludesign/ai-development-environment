import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RunDetailPage } from "./run-detail-page";
import type { AgentRunView } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const failedRun: AgentRunView = {
  id: "run-353",
  kind: "SESSION",
  displayNumber: 353,
  status: "FAILED",
  phase: "FAILED",
  origin: "MANAGED",
  provider: "CODEX",
  providerVersion: null,
  worktreeId: "worktree-1",
  agentId: "agent-1",
  worktree: {
    id: "worktree-1",
    folder: "/workspace/ai-development-environment",
    branch: "feature/AIDE-66-plans-and-sessions-support",
    highlightColor: null,
  },
  jiraIssueKey: "AIDE-66",
  jiraSummary: "Plans and sessions support",
  repositoryName: "ai-development-environment",
  branch: "feature/AIDE-66-plans-and-sessions-support",
  model: "gpt-5.6",
  effort: null,
  webSearchEnabled: false,
  initialPrompt: "Implement plans and sessions support",
  finalOutput: null,
  error: "Control agent restarted while this run was active",
  estimatedCost: null,
  pricingSource: null,
  pricingUpdatedAt: null,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCallCount: 0,
  sourcePlanId: null,
  sourcePlanNumber: null,
  playedAt: null,
  playedSessionNumber: null,
  sourcePlan: null,
  playedSession: null,
  parentRunId: null,
  parentRunNumber: null,
  parentRun: null,
  followUps: [],
  attempts: [],
  inputs: [],
  modelUsage: [],
  toolCalls: [],
  questionBatches: [],
  checkpoints: [],
  archivedAt: null,
  nativeArchivedAt: null,
  startedAt: "2026-07-23T12:42:45.000Z",
  finishedAt: "2026-07-23T12:43:00.000Z",
  createdAt: "2026-07-23T12:42:45.000Z",
  updatedAt: "2026-07-23T12:43:00.000Z",
};

describe("RunDetailPage", () => {
  beforeEach(() => {
    request.mockReset();
    subscriptions.mockReset();
    subscriptions.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query AgentRunDetail")) {
        return {
          agentRun: failedRun,
          runProviderCatalog: [
            {
              key: "CODEX",
              label: "Codex",
              available: true,
              supportsWebSearch: true,
              supportsPause: true,
              supportsSteering: true,
              supportsResume: true,
              supportsNativeDelete: true,
              models: [{ id: "gpt-5.6", label: "GPT-5.6", efforts: [] }],
            },
          ],
        } as never;
      }
      if (operation.includes("query RunActivity")) {
        return { runEvents: [] } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the persisted error for a failed session", async () => {
    render(<RunDetailPage runId="run-353" />);

    expect(
      await screen.findByText(
        "Control agent restarted while this run was active",
      ),
    ).toBeDefined();
  });
});
