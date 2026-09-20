import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CommandQuickActions } from "./command-quick-actions";
import { CommandResourcePanel } from "./command-resource-panel";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
  onControlPlaneRecovery: () => () => undefined,
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
}));
const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

const serve = {
  id: "quick",
  name: "Serve",
  description: "Start server",
  quickActionEnabled: true,
  quickActionIconKey: "terminal",
  quickActionButtonVariant: "default",
};

/**
 * Routes each call by the operation in its query so a test can describe the
 * eligible commands and the runs those commands currently have.
 */
function respondWith(runs: Array<Record<string, unknown>>) {
  request.mockImplementation((query: string) => {
    if (query.includes("commandTargetSummaries(")) {
      return Promise.resolve({
        commandTargetSummaries: [
          {
            resourceKind: "AGENT",
            resourceId: "agent-1",
            commands: [serve],
            activeRuns: runs,
            recentRuns: [],
          },
        ],
      } as never);
    }
    return Promise.resolve({} as never);
  });
}

const openRunMenu = async () => {
  const trigger = await screen.findByRole("button", {
    name: "Manage running Serve",
  });
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", {
      bubbles: true,
      ctrlKey: false,
      button: 0,
    }),
  );
  return trigger;
};

describe("CommandQuickActions", () => {
  test("shows only quick actions and gates an old agent", async () => {
    request.mockResolvedValue({
      commandTargetSummaries: [
        {
          resourceKind: "AGENT",
          resourceId: "agent-1",
          activeRuns: [],
          recentRuns: [],
          commands: [
            serve,
            {
              id: "regular",
              name: "Migrate",
              description: "Run migration",
              quickActionEnabled: false,
              quickActionIconKey: "terminal",
              quickActionButtonVariant: "default",
            },
          ],
        },
      ],
    } as never);
    render(<CommandQuickActions agentCapabilities={[]} agentId="agent-1" />);
    expect(
      (await screen.findByRole("button", { name: /Serve/ })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(screen.queryByText("Migrate")).toBeNull();
    expect(screen.getByText("Upgrade agent")).toBeDefined();
  });

  test("replaces the view button with a run menu while a run is active", async () => {
    respondWith([
      {
        id: "run-1",
        displayNumber: 7,
        status: "RUNNING",
        commandId: "quick",
      },
    ]);
    render(
      <CommandQuickActions
        agentCapabilities={["command.run"]}
        agentId="agent-1"
      />,
    );
    await openRunMenu();
    expect(screen.getByRole("menuitem", { name: /Terminate/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Restart/ })).toBeDefined();
    // "View" moved out of the button and into the menu, still linking the run.
    expect(
      screen.getByRole("menuitem", { name: /View/ }).getAttribute("href"),
    ).toBe("/commands/runs/run-1");
  });

  test("shows no run menu once every run has finished", async () => {
    respondWith([
      {
        id: "run-1",
        displayNumber: 7,
        status: "SUCCEEDED",
        commandId: "quick",
      },
    ]);
    render(
      <CommandQuickActions
        agentCapabilities={["command.run"]}
        agentId="agent-1"
      />,
    );
    await screen.findByRole("button", { name: /Serve/ });
    expect(
      screen.queryByRole("button", { name: "Manage running Serve" }),
    ).toBeNull();
  });

  test("requests a compact target summary without scripts or a global run limit", async () => {
    respondWith([]);
    render(
      <CommandQuickActions
        agentCapabilities={["command.run"]}
        agentId="agent-1"
      />,
    );

    await screen.findByRole("button", { name: /Serve/ });
    const query = request.mock.calls.find(([operation]) =>
      operation.includes("commandTargetSummaries("),
    )?.[0];
    expect(query).toContain("activeRuns { id commandId displayNumber status }");
    expect(query).not.toMatch(/\bscript\b|\bsnapshot\b|first: 50/);
  });

  test("terminates the run the menu was opened for", async () => {
    respondWith([
      { id: "run-1", displayNumber: 7, status: "RUNNING", commandId: "quick" },
    ]);
    render(
      <CommandQuickActions
        agentCapabilities={["command.run"]}
        agentId="agent-1"
      />,
    );
    await openRunMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Terminate/ }));
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            query.includes("terminateCommandRun") &&
            (variables as { id: string }).id === "run-1",
        ),
      ).toBe(true),
    );
  });

  test("starts a separate run when the command itself is clicked", async () => {
    respondWith([
      { id: "run-1", displayNumber: 7, status: "RUNNING", commandId: "quick" },
    ]);
    render(
      <CommandQuickActions
        agentCapabilities={["command.run"]}
        agentId="agent-1"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Serve" }));
    await vi.waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            query.includes("startCommandRun") &&
            (variables as { input: { commandId: string } }).input.commandId ===
              "quick",
        ),
      ).toBe(true),
    );
    // Starting is not a rerun of the active run, so nothing is terminated.
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("terminateCommandRun"),
      ),
    ).toBe(false);
  });

  test("rendered cards and an overlapping detail panel share one target batch", async () => {
    request.mockImplementation(
      async (_query, variables) =>
        ({
          commandTargetSummaries: (
            variables?.targets as Array<{
              resourceKind: string;
              resourceId: string;
            }>
          ).map((target) => ({
            ...target,
            commands: [serve],
            activeRuns: [],
            recentRuns: [],
          })),
        }) as never,
    );
    const view = (
      <>
        {["a", "b", "c", "d"].map((agentId) => (
          <CommandQuickActions
            key={agentId}
            agentId={agentId}
            agentCapabilities={["command.run"]}
          />
        ))}
        <CommandResourcePanel agentId="a" agentCapabilities={["command.run"]} />
      </>
    );
    const mounted = render(view);
    await screen.findAllByText("Serve");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.targets).toHaveLength(4);
    expect(request.mock.calls[0][1]?.targets).toContainEqual({
      resourceKind: "AGENT",
      resourceId: "a",
      includeAllCommands: true,
      includeRecentRuns: true,
    });
    mounted.rerender(view);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
