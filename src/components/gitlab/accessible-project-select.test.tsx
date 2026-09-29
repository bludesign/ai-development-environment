import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { GitLabAccessibleProjectSelect } from "./accessible-project-select";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const project = (id: string, pathWithNamespace: string) => ({
  id,
  pathWithNamespace,
});
const page = (
  items: ReturnType<typeof project>[],
  nextPage: number | null = null,
) => ({
  gitlabAccessibleProjects: {
    items,
    page: 1,
    perPage: 25,
    total: items.length,
    nextPage,
  },
});

function Picker() {
  const [value, setValue] = useState("");
  return (
    <GitLabAccessibleProjectSelect
      value={value}
      onChange={setValue}
      knownProjects={[project("managed", "acme/managed")]}
    />
  );
}

async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function open() {
  fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
  return screen.getByRole("combobox", { name: "Search accessible projects…" });
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GitLabAccessibleProjectSelect", () => {
  test("loads only on open, debounces server search, pages results and retains the selected project", async () => {
    request.mockImplementation(async (_query, variables) => {
      const input = variables as { search: string | null; page: number };
      if (input.page === 2)
        return page([
          project("remote", "outside/mobile"),
          project("more", "outside/desktop"),
        ]) as never;
      return page([project("remote", "outside/mobile")], 2) as never;
    });
    render(<Picker />);
    expect(request).not.toHaveBeenCalled();
    const input = open();
    await advance();
    expect(request.mock.calls[0]?.[1]).toEqual({
      search: null,
      page: 1,
      perPage: 25,
    });
    fireEvent.change(input, { target: { value: "out" } });
    await advance(200);
    fireEvent.change(input, { target: { value: "outside" } });
    await advance(299);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(request.mock.calls[1]?.[1]).toEqual({
      search: "outside",
      page: 1,
      perPage: 25,
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more projects" }));
    await advance();
    expect(request.mock.calls[2]?.[1]).toEqual({
      search: "outside",
      page: 2,
      perPage: 25,
    });
    expect(
      screen.getAllByRole("option", { name: "outside/mobile" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "outside/desktop" }));
    expect(
      screen.getByRole("combobox", { name: "Project" }).textContent,
    ).toContain("outside/desktop");
    request.mockResolvedValue(page([]) as never);
    open();
    await advance();
    expect(
      screen.getByRole("option", { name: "outside/desktop" }),
    ).toBeDefined();
    expect(screen.getByRole("option", { name: "acme/managed" })).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: "All projects" }));
    expect(
      screen.getByRole("combobox", { name: "Project" }).textContent,
    ).toContain("All projects");
  });

  test("aborts superseded requests and rejects stale results even when transport ignores cancellation", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    request.mockImplementation(async (_query, variables) => {
      if (!(variables as { search: string }).search)
        return new Promise((resolve) => {
          resolveOld = resolve;
        }) as never;
      return page([project("new", "team/new")]) as never;
    });
    render(<Picker />);
    const input = open();
    await advance();
    const signal = request.mock.calls[0]?.[2]?.signal;
    fireEvent.change(input, { target: { value: "new" } });
    expect(signal?.aborted).toBe(true);
    await advance(300);
    await act(async () => resolveOld(page([project("old", "team/stale")])));
    expect(screen.getByRole("option", { name: "team/new" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "team/stale" })).toBeNull();
    fireEvent.change(input, { target: { value: " new " } });
    await advance(400);
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("keeps loaded pages on a failed continuation and retries that page", async () => {
    let secondPageAttempts = 0;
    request.mockImplementation(async (_query, variables) => {
      if ((variables as { page: number }).page === 1)
        return page([project("first", "team/first")], 2) as never;
      if (secondPageAttempts++ === 0) throw new Error("GitLab unavailable");
      return page([project("second", "team/second")]) as never;
    });
    render(<Picker />);
    open();
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Load more projects" }));
    await advance();
    expect(screen.getByRole("alert").textContent).toContain(
      "Projects could not be loaded",
    );
    expect(screen.getByRole("option", { name: "team/first" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance();
    expect(screen.getByRole("option", { name: "team/second" })).toBeDefined();
    expect(request.mock.calls.at(-1)?.[1]).toEqual({
      search: null,
      page: 2,
      perPage: 25,
    });
  });
});
