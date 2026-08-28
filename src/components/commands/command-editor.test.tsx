import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CommandEditor } from "./command-editor";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const request = vi.mocked(controlPlaneRequest);

beforeEach(() => {
  request.mockResolvedValue({
    agents: [],
    codebaseOverview: { repositories: [] },
  } as never);
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("CommandEditor", () => {
  const chooseRepositoryScope = async () => {
    fireEvent.pointerDown(screen.getAllByRole("combobox")[0]!, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Worktree in selected repositories",
      }),
    );
  };

  test("shows an icon-free command card and a quick-action icon picker", async () => {
    render(<CommandEditor />);

    const commandTitle = screen.getByText("Command", {
      selector: '[data-slot="card-title"]',
    });
    expect(commandTitle.querySelector("svg")).toBeNull();

    const iconPicker = screen.getByRole("button", {
      name: "Icon: Command line",
    });
    fireEvent.pointerDown(iconPicker, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    const releaseIcon = await screen.findByRole("menuitemradio", {
      name: "Release",
    });
    expect(releaseIcon.querySelector("svg")).not.toBeNull();
    fireEvent.click(releaseIcon);

    expect(screen.getByRole("button", { name: "Icon: Release" })).toBeDefined();
  });

  test("enables completion notifications by default and saves an opt-out", async () => {
    render(<CommandEditor />);

    const notifications = screen.getByRole("checkbox", {
      name: "Notify when this command finishes",
    });
    expect(notifications.getAttribute("data-state")).toBe("checked");

    fireEvent.click(notifications);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: expect.objectContaining({ notificationsEnabled: false }),
    });
  });

  test("defaults Git blocking off but requires it for exclusive commands", async () => {
    render(<CommandEditor />);

    const blocksGit = screen.getByRole("checkbox", {
      name: "Block Git operations while this command runs",
    });
    expect(blocksGit.getAttribute("data-state")).toBe("unchecked");
    expect(blocksGit.hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /Requires exclusive/ }));
    expect(blocksGit.getAttribute("data-state")).toBe("checked");
    expect(blocksGit.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(
        "Exclusive commands always block Git and worktree operations on their codebase.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: /Non-exclusive/ }));
    expect(blocksGit.getAttribute("data-state")).toBe("unchecked");
    expect(blocksGit.hasAttribute("disabled")).toBe(false);

    fireEvent.click(blocksGit);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: expect.objectContaining({ blocksGitOperations: true }),
    });
  });

  test("requires and saves multiple selected repositories", async () => {
    request.mockResolvedValueOnce({
      agents: [],
      codebaseOverview: {
        repositories: [
          { id: "repo-web", name: "web", displayOrigin: "github.com/acme/web" },
          { id: "repo-ios", name: "ios", displayOrigin: "github.com/acme/ios" },
        ],
      },
    } as never);
    render(<CommandEditor />);
    await chooseRepositoryScope();
    await screen.findByText("github.com/acme/web");

    expect(screen.getByText("Select at least one repository.")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "web · github.com/acme/web" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "ios · github.com/acme/ios" }),
    );
    expect(screen.getByText("2 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      input: expect.objectContaining({
        targetKind: "REPOSITORY_WORKTREE",
        targetRepositoryIds: ["repo-web", "repo-ios"],
      }),
    });
  });

  test("loads and edits an existing multi-repository definition", async () => {
    request.mockResolvedValueOnce({
      agents: [],
      codebaseOverview: {
        repositories: [
          { id: "repo-web", name: "web", displayOrigin: "github.com/acme/web" },
          { id: "repo-ios", name: "ios", displayOrigin: "github.com/acme/ios" },
        ],
      },
      commandDefinition: {
        id: "command-1",
        name: "Test",
        description: "",
        script: "npm test",
        targetKind: "REPOSITORY_WORKTREE",
        targetAgentId: null,
        targetAgent: null,
        targetRepositoryIds: ["repo-web", "repo-ios"],
        targetRepositories: [],
        restartPolicy: "NEVER",
        restartLimit: 3,
        concurrency: "NON_EXCLUSIVE",
        blocksGitOperations: false,
        quickActionEnabled: false,
        quickActionIconKey: "terminal",
        quickActionButtonVariant: "default",
        notificationsEnabled: true,
        archivedAt: null,
        createdAt: "2026-08-27T00:00:00Z",
        updatedAt: "2026-08-27T00:00:00Z",
      },
    } as never);

    render(<CommandEditor commandId="command-1" />);
    await screen.findByDisplayValue("Test");
    expect(await screen.findByText("2 selected")).toBeDefined();
    const ios = screen.getByRole("checkbox", {
      name: "ios · github.com/acme/ios",
    });
    expect(ios.getAttribute("data-state")).toBe("checked");
    fireEvent.click(ios);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      id: "command-1",
      input: expect.objectContaining({ targetRepositoryIds: ["repo-web"] }),
    });
  });
});
