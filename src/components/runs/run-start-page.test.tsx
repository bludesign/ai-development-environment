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
  window.localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  request.mockReset();
  request.mockResolvedValue(pageData as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RunStartPage", () => {
  test("progressively selects a tool, model, and effort with web search enabled", async () => {
    render(<RunStartPage initialKind="PLAN" />);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [query, variables] = request.mock.calls[0]!;
    expect(query).toContain("query RunStartPage {");
    expect(query).not.toContain("$draftId");
    expect(variables).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Choose a model" }));
    fireEvent.click(await screen.findByRole("option", { name: "GPT-5.6" }));

    expect(
      screen.getByRole("button", { name: /GPT-5\.6/ }).textContent,
    ).toContain("high");
    expect(
      screen
        .getByRole("checkbox", { name: /Web search/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Plan" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Session" })).toBeDefined();

    fireEvent.click(
      within(screen.getByText("Worktree").parentElement!).getByRole("button", {
        name: "Select a worktree",
      }),
    );
    expect(
      await screen.findByRole("option", {
        name: "widgets · main · Builder",
      }),
    ).toBeDefined();
  });

  test("searches worktrees by folder from inside the dropdown", async () => {
    render(<RunStartPage initialKind="PLAN" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Select a worktree" }),
    );
    const search = await screen.findByPlaceholderText("Search worktrees");
    fireEvent.change(search, { target: { value: "workspace/widgets" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "widgets · main · Builder" }),
    );

    expect(
      screen.getByRole("button", { name: /widgets · main · Builder/ }),
    ).toBeDefined();
    expect(screen.getByText("/workspace/widgets")).toBeDefined();
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

  test("searches the palette and pins the chosen model as a preset", async () => {
    request.mockResolvedValue({
      ...pageData,
      runProviderCatalog: [
        {
          ...pageData.runProviderCatalog[0],
          models: [
            { id: "model-1", label: "Model One", efforts: ["auto", "high"] },
            { id: "model-2", label: "Model Two", efforts: ["auto"] },
            { id: "model-3", label: "Model Three", efforts: ["auto"] },
            { id: "model-4", label: "Model Four", efforts: ["auto"] },
          ],
        },
      ],
    } as never);

    render(<RunStartPage initialKind="PLAN" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Choose a model" }),
    );
    const search = await screen.findByPlaceholderText("Search model");
    fireEvent.change(search, { target: { value: "Four" } });
    fireEvent.click(await screen.findByRole("option", { name: "Model Four" }));

    expect(
      JSON.parse(window.localStorage.getItem("aide.model-presets.v1") ?? "{}"),
    ).toEqual({
      pinned: [],
      recent: [{ provider: "CODEX", model: "model-4", effort: "auto" }],
    });

    fireEvent.click(screen.getByRole("button", { name: /Model Four/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Pin as preset" }),
    );

    expect(
      JSON.parse(window.localStorage.getItem("aide.model-presets.v1") ?? "{}"),
    ).toEqual({
      pinned: [{ provider: "CODEX", model: "model-4", effort: "auto" }],
      recent: [],
    });
  });

  test("switches the whole triple from a preset chip", async () => {
    window.localStorage.setItem(
      "aide.model-presets.v1",
      JSON.stringify({
        pinned: [{ provider: "CODEX", model: "gpt-5.6", effort: "high" }],
        recent: [],
      }),
    );

    render(<RunStartPage initialKind="PLAN" />);

    fireEvent.click(await screen.findByRole("button", { name: /GPT-5\.6/ }));

    const pill = screen.getByRole("button", { name: /GPT-5\.6/ });
    expect(pill.textContent).toContain("high");
    expect(screen.queryByRole("button", { name: "Choose a model" })).toBeNull();
  });

  test("uploads files dropped on the attachment picker", async () => {
    const upload = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "attachment-1",
        filename: "notes.txt",
        contentType: "text/plain",
        size: 5,
        sha256: "hash",
      }),
    });
    vi.stubGlobal("fetch", upload);

    render(<RunStartPage initialKind="PLAN" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const dropTarget = screen.getByText("Attach files").closest("label")!;
    fireEvent.drop(dropTarget, {
      dataTransfer: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });

    expect(await screen.findByText("notes.txt")).toBeDefined();
    expect(upload).toHaveBeenCalledWith(
      "/api/run-attachments",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
