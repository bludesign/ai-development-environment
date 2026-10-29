import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraAvailableProject } from "@/services/jira/types";

import { JiraAvailableProjectSelect } from "./available-project-select";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const project = (
  jiraId: string,
  key: string,
  name: string,
): JiraAvailableProject => ({
  jiraId,
  key,
  name,
  avatarUrl: null,
});
const page = (
  items: JiraAvailableProject[],
  nextStartAt: number | null = null,
  startAt = 0,
) => ({
  jiraAvailableProjectPage: {
    items,
    total: 100,
    startAt,
    maxResults: 25,
    nextStartAt,
  },
});

function deferred() {
  let resolve!: (value: ReturnType<typeof page>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReturnType<typeof page>>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

function Picker({
  initialValue = null,
  managedProjectIds = [],
  onChange,
}: {
  initialValue?: JiraAvailableProject | null;
  managedProjectIds?: string[];
  onChange?: (project: JiraAvailableProject) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <JiraAvailableProjectSelect
      value={value}
      onValueChange={(nextValue) => {
        setValue(nextValue);
        onChange?.(nextValue);
      }}
      managedProjectIds={managedProjectIds}
    />
  );
}

async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function trigger() {
  return screen.getByRole("combobox", { name: "Available Jira projects" });
}
function open() {
  fireEvent.click(trigger());
  return screen.getByRole("combobox", {
    name: "Search projects by key or name…",
  });
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

describe("JiraAvailableProjectSelect", () => {
  test("loads eagerly and keeps the trigger spinner visible with the picker closed or open", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise as never);
    render(<Picker />);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(
      within(trigger()).getByRole("status", { name: "Loading Jira projects…" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("combobox", {
        name: "Search projects by key or name…",
      }),
    ).toBeNull();
    await advance();
    expect(request.mock.calls[0]?.[1]).toEqual({
      search: null,
      startAt: 0,
      maxResults: 25,
    });

    open();
    expect(
      within(trigger()).getByRole("status", { name: "Loading Jira projects…" }),
    ).toBeDefined();
    expect(screen.getByText("Loading Jira projects…")).toBeDefined();
    await act(async () =>
      pending.resolve(page([project("mobile", "MOB", "Mobile")])),
    );
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("option", { name: "MOB · Mobile" })).toBeDefined();
  });

  test("debounces server searches, ignores whitespace-only changes, and clears search without the debounce delay", async () => {
    request.mockResolvedValue(
      page([project("remote", "EXT", "External project")]) as never,
    );
    render(<Picker />);
    await advance();
    const input = open();
    fireEvent.change(input, { target: { value: "mo" } });
    await advance(200);
    fireEvent.change(input, { target: { value: "mobile" } });
    await advance(299);
    expect(request).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    await advance(1);
    expect(request.mock.calls[1]?.[1]).toEqual({
      search: "mobile",
      startAt: 0,
      maxResults: 25,
    });
    expect(
      screen.getByRole("option", { name: "EXT · External project" }),
    ).toBeDefined();

    fireEvent.change(input, { target: { value: " mobile " } });
    await advance(400);
    expect(request).toHaveBeenCalledTimes(2);
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    fireEvent.change(input, { target: { value: " " } });
    await advance();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({
      search: null,
      startAt: 0,
      maxResults: 25,
    });
  });

  test("aborts superseded requests and ignores their results, errors, and loading completion", async () => {
    const initial = deferred();
    const oldSearch = deferred();
    const currentSearch = deferred();
    request
      .mockReturnValueOnce(initial.promise as never)
      .mockReturnValueOnce(oldSearch.promise as never)
      .mockReturnValueOnce(currentSearch.promise as never);
    render(<Picker />);
    await advance();
    const input = open();
    const initialSignal = request.mock.calls[0]?.[2]?.signal;
    fireEvent.change(input, { target: { value: "old" } });
    expect(initialSignal?.aborted).toBe(true);
    await advance(300);
    await act(async () =>
      initial.resolve(page([project("stale", "OLD", "Stale result")])),
    );
    expect(
      screen.queryByRole("option", { name: "OLD · Stale result" }),
    ).toBeNull();
    expect(trigger().getAttribute("aria-busy")).toBe("true");

    const oldSignal = request.mock.calls[1]?.[2]?.signal;
    fireEvent.change(input, { target: { value: "current" } });
    expect(oldSignal?.aborted).toBe(true);
    await advance(300);
    await act(async () => oldSearch.reject(new Error("Old request failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    await act(async () =>
      currentSearch.resolve(
        page([project("current", "NOW", "Current result")]),
      ),
    );
    expect(
      screen.getByRole("option", { name: "NOW · Current result" }),
    ).toBeDefined();
    expect(trigger().getAttribute("aria-busy")).toBe("false");
  });

  test("continues past a page containing only managed projects and deduplicates later pages", async () => {
    request
      .mockResolvedValueOnce(
        page([project("managed", "OWN", "Managed")], 25) as never,
      )
      .mockResolvedValueOnce(
        page(
          [
            project("first", "ONE", "First"),
            project("managed", "OWN", "Managed"),
          ],
          50,
          25,
        ) as never,
      )
      .mockResolvedValueOnce(
        page(
          [
            project("first", "ONE", "First updated"),
            project("second", "TWO", "Second"),
          ],
          null,
          50,
        ) as never,
      );
    render(<Picker managedProjectIds={["managed"]} />);
    await advance();
    open();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(
      screen.queryByText("No matching projects available to add."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more projects" }));
    await advance();
    expect(request.mock.calls[1]?.[1]).toEqual({
      search: null,
      startAt: 25,
      maxResults: 25,
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more projects" }));
    await advance();
    expect(request.mock.calls[2]?.[1]).toEqual({
      search: null,
      startAt: 50,
      maxResults: 25,
    });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(
      screen.getAllByRole("option", { name: "ONE · First updated" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "OWN · Managed" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Load more projects" }),
    ).toBeNull();
  });

  test("Enter on Load more preserves the highlighted project and allows native button activation", async () => {
    const onChange = vi.fn();
    request
      .mockResolvedValueOnce(
        page([project("first", "ONE", "First")], 25) as never,
      )
      .mockResolvedValueOnce(
        page([project("second", "TWO", "Second")], null, 25) as never,
      );
    render(<Picker onChange={onChange} />);
    await advance();
    fireEvent.keyDown(open(), { key: "ArrowDown" });
    expect(
      screen
        .getByRole("option", { name: "ONE · First" })
        .getAttribute("data-selected"),
    ).toBe("true");
    const loadMore = screen.getByRole("button", { name: "Load more projects" });
    act(() => loadMore.focus());
    const enter = createEvent.keyDown(loadMore, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent(loadMore, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(request).toHaveBeenCalledTimes(1);

    // jsdom does not synthesize native button activation from the key event.
    fireEvent.click(loadMore);
    await advance();
    expect(request.mock.calls[1]?.[1]).toEqual({
      search: null,
      startAt: 25,
      maxResults: 25,
    });
    expect(screen.getByRole("option", { name: "TWO · Second" })).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("preserves loaded results after a continuation error and allows Enter to activate Retry", async () => {
    const onChange = vi.fn();
    request
      .mockResolvedValueOnce(
        page([project("first", "ONE", "First")], 25) as never,
      )
      .mockRejectedValueOnce(new Error("Jira unavailable"))
      .mockResolvedValueOnce(
        page([project("second", "TWO", "Second")], null, 25) as never,
      );
    render(<Picker onChange={onChange} />);
    await advance();
    fireEvent.keyDown(open(), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Load more projects" }));
    await advance();
    expect(screen.getByRole("alert").textContent).toContain(
      "Projects could not be loaded",
    );
    expect(screen.getByRole("option", { name: "ONE · First" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Load more projects" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("option", { name: "ONE · First" })
        .getAttribute("data-selected"),
    ).toBe("true");
    const retry = screen.getByRole("button", { name: "Retry" });
    act(() => retry.focus());
    const enter = createEvent.keyDown(retry, { key: "Enter", code: "Enter" });
    fireEvent(retry, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // jsdom does not synthesize native button activation from the key event.
    fireEvent.click(retry);
    await advance();
    expect(request.mock.calls[2]?.[1]).toEqual({
      search: null,
      startAt: 25,
      maxResults: 25,
    });
    expect(screen.getByRole("option", { name: "ONE · First" })).toBeDefined();
    expect(screen.getByRole("option", { name: "TWO · Second" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("retries the initial page after an error instead of showing an empty result", async () => {
    request
      .mockRejectedValueOnce(new Error("Jira unavailable"))
      .mockResolvedValueOnce(page([project("first", "ONE", "First")]) as never);
    render(<Picker />);
    await advance();
    open();
    expect(screen.getByRole("alert")).toBeDefined();
    expect(
      screen.queryByText("No matching projects available to add."),
    ).toBeNull();
    expect(trigger().getAttribute("aria-busy")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance();
    expect(request.mock.calls[1]?.[1]).toEqual({
      search: null,
      startAt: 0,
      maxResults: 25,
    });
    expect(screen.getByRole("option", { name: "ONE · First" })).toBeDefined();
  });

  test("retains the controlled selection label across searches and supports keyboard selection", async () => {
    const selected = project("selected", "SEL", "Selected project");
    const next = project("next", "NEXT", "Next project");
    const onChange = vi.fn();
    request
      .mockResolvedValueOnce(page([]) as never)
      .mockResolvedValueOnce(page([next]) as never)
      .mockResolvedValueOnce(page([]) as never);
    render(<Picker initialValue={selected} onChange={onChange} />);
    await advance();
    const input = open();
    expect(
      screen.getByRole("option", { name: "SEL · Selected project" }),
    ).toBeDefined();
    fireEvent.change(input, { target: { value: "next" } });
    await advance(300);
    expect(trigger().textContent).toContain("SEL · Selected project");
    expect(
      screen.queryByRole("option", { name: "SEL · Selected project" }),
    ).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(next);
    expect(trigger().textContent).toContain("NEXT · Next project");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    const reopened = open();
    fireEvent.change(reopened, { target: { value: "" } });
    await advance();
    expect(trigger().textContent).toContain("NEXT · Next project");
    expect(
      screen
        .getByRole("option", { name: "NEXT · Next project" })
        .getAttribute("data-checked"),
    ).toBe("true");
  });

  test("cancels in-flight discovery and pending search timers when unmounted", async () => {
    const pending = deferred();
    request.mockReturnValue(pending.promise as never);
    const mounted = render(<Picker />);
    await advance();
    const signal = request.mock.calls[0]?.[2]?.signal;
    mounted.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve(page([project("late", "LATE", "Late result")])),
    );

    request.mockClear();
    const searching = render(<Picker />);
    await advance();
    fireEvent.change(open(), { target: { value: "pending search" } });
    searching.unmount();
    await advance(300);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
