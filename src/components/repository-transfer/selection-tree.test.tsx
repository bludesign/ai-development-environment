import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { TransferSelectionTree } from "./selection-tree";
import type { TransferChoice, TransferItem } from "./types";

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

afterEach(cleanup);

const item: TransferItem = {
  key: "command:build",
  kind: "COMMAND",
  label: "Build command",
  parentKey: null,
  repositoryKey: null,
  selected: true,
  dependency: false,
  action: "IMPORT",
  targetId: "first",
  candidates: [
    { id: "first", label: "Current build" },
    { id: "second", label: "Other build" },
  ],
  current: "Local command content",
  incoming: "Incoming command content",
  affectedRepositories: [],
  warnings: [],
};

async function choose(name: string, option: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

test("shadcn choices retain conflict actions and can reset explicit targets to automatic matching", async () => {
  const onChoice = vi.fn();
  function Harness() {
    const [choices, setChoices] = useState<TransferChoice[]>([]);
    return (
      <TransferSelectionTree
        items={[item]}
        excludedKeys={[]}
        includedKeys={[]}
        onToggle={vi.fn()}
        choices={choices}
        onChoice={(choice) => {
          onChoice(choice);
          setChoices([choice]);
        }}
      />
    );
  }
  render(<Harness />);
  await choose("Existing destination", "Other build");
  expect(onChoice).toHaveBeenLastCalledWith({
    key: item.key,
    action: "IMPORT",
    targetId: "second",
  });
  await choose("Existing destination", "Match automatically");
  expect(onChoice).toHaveBeenLastCalledWith({
    key: item.key,
    action: "IMPORT",
    targetId: undefined,
  });
  expect(
    screen.getByRole("combobox", { name: "Existing destination" }).textContent,
  ).toBe("Match automatically");
  await choose("When this item exists", "Keep existing");
  expect(onChoice).toHaveBeenLastCalledWith({
    key: item.key,
    action: "KEEP",
    targetId: undefined,
  });
  await choose("When this item exists", "Create a copy");
  expect(
    screen.queryByRole("combobox", { name: "Existing destination" }),
  ).toBeNull();
  expect(screen.getByRole("textbox")).toBeDefined();
});

test("review values is an accessible disclosure and remains readable when choices are disabled", () => {
  render(
    <TransferSelectionTree
      items={[item]}
      excludedKeys={[]}
      includedKeys={[]}
      onToggle={vi.fn()}
      onChoice={vi.fn()}
      readOnly
    />,
  );
  const review = screen.getByRole("button", { name: "Review values" });
  expect(review.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Local command content")).toBeNull();
  fireEvent.click(review);
  expect(review.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Local command content")).toBeDefined();
  expect(screen.getByText("Incoming command content")).toBeDefined();
  expect(
    (
      screen.getByRole("combobox", {
        name: "When this item exists",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
