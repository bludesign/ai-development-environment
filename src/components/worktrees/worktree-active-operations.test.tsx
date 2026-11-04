import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AgentJob } from "@/components/agents/types";

import { WorktreeActiveOperations } from "./worktree-active-operations";

// Exercise the catalog's ICU count message, which the shared string-only
// next-intl fixture does not format.
vi.mock("next-intl", async (importOriginal) => {
  const original = await importOriginal<typeof import("next-intl")>();
  const { createTranslator } = await import("use-intl/core");
  const { default: messages } = await import("../../../messages/en.json");
  return {
    ...original,
    useTranslations: (namespace: "worktrees.activeOperations") =>
      createTranslator({ locale: "en", messages, namespace }),
  };
});

function job(id: string, changes: Partial<AgentJob> = {}): AgentJob {
  return {
    id,
    agentId: "agent",
    kind: "command.run",
    commandName: `Command ${id}`,
    payload: {},
    status: "RUNNING",
    error: null,
    result: null,
    timeoutSeconds: 0,
    createdAt: "2026-11-04T12:00:00Z",
    startedAt: "2026-11-04T12:00:00Z",
    finishedAt: null,
    updatedAt: "2026-11-04T12:00:00Z",
    ...changes,
  };
}

function operations(jobs: AgentJob[]) {
  return (
    <WorktreeActiveOperations
      worktree={{ activeJobs: jobs, activeJob: null }}
    />
  );
}

test("renders nothing for no jobs and respects an explicitly empty activeJobs list", () => {
  const { container, rerender } = render(operations([]));
  expect(container.textContent).toBe("");
  rerender(
    <WorktreeActiveOperations
      worktree={{ activeJobs: [], activeJob: job("legacy") }}
    />,
  );
  expect(container.textContent).toBe("");
});

test("shows a named operation and retains the legacy activeJob fallback", () => {
  const navigate = vi.fn();
  const { rerender } = render(
    <div onClick={navigate}>
      <WorktreeActiveOperations
        worktree={{ activeJob: job("dev", { commandName: "Run dev" }) }}
      />
    </div>,
  );
  const link = screen.getByRole("link", {
    name: "Command: Run dev",
  });
  expect(link.getAttribute("href")).toBe("/dashboard/jobs/dev");
  expect(link.getAttribute("title")).toBe("command.run");
  expect(link.querySelector('[data-slot="badge"]')).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(navigate).not.toHaveBeenCalled();

  for (const [status, label] of [
    ["QUEUED", "Queued"],
    ["CANCELLING", "Cancelling"],
  ] as const) {
    rerender(operations([job("dev", { commandName: "Run dev", status })]));
    const badge = within(screen.getByRole("link")).getByText(label);
    expect(badge.getAttribute("data-variant")).toBe("secondary");
  }
});

test("opens all operations in their current order without navigating the worktree", async () => {
  const navigate = vi.fn();
  render(
    <div onClick={navigate}>
      {operations([
        job("dev", { commandName: "Run dev" }),
        job("sync", {
          kind: "worktree.operation",
          payload: { operation: "SYNC" },
          status: "QUEUED",
        }),
        job("tests", {
          kind: "ios.build.run",
          payload: { action: "TEST", scheme: "AIDE" },
          status: "CANCELLING",
        }),
      ])}
    </div>,
  );

  expect(screen.queryByRole("link")).toBeNull();
  const trigger = screen.getByRole("button", { name: "3 operations" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);

  const dialog = await screen.findByRole("dialog", {
    name: "Active operations",
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(within(dialog).getByRole("heading").textContent).toBe(
    "Active operations",
  );
  const links = within(dialog).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Command: Run dev Running",
    "Sync Queued",
    "Test: AIDE Cancelling",
  ]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/dashboard/jobs/dev",
    "/dashboard/jobs/sync",
    "/dashboard/jobs/tests",
  ]);
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
  for (const link of links) {
    expect(
      link.querySelector('[data-slot="badge"]')?.getAttribute("data-variant"),
    ).toBe("default");
  }
  links[1].addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(links[1]);
  fireEvent.click(within(dialog).getByRole("heading"));
  expect(navigate).not.toHaveBeenCalled();
});

test("dismisses with Escape and restores focus to the count trigger", async () => {
  render(operations([job("one"), job("two")]));
  const trigger = screen.getByRole("button", { name: "2 operations" });
  trigger.focus();
  // A native button activation (including Enter/Space) dispatches click.
  fireEvent.click(trigger);
  fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("dismisses when clicking outside the popover", async () => {
  render(
    <>
      <button type="button">Outside</button>
      {operations([job("one"), job("two")])}
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "2 operations" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  // Radix registers its outside-pointer listener on the next task.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  const outside = screen.getByRole("button", { name: "Outside" });
  fireEvent.pointerDown(outside, {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(outside);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("updates open rows and counts, then closes and resets when only one job remains", async () => {
  const first = job("first");
  const second = job("second");
  const third = job("third");
  const { rerender } = render(operations([first, second, third]));
  fireEvent.click(screen.getByRole("button", { name: "3 operations" }));
  await screen.findByRole("dialog");

  rerender(operations([first, third]));
  expect(screen.getByRole("button", { name: "2 operations" })).toBeDefined();
  expect(
    within(screen.getByRole("dialog")).getAllByRole("listitem"),
  ).toHaveLength(2);
  expect(screen.queryByText("Command: Command second")).toBeNull();

  rerender(operations([first]));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("link").textContent).toBe("Command: Command first");

  rerender(operations([first, second]));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "2 operations" })
      .getAttribute("aria-expanded"),
  ).toBe("false");

  rerender(operations([]));
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

test("keeps all entries available for a long list and permits long names to wrap", async () => {
  const name = "A".repeat(300);
  render(
    operations(
      Array.from({ length: 20 }, (_, index) =>
        job(String(index), { commandName: name }),
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "20 operations" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(20);
  expect(dialog.className).toContain("overflow-y-auto");
  expect(dialog.className).toContain("calc(100vw-1rem)");
  expect(
    dialog.querySelector("[class*='overflow-wrap:anywhere']"),
  ).not.toBeNull();
});
