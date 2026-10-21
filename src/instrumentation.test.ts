// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  start: vi.fn(),
}));

vi.mock("./server/initialize-app-secret", () => ({
  initializeAppSecret: mocks.initialize,
}));
vi.mock("./instrumentation-node", () => ({
  startAgentWebSocketServer: mocks.start,
}));

import { register } from "./instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("server instrumentation", () => {
  test("resolves the secret before starting application services", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.initialize.mockImplementation(async () => {
      expect(mocks.start).not.toHaveBeenCalled();
    });
    await register();
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  test("does not start services when secret initialization fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.initialize.mockRejectedValue(new Error("Keychain unavailable"));
    await expect(register()).rejects.toThrow("Keychain unavailable");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  test("does not initialize Node services in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
