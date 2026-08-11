import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserRequest: vi.fn(),
  buildRawOutput: vi.fn(),
  commandRunRawOutput: vi.fn(),
  rawOutputResponse: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  requireUserRequest: mocks.requireUserRequest,
}));
vi.mock("@/lib/raw-terminal-output", () => ({
  buildRawOutput: mocks.buildRawOutput,
  commandRunRawOutput: mocks.commandRunRawOutput,
  rawOutputResponse: mocks.rawOutputResponse,
}));

import { GET as buildOutput } from "./builds/[buildId]/output/route";
import { GET as commandOutput } from "./commands/runs/[runId]/output/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUserRequest.mockResolvedValue(null);
  mocks.buildRawOutput.mockResolvedValue("build-stream");
  mocks.commandRunRawOutput.mockResolvedValue("command-stream");
  mocks.rawOutputResponse.mockReturnValue(new Response("output"));
});

describe("dashboard raw output routes", () => {
  test.each([
    [
      buildOutput,
      "https://control.example/en/builds/build-1/output",
      { buildId: "build-1" },
    ],
    [
      commandOutput,
      "https://control.example/en/commands/runs/run-1/output",
      { runId: "run-1" },
    ],
  ])(
    "rejects unauthenticated requests before loading output",
    async (handler, url, params) => {
      const denied = Response.json({ error: "Unauthorized" }, { status: 401 });
      mocks.requireUserRequest.mockResolvedValueOnce(denied);

      const response = await handler(new Request(url), {
        params: Promise.resolve(params as never),
      });

      expect(response).toBe(denied);
      expect(mocks.buildRawOutput).not.toHaveBeenCalled();
      expect(mocks.commandRunRawOutput).not.toHaveBeenCalled();
    },
  );

  test("streams output after authenticating the user", async () => {
    await buildOutput(
      new Request("https://control.example/en/builds/build-1/output"),
      { params: Promise.resolve({ buildId: "build-1" }) },
    );
    await commandOutput(
      new Request("https://control.example/en/commands/runs/run-1/output"),
      { params: Promise.resolve({ runId: "run-1" }) },
    );

    expect(mocks.requireUserRequest).toHaveBeenCalledTimes(2);
    expect(mocks.buildRawOutput).toHaveBeenCalledWith("build-1");
    expect(mocks.commandRunRawOutput).toHaveBeenCalledWith("run-1");
  });
});
