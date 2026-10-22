import { beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  ensure: vi.fn(),
  stop: vi.fn(),
  discover: vi.fn(),
  headers: vi.fn(),
  make: vi.fn(),
  lookup: vi.fn(),
  info: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute,
  }),
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), rm: vi.fn() }));
vi.mock("../config.js", () => ({
  configPath: () => "/tmp/control/config.json",
}));
vi.mock("../executable-lookup.js", () => ({ findExecutable: mocks.lookup }));
vi.mock("@opencode/client", () => ({ OpenCode: { make: mocks.make } }));
vi.mock("@opencode/client/service", () => ({
  Service: {
    ensure: mocks.ensure,
    stop: mocks.stop,
    discover: mocks.discover,
    headers: mocks.headers,
  },
}));
import {
  OpenCodeRuntime,
  sharedOpenCodeClient,
  supportedOpenCodeVersion,
} from "./opencode-runtime.js";
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.lookup.mockReturnValue("/opt/homebrew/bin/opencode");
  mocks.execute.mockResolvedValue({ stdout: "opencode v2.1.1\n" });
  mocks.ensure.mockResolvedValue({
    url: "http://127.0.0.1:12345",
    auth: { type: "basic", username: "opencode", password: "test" },
  });
  mocks.headers.mockReturnValue({ authorization: "Basic test" });
  mocks.info.mockResolvedValue({ version: "2.1.1" });
  mocks.make.mockReturnValue({ server: { info: mocks.info } });
  mocks.stop.mockResolvedValue(undefined);
});
describe("OpenCode runtime ownership", () => {
  test("restarts an owned service after a cached connection stops responding", async () => {
    const runtime = new OpenCodeRuntime();
    await runtime.client();
    mocks.info.mockRejectedValueOnce(new Error("Connection refused"));
    await expect(runtime.client()).resolves.toHaveProperty("version", "2.1.1");
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
  test("starts once under concurrency and authenticates the returned endpoint", async () => {
    const runtime = new OpenCodeRuntime();
    const [left, right] = await Promise.all([
      runtime.client(),
      runtime.client(),
    ]);
    expect(left).toBe(right);
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "/tmp/control/opencode/agent/opencode/service.json",
        env: { XDG_STATE_HOME: "/tmp/control/opencode/agent" },
        version: "2.1.1",
        command: [
          "/opt/homebrew/bin/opencode",
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
      }),
    );
    expect(mocks.make).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:12345",
      headers: { authorization: "Basic test" },
    });
    await runtime.close();
    await runtime.close();
    expect(mocks.stop).toHaveBeenCalledOnce();
    await expect(runtime.client()).rejects.toThrow("closed");
  });
  test("passes an explicit binary path directly and rejects a missing override", async () => {
    vi.stubEnv("CONTROL_AGENT_OPENCODE_EXECUTABLE", "/custom/opencode");
    mocks.lookup.mockReturnValue("/custom/opencode");
    await new OpenCodeRuntime().client();
    expect(mocks.execute).toHaveBeenCalledWith(
      "/custom/opencode",
      ["--version"],
      expect.anything(),
    );
    mocks.lookup.mockReturnValue("/opt/homebrew/bin/opencode");
    await expect(new OpenCodeRuntime().client()).rejects.toThrow("not found");
  });
  test.each(["2.1.3", "v2.1.3", "opencode 2.1.3", "opencode v2.1.3\n"])(
    "requires the installed CLI version for banner %s",
    async (banner) => {
      mocks.execute.mockResolvedValue({ stdout: banner });
      mocks.info.mockResolvedValue({ version: "2.1.3" });
      const runtime = new OpenCodeRuntime();
      await expect(runtime.client()).resolves.toHaveProperty(
        "version",
        "2.1.3",
      );
      expect(mocks.ensure).toHaveBeenCalledWith(
        expect.objectContaining({ version: "2.1.3" }),
      );
      await runtime.close();
    },
  );
  test("rejects a supported server that does not match the installed CLI", async () => {
    mocks.execute.mockResolvedValue({ stdout: "opencode v2.1.3\n" });
    const runtime = new OpenCodeRuntime();
    await expect(runtime.client()).rejects.toThrow(
      "OpenCode server version 2.1.1 does not match installed CLI 2.1.3",
    );
    expect(mocks.stop).toHaveBeenCalledWith({ file: runtime.file });
    mocks.info.mockResolvedValueOnce({ version: "2.1.3" });
    await expect(runtime.client()).resolves.toHaveProperty("version", "2.1.3");
    await runtime.close();
  });
  test.each(["1.19.0", "2.0.30", "2.1.0", "3.0.0", "2.1.1-beta.1"])(
    "rejects incompatible CLI %s before starting a service",
    async (version) => {
      mocks.execute.mockResolvedValue({ stdout: `opencode v${version}` });
      await expect(new OpenCodeRuntime().client()).rejects.toThrow("required");
      expect(mocks.ensure).not.toHaveBeenCalled();
    },
  );
  test("cleans an incompatible server and permits retry after failure", async () => {
    const runtime = new OpenCodeRuntime();
    mocks.info.mockResolvedValueOnce({ version: "1.19.0" });
    await expect(runtime.client()).rejects.toThrow("Unsupported");
    expect(mocks.stop).toHaveBeenCalledWith({ file: runtime.file });
    await expect(runtime.client()).resolves.toHaveProperty("version", "2.1.1");
  });
  test("gives isolated services different registrations and discovers shared services read-only", async () => {
    const left = new OpenCodeRuntime(true);
    const right = new OpenCodeRuntime(true);
    expect(left.file).not.toBe(right.file);
    mocks.discover.mockResolvedValue({ url: "http://127.0.0.1:4444" });
    await sharedOpenCodeClient();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.discover).toHaveBeenCalledWith({
      version: supportedOpenCodeVersion,
    });
  });
});
