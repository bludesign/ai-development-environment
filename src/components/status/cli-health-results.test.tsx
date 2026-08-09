import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CliHealthResults } from "./cli-health-results";
import type { AgentCliHealthStatus, CliHealthCheck } from "./types";

const result = (
  id: string,
  state: CliHealthCheck["state"],
  exitCode: number | null,
): CliHealthCheck => ({
  id,
  name: id,
  command: `${id} auth status`,
  builtIn: true,
  state,
  exitCode,
  stdout: state === "HEALTHY" ? "Authenticated" : "",
  stderr: state === "UNHEALTHY" ? "Login expired" : "",
  durationMs: state === "NOT_RUN" ? null : 25,
  checkedAt: state === "NOT_RUN" ? null : "2026-08-09T12:00:00.000Z",
  timedOut: false,
  launchError: null,
  outputTruncated: state === "UNHEALTHY",
});

const status = (
  patch: Partial<AgentCliHealthStatus> = {},
): AgentCliHealthStatus => ({
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
    result("Passing", "HEALTHY", 0),
    result("Failing", "UNHEALTHY", 1),
    result("Pending", "NOT_RUN", null),
  ],
  ...patch,
});

describe("CliHealthResults", () => {
  afterEach(cleanup);

  test("renders every badge state and expands separated command output", () => {
    render(<CliHealthResults status={status()} />);

    expect(screen.getByText("Issues")).toBeDefined();
    expect(screen.getByText("Passed")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
    expect(screen.getByText("Not run")).toBeDefined();
    expect(screen.queryByText("Login expired")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Failing/ }));
    expect(screen.getByText("Login expired")).toBeDefined();
    expect(screen.getByText("Output truncated")).toBeDefined();
    expect(screen.getByText("Exit code: 1")).toBeDefined();
  });

  test("shows cached offline results and disables manual runs", () => {
    const onRun = vi.fn();
    render(
      <CliHealthResults
        onRun={onRun}
        status={status({ connectionStatus: "OFFLINE" })}
      />,
    );

    expect(screen.getByText("Cached")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Run checks" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("shows update guidance for unsupported older agents", () => {
    render(
      <CliHealthResults
        status={status({
          supported: false,
          overall: "UNSUPPORTED",
          results: [],
        })}
      />,
    );

    expect(screen.getByText("Update required")).toBeDefined();
    expect(
      screen.getByText(
        "Update this agent to a version that supports CLI health checks.",
      ),
    ).toBeDefined();
  });
});
