import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Card, CardContent, CardHeader, CardTitle } from "./card";

afterEach(() => {
  cleanup();
});

const header = () => screen.getByTestId("header");

describe("CardHeader", () => {
  test("renders the tinted band and a divider when content follows", () => {
    render(
      <Card>
        <CardHeader data-testid="header">
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );

    expect(header().className).toContain("bg-muted/40");
    expect(header().className).toContain("not-last:border-b");
    expect(header().nextElementSibling).not.toBeNull();
  });

  test("is the last child when a collapsible card unmounts its content", () => {
    render(
      <Card>
        <CardHeader data-testid="header">
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        {false && <CardContent>body</CardContent>}
      </Card>,
    );

    // `not-last:border-b` resolves to no border here, so the band does not
    // double against the card's bottom ring.
    expect(header().nextElementSibling).toBeNull();
  });

  test("sits flush to the top edge by zeroing the card's top padding", () => {
    render(
      <Card data-testid="card">
        <CardHeader data-testid="header">
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );

    expect(screen.getByTestId("card").className).toContain(
      "has-[>[data-slot=card-header]]:pt-0",
    );
  });

  test("inherits --card-spacing so size=sm gets tighter padding", () => {
    render(
      <Card data-testid="card" size="sm">
        <CardHeader data-testid="header">
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );

    expect(screen.getByTestId("card").getAttribute("data-size")).toBe("sm");
    expect(screen.getByTestId("card").className).toContain(
      "data-[size=sm]:[--card-spacing:--spacing(3)]",
    );
    expect(header().className).toContain("py-(--card-spacing)");
    expect(header().className).not.toContain("py-4");
  });

  test("lets a call site opt out of the tint", () => {
    render(
      <Card>
        <CardHeader className="bg-transparent" data-testid="header">
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );

    expect(header().className).toContain("bg-transparent");
    expect(header().className).not.toContain("bg-muted/40");
  });
});
