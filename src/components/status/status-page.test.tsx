import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { StatusPage } from "./status-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

describe("StatusPage", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockResolvedValue({
      installationStatus: {
        version: "2.4.0",
        dependencies: [{ name: "Next.js", version: "16.2.10" }],
        customChecks: [],
        agents: [
          {
            agentId: "agent-1",
            name: "Studio Mac",
            hostname: "studio.local",
            version: "2.4.0",
            connectionStatus: "ONLINE",
            supported: true,
            activeJobId: null,
            lastCheckedAt: "2026-08-09T12:00:00.000Z",
            overall: "ISSUES",
            results: [
              {
                id: "codex",
                name: "Codex",
                command: "codex login status",
                builtIn: true,
                state: "UNHEALTHY",
                exitCode: 1,
                stdout: "",
                stderr: "Login expired",
                durationMs: 20,
                checkedAt: "2026-08-09T12:00:00.000Z",
                timedOut: false,
                launchError: null,
                outputTruncated: false,
              },
            ],
          },
        ],
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("renders installed and agent versions with health controls", async () => {
    render(<StatusPage />);
    expect(await screen.findByText("Studio Mac")).toBeDefined();
    expect(screen.getByText("2.4.0")).toBeDefined();
    expect(screen.getByText("16.2.10")).toBeDefined();
    expect(screen.getByText("Issues")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "CLI health check settings" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Run checks" })).toBeDefined();
  });

  test("dispatches a manual run for the selected agent", async () => {
    render(<StatusPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Run checks" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({ agentId: "agent-1" });
  });

  test("renders request errors", async () => {
    request.mockReset();
    request.mockRejectedValueOnce(new Error("Control plane unavailable"));
    render(<StatusPage />);

    expect(await screen.findByText("Control plane unavailable")).toBeDefined();
  });
});
