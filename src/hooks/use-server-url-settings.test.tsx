// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
