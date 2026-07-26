import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { McpPresetPicker } from "./mcp-preset-picker";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("McpPresetPicker", () => {
  test("renders icon, name, description, and starts unchecked", async () => {
    request.mockResolvedValue({
      mcpToolPresets: [
        {
          id: "preset-1",
          name: "Repository reader",
          description: "Read-only repository context",
          iconKey: "code",
          enabledForPlans: true,
          enabledForSessions: false,
          toolNames: ["get_codebases"],
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
      ],
    } as never);
    const onChange = vi.fn();

    render(
      <McpPresetPicker kind="PLAN" onChange={onChange} selectedIds={[]} />,
    );

    expect(await screen.findByText("Repository reader")).toBeDefined();
    expect(screen.getByText("Read-only repository context")).toBeDefined();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(["preset-1"]);
    expect(request).toHaveBeenCalledWith(expect.any(String), { kind: "PLAN" });
  });
});
