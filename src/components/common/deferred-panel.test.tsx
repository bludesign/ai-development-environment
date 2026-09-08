import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DeferredPanel } from "./deferred-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("starts panel work only near view and retains edits after leaving view", () => {
  let notify!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const read = vi.fn();
  function Panel() {
    const [value, setValue] = useState("");
    useEffect(() => {
      read();
    }, []);
    return (
      <input
        aria-label="Draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  }
  render(
    <DeferredPanel>
      <Panel />
    </DeferredPanel>,
  );
  expect(read).not.toHaveBeenCalled();
  act(() =>
    notify(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "unsaved" },
  });
  act(() =>
    notify(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("unsaved");
  expect(read).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalled();
});
