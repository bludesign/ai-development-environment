import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import Home from "@/app/[locale]/page";

test("renders the repository README", () => {
  render(<Home />);

  expect(
    screen.getByRole("heading", {
      level: 1,
      name: "AI Development Environment",
    }),
  ).toBeDefined();
  expect(
    screen.getByRole("heading", { level: 2, name: "GraphQL API" }),
  ).toBeDefined();
});
