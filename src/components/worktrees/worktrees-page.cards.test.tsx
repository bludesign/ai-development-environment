import { vi } from "vitest";

import { registerWorktreesPageTests } from "./worktrees-page.cases";

// Exercise the operation count with the production ICU plural formatter.
vi.mock("next-intl", async (importOriginal) => {
  const original = await importOriginal<typeof import("next-intl")>();
  const { createTranslator } = await import("use-intl/core");
  const { default: messages } = await import("../../../messages/en.json");
  return {
    ...original,
    useTranslations: (namespace?: string) =>
      namespace === "worktrees.activeOperations"
        ? createTranslator({ locale: "en", messages, namespace })
        : original.useTranslations(namespace),
  };
});

// Card tests cover the operation controls, not job polling. A real poll timer
// can outlive jsdom teardown and dispatch a React update after `window` is gone.
vi.mock("./worktree-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worktree-jobs")>()),
  waitForWorktreeOperationJob: vi.fn().mockResolvedValue(null),
}));

registerWorktreesPageTests("cards");
