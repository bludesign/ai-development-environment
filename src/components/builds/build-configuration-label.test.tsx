import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { BuildConfigurationLabel } from "./build-configuration-label";

afterEach(cleanup);
test("captured configuration names survive renaming and deletion without broken links", () => {
  const snapshot = {
    configuration: { kind: "SAVED", name: "Captured Release" },
  };
  const { rerender } = render(
    <BuildConfigurationLabel
      build={{
        snapshot,
        configuration: { id: "configuration-1", name: "Renamed" } as never,
      }}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Captured Release" }).getAttribute("href"),
  ).toContain("/dashboard/builds/configurations/configuration-1");
  rerender(
    <BuildConfigurationLabel build={{ snapshot, configuration: null }} />,
  );
  expect(screen.getByText("Captured Release")).toBeDefined();
  expect(screen.queryByRole("link")).toBeNull();
});
test("only the explicit marker labels a build as Custom", () => {
  const { rerender } = render(
    <BuildConfigurationLabel
      build={{
        snapshot: { configuration: { kind: "CUSTOM" } },
        configuration: null,
      }}
    />,
  );
  expect(screen.getByText("Custom")).toBeDefined();
  rerender(
    <BuildConfigurationLabel
      build={{ snapshot: { source: "LCOV" }, configuration: null }}
    />,
  );
  expect(screen.queryByText("Custom")).toBeNull();
});
