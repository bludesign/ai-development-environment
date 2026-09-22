import { vi } from "vitest";

import { registerWorktreesPageTests } from "./worktrees-page.cases";

// Card tests cover the operation controls, not job polling. A real poll timer
// can outlive jsdom teardown and dispatch a React update after `window` is gone.
vi.mock("./worktree-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worktree-jobs")>()),
  waitForWorktreeOperationJob: vi.fn().mockResolvedValue(null),
}));

registerWorktreesPageTests("cards");
