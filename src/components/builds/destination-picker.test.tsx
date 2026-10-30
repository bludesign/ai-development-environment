import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  BuildDestinationPicker,
  destinationName,
  filterDestinations,
} from "./destination-picker";
const destination = {
  type: "SIMULATOR" as const,
  id: "sim-1",
  name: "QA Phone",
  deviceType: "iPhone 17 Pro",
  platform: "iOS Simulator",
  osVersion: "26.0",
  state: "Booted",
};
test("formats renamed simulators, avoids duplicate model names, and searches model metadata", () => {
  expect(destinationName(destination)).toBe("QA Phone · iPhone 17 Pro");
  expect(destinationName({ ...destination, name: "iPhone 17 Pro" })).toBe(
    "iPhone 17 Pro",
  );
  expect(destinationName({ ...destination, deviceType: undefined })).toBe(
    "QA Phone",
  );
  expect(filterDestinations([destination], "17 pro", (key) => key)).toEqual([
    destination,
  ]);
});
test("start picker shows shared two-line labels and has no run buttons", () => {
  render(
    <BuildDestinationPicker
      id="destinations"
      destinations={[destination]}
      value="sim-1"
      loading={false}
      onChange={() => undefined}
    />,
  );
  const trigger = screen.getByRole("combobox");
  expect(trigger.textContent).toContain("QA Phone · iPhone 17 Pro");
  expect(trigger.textContent).toContain("iOS Simulator 26.0 · Booted");
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  expect(
    screen.getByRole("option", { name: /QA Phone.*iPhone 17 Pro/ }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: /^Run on/ })).toBeNull();
});
