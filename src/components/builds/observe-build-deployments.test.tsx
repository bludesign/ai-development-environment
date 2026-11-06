import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import {
  observeBuildDeployments,
  type ObservedBuildDeployment,
} from "./observe-build-deployments";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const unsubscribe = vi.fn();
let publish: (deployments: ObservedBuildDeployment[]) => void;

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  unsubscribe.mockReset();
  vi.mocked(controlPlaneSubscriptions).mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      publish = (deployments) =>
        sink.next({ data: { buildSnapshotChanged: { deployments } } } as never);
      return unsubscribe;
    }),
  } as never);
});
afterEach(() => vi.useRealTimers());

const queued = (id: string, name: string): ObservedBuildDeployment => ({
  id,
  status: "QUEUED",
  destination: { name },
});
const start = (
  deployments: ObservedBuildDeployment[],
  onError = vi.fn(),
  signal = new AbortController().signal,
) =>
  observeBuildDeployments({
    buildId: "build",
    deployments,
    signal,
    onError,
    fallbackError: "Run failed",
  });

describe("observeBuildDeployments", () => {
  test("does not replace a live failure with an older in-flight poll", async () => {
    const first = queued("one", "QA iPhone");
    const second = queued("two", "Simulator");
    const read = Promise.withResolvers<{
      build: { deployments: ObservedBuildDeployment[] };
    }>();
    request.mockReturnValue(read.promise as never);
    const onError = vi.fn();
    const task = start([first, second], onError);
    publish([{ ...first, status: "FAILED", error: "Launch denied" }]);
    read.resolve({ build: { deployments: [first, second] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenLastCalledWith("QA iPhone: Launch denied");
    publish([{ ...second, status: "SUCCEEDED" }]);
    await expect(task).resolves.toBe("QA iPhone: Launch denied");
  });

  test("reports mixed destination failures while waiting for the remaining run", async () => {
    const first = queued("one", "QA iPhone");
    const second = queued("two", "iPad Simulator");
    request.mockResolvedValue({
      build: { deployments: [first, second] },
    } as never);
    const onError = vi.fn();
    const finished = vi.fn();
    const task = start([first, second], onError).then((result) => {
      finished();
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    publish([
      { ...first, status: "FAILED", error: "Install rejected" },
      { id: "older", status: "FAILED", error: "Ignore old run" },
    ]);
    expect(onError).toHaveBeenLastCalledWith("QA iPhone: Install rejected");
    expect(finished).not.toHaveBeenCalled();
    publish([{ ...second, status: "SUCCEEDED" }]);
    await expect(task).resolves.toBe("QA iPhone: Install rejected");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("polls when no live event arrives and preserves transfer errors", async () => {
    const deployment = queued("one", "Lab iPhone");
    request
      .mockResolvedValueOnce({ build: { deployments: [deployment] } } as never)
      .mockResolvedValueOnce({
        build: {
          deployments: [
            {
              ...deployment,
              status: "TRANSFERRING",
              transfer: {
                status: "FAILED",
                error: "Package checksum mismatch",
              },
            },
          ],
        },
      } as never);
    const task = start([deployment]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(task).resolves.toBe("Lab iPhone: Package checksum mismatch");
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("cancels reads and subscriptions when the run control is disposed", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    request.mockImplementation(() => new Promise(() => {}));
    const task = start(
      [queued("one", "Simulator")],
      onError,
      controller.signal,
    );
    const rejected = expect(task).rejects.toBeDefined();
    const signal = request.mock.calls[0]?.[2]?.signal;
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    onError.mockClear();
    publish([{ id: "one", status: "FAILED", error: "Late failure" }]);
    expect(onError).not.toHaveBeenCalled();
  });

  test("keeps monitoring across a temporary read failure", async () => {
    const deployment = queued("one", "Simulator");
    request.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({
      build: { deployments: [{ ...deployment, status: "SUCCEEDED" }] },
    } as never);
    const onError = vi.fn();
    const task = start([deployment], onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenLastCalledWith("Offline");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(task).resolves.toBeNull();
    expect(onError).toHaveBeenLastCalledWith(null);
  });
});
