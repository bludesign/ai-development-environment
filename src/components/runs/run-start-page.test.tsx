import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RunStartPage } from "./run-start-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const pageData = {
  worktreeOverview: {
    agents: [
      {
        agent: {
          name: "Builder",
          connectionStatus: "ONLINE",
          capabilities: ["runs.provider.codex"],
        },
        codebases: [
          {
            repository: { name: "widgets" },
            worktrees: [
              {
                id: "worktree-1",
                folder: "/workspace/widgets",
                branch: "main",
                availability: "AVAILABLE",
                ticketKey: null,
                ticketTitle: null,
              },
            ],
          },
        ],
      },
    ],
  },
  runProviderCatalog: [
    {
      key: "CODEX",
      label: "Codex",
      available: true,
      supportsWebSearch: true,
      models: [{ id: "gpt-5.6", label: "GPT-5.6", efforts: ["high"] }],
    },
  ],
};

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  request.mockReset();
  request.mockResolvedValue(pageData as never);
});

afterEach(() => {
  cleanup();
});

describe("RunStartPage", () => {
  test("loads worktrees, tools, and efforts without declaring an unused draft variable", async () => {
    render(<RunStartPage initialKind="PLAN" />);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [query, variables] = request.mock.calls[0]!;
    expect(query).toContain("query RunStartPage {");
    expect(query).not.toContain("$draftId");
    expect(variables).toBeUndefined();

    expect(
      within(screen.getByText("Tool").parentElement!).getByRole("combobox")
        .textContent,
    ).toContain("Codex");
    expect(
      within(screen.getByText("Effort").parentElement!).getByRole("combobox")
        .textContent,
    ).toContain("high");

    const worktreeSelect = within(
      screen.getByText("Worktree").parentElement!,
    ).getByRole("combobox");
    fireEvent.pointerDown(worktreeSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      await screen.findByRole("option", {
        name: "widgets · main · Builder",
      }),
    ).toBeDefined();
  });

  test("declares and supplies the draft variable while editing a draft", async () => {
    request.mockResolvedValue({
      ...pageData,
      runDraft: {
        id: "draft-1",
        kind: "PLAN",
        worktreeId: "worktree-1",
        agentId: "agent-1",
        worktree: null,
        jiraIssueKey: null,
        jiraSummary: null,
        provider: "CODEX",
        model: "gpt-5.6",
        effort: "high",
        webSearchEnabled: false,
        prompt: "Review this change",
        attachments: [],
        archivedAt: null,
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
    } as never);

    render(<RunStartPage draftId="draft-1" initialKind="PLAN" />);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [query, variables] = request.mock.calls[0]!;
    expect(query).toContain("query RunStartPage($draftId: ID!) {");
    expect(query).toContain("runDraft(id: $draftId)");
    expect(variables).toEqual({ draftId: "draft-1" });
  });
});
