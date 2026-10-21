import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(async () => {
  cleanup();
  // Radix FocusScope restores focus on a zero-delay timer after unmount.
  // Keep jsdom's Event globals alive until that callback finishes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
