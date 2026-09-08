import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  recovery: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./control-plane-client", () => ({
  controlPlaneRequest: mocks.request,
  controlPlaneSubscriptions: () => ({ subscribe: mocks.subscribe }),
  onControlPlaneRecovery: mocks.recovery,
}));
import {
  clearIntegrationConfigurationCache,
  readIntegrationConfiguration,
  subscribeIntegrationConfiguration,
} from "./integration-configuration";
let dispose: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  clearIntegrationConfigurationCache();
  mocks.subscribe.mockReturnValue(mocks.close);
  mocks.recovery.mockReturnValue(vi.fn());
});
afterEach(() => {
  dispose.forEach((fn) => fn());
  dispose = [];
});
describe("integration configuration cache", () => {
  test("reuses configuration while a session subscriber remains, and invalidates only the changed provider", async () => {
    const github = vi.fn();
    const gitlab = vi.fn();
    dispose.push(
      subscribeIntegrationConfiguration("github", github),
      subscribeIntegrationConfiguration("gitlab", gitlab),
    );
    mocks.request.mockResolvedValue({ configured: true });
    await readIntegrationConfiguration("github", "query G {}");
    await readIntegrationConfiguration("gitlab", "query L {}");
    await readIntegrationConfiguration("github", "query G {}");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.subscribe.mock.calls[0][1].next({
      data: { integrationConfigurationChanged: "github" },
    });
    expect(github).toHaveBeenCalledTimes(1);
    expect(gitlab).not.toHaveBeenCalled();
    await readIntegrationConfiguration("gitlab", "query L {}");
    await readIntegrationConfiguration("github", "query G {}");
    expect(mocks.request).toHaveBeenCalledTimes(3);
    mocks.recovery.mock.calls[0][0]();
    expect(github).toHaveBeenCalledTimes(2);
    expect(gitlab).toHaveBeenCalledTimes(1);
  });
  test("does not cache a pre-invalidation response or a failed read", async () => {
    let resolve!: (v: unknown) => void;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce({ version: 2 });
    const pending = readIntegrationConfiguration("github", "query G {}");
    clearIntegrationConfigurationCache("github");
    resolve({ version: 1 });
    expect(await pending).toEqual({ version: 2 });
    clearIntegrationConfigurationCache();
    mocks.request
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ version: 3 });
    await expect(
      readIntegrationConfiguration("github", "query G {}"),
    ).rejects.toThrow("offline");
    expect(await readIntegrationConfiguration("github", "query G {}")).toEqual({
      version: 3,
    });
  });
  test("clears session data when its last consumer leaves and does not retain an aborted response", async () => {
    const off = subscribeIntegrationConfiguration(null, vi.fn());
    let resolve!: (v: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const pending = readIntegrationConfiguration("github", "query G {}", {
      signal: controller.signal,
    });
    controller.abort();
    resolve({ version: 1 });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    mocks.request.mockResolvedValue({ version: 2 });
    await readIntegrationConfiguration("github", "query G {}");
    off();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await readIntegrationConfiguration("github", "query G {}");
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });
});
