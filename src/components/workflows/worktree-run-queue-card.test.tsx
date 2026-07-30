import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { WorktreeRunQueueCard } from "./worktree-run-queue-card";

describe("WorktreeRunQueueCard", () => {
  test("spaces the empty state evenly below the header", () => {
    render(<WorktreeRunQueueCard entries={[]} scope="WORKTREE" />);

    const card = screen
      .getByText("Worktree queue")
      .closest<HTMLElement>('[data-slot="card"]');
    const content = card?.querySelector<HTMLElement>(
      '[data-slot="card-content"]',
    );

    expect(content?.className).toContain("py-6");
  });
});
