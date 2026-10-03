import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  BreadcrumbLabelsProvider,
  useBreadcrumbLabel,
  useBreadcrumbLabels,
} from "./breadcrumb-labels-provider";
import { buildAppBreadcrumbs } from "@/lib/breadcrumbs";

function Publisher({ id, title }: { id?: string; title?: string }) {
  useBreadcrumbLabel(["dashboard", "apps", id], title);
  return null;
}

function Trail({ pathname }: { pathname: string }) {
  const labels = useBreadcrumbLabels();
  return (
    <output data-testid="trail">
      {buildAppBreadcrumbs(pathname, (key) => key, labels)
        .map(({ label }) => label)
        .join(" > ")}
    </output>
  );
}

afterEach(cleanup);

describe("BreadcrumbLabelsProvider", () => {
  test("updates loaded titles and never applies another record's title on navigation", () => {
    function Page({
      pathname,
      id,
      title,
    }: {
      pathname: string;
      id?: string;
      title?: string;
    }) {
      return (
        <BreadcrumbLabelsProvider>
          <Trail pathname={pathname} />
          <Publisher id={id} title={title} />
        </BreadcrumbLabelsProvider>
      );
    }
    const first = "/dashboard/apps/first";
    const second = "/dashboard/apps/second";
    const page = render(<Page pathname={first} />);
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > first",
    );

    page.rerender(<Page pathname={first} id="first" title="First app" />);
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > First app",
    );
    page.rerender(<Page pathname={first} id="first" title="Renamed app" />);
    expect(screen.getByTestId("trail").textContent).toContain("Renamed app");

    page.rerender(<Page pathname={second} id="first" title="Renamed app" />);
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > second",
    );
    page.rerender(<Page pathname={second} id="second" title="Second app" />);
    expect(screen.getByTestId("trail").textContent).toContain("Second app");
    // A late response for the previous record remains scoped to that record.
    page.rerender(<Page pathname={second} id="first" title="Late first app" />);
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > second",
    );
  });

  test("cleans up each publisher independently, including in Strict Mode", () => {
    function Page({ first, second }: { first: boolean; second: boolean }) {
      return (
        <StrictMode>
          <BreadcrumbLabelsProvider>
            <Trail pathname="/dashboard/apps/shared" />
            {first && <Publisher key="first" id="shared" title="First title" />}
            {second && (
              <Publisher key="second" id="shared" title="Second title" />
            )}
          </BreadcrumbLabelsProvider>
        </StrictMode>
      );
    }
    const page = render(<Page first second={false} />);
    page.rerender(<Page first second />);
    expect(screen.getByTestId("trail").textContent).toContain("Second title");
    page.rerender(<Page first={false} second />);
    expect(screen.getByTestId("trail").textContent).toContain("Second title");
    page.rerender(<Page first={false} second={false} />);
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > shared",
    );
  });

  test("encodes IDs and ignores missing or empty labels", () => {
    const page = render(
      <BreadcrumbLabelsProvider>
        <Trail pathname="/dashboard/apps/app%2Fwith%20spaces?view=worktrees" />
        <Publisher id="app/with spaces" title="  My app  " />
      </BreadcrumbLabelsProvider>,
    );
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > My app",
    );
    page.rerender(
      <BreadcrumbLabelsProvider>
        <Trail pathname="/dashboard/apps/app%2Fwith%20spaces" />
        <Publisher id="app/with spaces" title=" " />
        <Publisher title="Unloaded record" />
      </BreadcrumbLabelsProvider>,
    );
    expect(screen.getByTestId("trail").textContent).toBe(
      "dashboard > apps > app/with spaces",
    );
  });

  test("allows detail components to render without the app shell", () => {
    expect(() => render(<Publisher id="app" title="My app" />)).not.toThrow();
  });
});
