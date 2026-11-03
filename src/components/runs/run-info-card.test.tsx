import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { RunInfoCard } from "./run-info-card";
import type { AgentRunView } from "./types";

const attempt = (
  generation: number,
  overrides: Partial<AgentRunView["attempts"][number]> = {},
): AgentRunView["attempts"][number] => ({
  id: `attempt-${generation}`,
  generation,
  nativeId: `native-${generation}`,
  status: "COMPLETED",
  resumeStrategy: null,
  startedAt: "2026-11-03T10:00:00.000Z",
  finishedAt: "2026-11-03T10:01:00.000Z",
  supersededAt: null,
  sessionInfo: {
    nativeTranscriptPath: "/custom home/.codex/archived_sessions/native.jsonl",
    activityLogPath: "/aide/runs/run-1/events.jsonl",
    workingDirectory: "/workspace/project",
  },
  ...overrides,
});

const base: Parameters<typeof RunInfoCard>[0]["run"] = {
  kind: "SESSION",
  provider: "CODEX",
  providerVersion: "0.166.0",
  origin: "MANAGED",
  agentId: "agent-1",
  repositoryName: "project",
  branch: "feature/AIDE-174-worktree-fixes",
  model: "gpt-6.1-sol",
  effort: "high",
  attempts: [attempt(0)],
  createdAt: "2026-11-03T10:00:00.000Z",
  startedAt: "2026-11-03T10:00:01.000Z",
  finishedAt: "2026-11-03T10:01:00.000Z",
  updatedAt: "2026-11-03T10:02:00.000Z",
};

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
afterEach(() => {
  cleanup();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function valueFor(label: string) {
  return screen.getByText(label, { selector: "dt" }).parentElement!;
}

describe("RunInfoCard", () => {
  test.each(["CODEX", "CLAUDE", "OPENCODE"])(
    "shows session and plan details for %s without checkpoints",
    (provider) => {
      for (const kind of ["SESSION", "PLAN"] as const) {
        const { unmount } = render(
          <RunInfoCard run={{ ...base, kind, provider }} />,
        );
        expect(
          screen.getByText(kind === "PLAN" ? "Plan info" : "Session info"),
        ).toBeDefined();
        expect(
          within(valueFor("Native session ID")).getByText("native-0"),
        ).toBeDefined();
        expect(
          within(valueFor("Working directory")).getByText("/workspace/project"),
        ).toBeDefined();
        expect(
          within(valueFor("AIDE activity-log path")).getByText(
            "/aide/runs/run-1/events.jsonl",
          ),
        ).toBeDefined();
        if (provider === "OPENCODE") {
          expect(
            screen.getByText(
              "OpenCode does not expose a standalone session file.",
            ),
          ).toBeDefined();
          expect(
            screen.queryByRole("button", {
              name: "Copy Native transcript path",
            }),
          ).toBeNull();
        } else {
          expect(
            within(valueFor("Native transcript path")).getByText(
              base.attempts[0]!.sessionInfo!.nativeTranscriptPath!,
            ),
          ).toBeDefined();
        }
        unmount();
      }
    },
  );

  test("uses the newest non-superseded attempt without falling back to older native IDs or paths", () => {
    render(
      <RunInfoCard
        run={{
          ...base,
          attempts: [
            attempt(2, {
              supersededAt: "2026-11-03T11:00:00.000Z",
              nativeId: "superseded-id",
            }),
            attempt(1, { nativeId: null, sessionInfo: null }),
            attempt(0),
          ],
        }}
      />,
    );
    for (const label of [
      "Native session ID",
      "Native transcript path",
      "Working directory",
      "AIDE activity-log path",
    ]) {
      expect(within(valueFor(label)).getByText("Unavailable")).toBeDefined();
      expect(within(valueFor(label)).queryByRole("button")).toBeNull();
    }
    expect(screen.queryByText("native-0")).toBeNull();
    expect(screen.queryByText("superseded-id")).toBeNull();
  });

  test("keeps imported session paths but explains the absence of an AIDE journal", () => {
    render(<RunInfoCard run={{ ...base, origin: "IMPORTED" }} />);
    expect(
      screen.getByText("No AIDE activity log is created for imported runs."),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Copy AIDE activity-log path" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy Native transcript path" }),
    ).toBeDefined();
  });

  test("renders missing metadata and timestamps without exposing copy actions for unavailable values", () => {
    render(
      <RunInfoCard
        run={{
          ...base,
          attempts: [],
          agentId: null,
          providerVersion: null,
          effort: null,
          branch: null,
          startedAt: null,
          finishedAt: null,
        }}
      />,
    );
    expect(within(valueFor("Started")).getByText("Unavailable")).toBeDefined();
    expect(within(valueFor("Finished")).getByText("Unavailable")).toBeDefined();
    expect(
      within(valueFor("Provider version")).getByText("Unavailable"),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  test("copies exact archived paths and IDs and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<RunInfoCard run={base} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Native transcript path" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "/custom home/.codex/archived_sessions/native.jsonl",
      ),
    );
    expect(await screen.findByText("Copied")).toBeDefined();
    writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Native session ID" }),
    );
    expect(await screen.findByText("Could not copy this value.")).toBeDefined();
    expect(writeText).toHaveBeenLastCalledWith("native-0");
  });
});
