import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(async () => {
  cleanup();
  // Radix FocusScope restores focus on a zero-delay timer after unmount.
  // Keep jsdom's Event globals alive until that callback finishes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

// jsdom does not implement media queries; responsive components use the desktop viewport by default.
if (typeof window !== "undefined")
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
