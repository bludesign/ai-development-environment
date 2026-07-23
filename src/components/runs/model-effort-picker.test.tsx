import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ModelEffortPicker } from "./model-effort-picker";

const catalog = [
  {
    key: "OPENCODE",
    label: "OpenCode",
    available: true,
    supportsWebSearch: true,
    models: [
      {
        id: "opencode-go/glm-5.2",
        label: "GLM-5.2",
        efforts: ["auto", "high"],
        group: "OpenCode Go",
      },
      {
        id: "opencode-go/minimax-m3",
        label: "MiniMax-M3",
        efforts: ["auto"],
        group: "OpenCode Go",
      },
      {
        id: "opencode/minimax-m3-free",
        label: "MiniMax-M3 Free",
        efforts: ["auto"],
        group: "OpenCode Zen",
      },
    ],
  },
  {
    key: "CODEX",
    label: "Codex",
    available: true,
    supportsWebSearch: true,
    models: [{ id: "gpt-5.6", label: "GPT-5.6", efforts: ["high"] }],
  },
];

function open(props?: Partial<Parameters<typeof ModelEffortPicker>[0]>) {
  render(
    <ModelEffortPicker
      catalog={catalog}
      effort="auto"
      model=""
      onEffortChange={vi.fn()}
      onModelChange={vi.fn()}
      onProviderChange={vi.fn()}
      provider=""
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose a model" }));
}

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
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelEffortPicker", () => {
  test("sections a provider's catalogs under their own headings", () => {
    open();

    const go = screen.getByRole("group", { name: "OpenCode Go" });
    expect(
      within(go)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["GLM-5.2", "MiniMax-M3"]);

    const zen = screen.getByRole("group", { name: "OpenCode Zen" });
    expect(within(zen).getAllByRole("option")).toHaveLength(1);
    /* A provider that names no group keeps the single heading it had. */
    expect(screen.getByRole("group", { name: "Codex" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "OpenCode" })).toBeNull();
  });

  test("sets a model's tier suffix in quieter type than its name", () => {
    open();

    const free = within(
      screen.getByRole("group", { name: "OpenCode Zen" }),
    ).getByRole("option");
    const qualifier = within(free).getByText("Free");
    expect(qualifier.className).toContain("text-xs");
    expect(qualifier.className).toContain("text-muted-foreground");
    /* The name itself stays at the row's own size and colour. */
    expect(free.textContent).toBe("MiniMax-M3 Free");
  });

  test("selects a model from a sectioned group", () => {
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    open({ onProviderChange, onModelChange });

    fireEvent.click(screen.getByRole("option", { name: "GLM-5.2" }));

    expect(onProviderChange).toHaveBeenCalledWith("OPENCODE");
    expect(onModelChange).toHaveBeenCalledWith("opencode-go/glm-5.2");
  });
});
