import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  SearchableSelect,
  type SearchableSelectOption,
} from "./searchable-select";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const options: SearchableSelectOption[] = [
  {
    value: "codex",
    label: "Codex",
    description: "Studio Mac",
    secondaryDescription: "/repos/codex",
    keywords: "github.com/openai/codex studio.local",
  },
  {
    value: "web",
    label: "Web app",
    description: "Build agent",
    secondaryDescription: "/repos/web",
    keywords: "github.com/example/web build.local",
  },
  {
    value: "offline",
    label: "Offline checkout",
    disabled: true,
  },
];

function renderSelect(
  onValueChange = vi.fn(),
  props: Partial<React.ComponentProps<typeof SearchableSelect>> = {},
) {
  render(
    <SearchableSelect
      ariaLabel="Destination"
      emptyMessage="No matches"
      onValueChange={onValueChange}
      options={options}
      placeholder="Select a destination"
      searchPlaceholder="Search destinations"
      value=""
      {...props}
    />,
  );
  return onValueChange;
}

function openSelect() {
  fireEvent.click(screen.getByRole("combobox", { name: "Destination" }));
  return screen.getByRole("combobox", { name: "Search destinations" });
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

describe("SearchableSelect", () => {
  test("filters across labels, descriptions, paths, and keywords", async () => {
    renderSelect();
    const search = openSelect();

    for (const query of [
      "Codex",
      "Studio Mac",
      "/repos/codex",
      "studio.local",
    ]) {
      fireEvent.change(search, { target: { value: query } });
      expect(
        await screen.findByRole("option", {
          name: "Codex, Studio Mac, /repos/codex",
        }),
      ).toBeDefined();
      expect(screen.queryByRole("option", { name: /Web app/ })).toBeNull();
    }

    fireEvent.change(search, { target: { value: "missing" } });
    expect(await screen.findByText("No matches")).toBeDefined();
  });

  test("selects an enabled option with the mouse and ignores disabled options", () => {
    const onValueChange = renderSelect();
    openSelect();

    const disabled = screen.getByRole("option", {
      name: "Offline checkout",
    });
    expect(disabled.getAttribute("data-disabled")).toBe("true");
    fireEvent.click(disabled);
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("option", {
        name: "Codex, Studio Mac, /repos/codex",
      }),
    );
    expect(onValueChange).toHaveBeenCalledWith("codex");
    expect(
      screen.queryByRole("combobox", { name: "Search destinations" }),
    ).toBeNull();
  });

  test("selects the filtered option with the keyboard", async () => {
    const onValueChange = renderSelect();
    const search = openSelect();
    fireEvent.change(search, { target: { value: "Web app" } });
    await screen.findByRole("option", { name: /Web app/ });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("web"));
  });

  test("renders all selected details in the shadcn trigger", () => {
    renderSelect(vi.fn(), { showSelectedDetails: true, value: "codex" });
    const trigger = screen.getByRole("combobox", { name: "Destination" });
    expect(trigger.getAttribute("data-slot")).toBe("popover-trigger");
    expect(
      Array.from(trigger.querySelectorAll("span.block"), (line) =>
        line.textContent?.trim(),
      ),
    ).toEqual(["Codex", "Studio Mac", "/repos/codex"]);
  });
});
