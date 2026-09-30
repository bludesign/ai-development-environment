// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { serverUrlFixture } from "../../test/fixtures/server-urls";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: mocks.request,
  controlPlaneSubscriptions: () => ({ subscribe: mocks.subscribe }),
}));
import { useServerUrlSettings } from "./use-server-url-settings";
beforeEach(() => {
  mocks.request.mockReset();
  mocks.subscribe.mockReturnValue(mocks.dispose);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function deferredSettings() {
  let resolve!: (value: { serverUrlSettings: typeof serverUrlFixture }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ serverUrlSettings: typeof serverUrlFixture }>(
    (yes, no) => {
      resolve = yes;
      reject = no;
    },
  );
  return { promise, resolve, reject };
}

test("shares loading and refetches every consumer after a settings notification", async () => {
  mocks.request.mockResolvedValue({ serverUrlSettings: serverUrlFixture });
  mocks.subscribe.mockReturnValue(mocks.dispose);
  const first = renderHook(useServerUrlSettings);
  const second = renderHook(useServerUrlSettings);
  await waitFor(() =>
    expect(first.result.current.settings).toEqual(serverUrlFixture),
  );
  expect(second.result.current.settings).toEqual(serverUrlFixture);
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  mocks.request.mockResolvedValue({
    serverUrlSettings: {
      ...serverUrlFixture,
      proxyBaseUrl: "https://changed.ts.net",
    },
  });
  await act(async () => {
    mocks.subscribe.mock.calls[0]![1].next({
      data: { serverUrlSettingsChanged: { updatedAt: "later" } },
    });
  });
  await waitFor(() =>
    expect(second.result.current.settings?.proxyBaseUrl).toBe(
      "https://changed.ts.net",
    ),
  );
  first.unmount();
  expect(mocks.dispose).not.toHaveBeenCalled();
  second.unmount();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

test.each(["success", "failure"])(
  "refetches all consumers when settings change during a pending read that ends in %s",
  async (outcome) => {
    const initialRead = deferredSettings();
    const trailingRead = deferredSettings();
    const updated = {
      ...serverUrlFixture,
      proxyBaseUrl: "https://updated.ts.net",
    };
    mocks.request
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(trailingRead.promise);
    const first = renderHook(useServerUrlSettings);
    const second = renderHook(useServerUrlSettings);
    expect(mocks.request).toHaveBeenCalledOnce();

    await act(async () => {
      const sink = mocks.subscribe.mock.calls[0]![1];
      for (let index = 0; index < 3; index++) {
        sink.next({
          data: { serverUrlSettingsChanged: { updatedAt: "later" } },
        });
      }
      if (outcome === "failure") initialRead.reject(new Error("offline"));
      else initialRead.resolve({ serverUrlSettings: serverUrlFixture });
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);

    await act(async () => {
      trailingRead.resolve({ serverUrlSettings: updated });
    });
    expect(first.result.current.settings).toEqual(updated);
    expect(second.result.current.settings).toEqual(updated);
    expect(first.result.current.error).toBeNull();
    expect(second.result.current.error).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  },
);
