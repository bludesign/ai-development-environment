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
});
