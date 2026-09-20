import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type SubscriptionSink = {
    next(value: unknown): void;
    error(error: unknown): void;
    complete(): void;
  };
  const dispose = vi.fn();
  const subscribe = vi.fn(
    (_payload: unknown, _sink: SubscriptionSink) => dispose,
  );
  const terminate = vi.fn();
  const events = { connected: () => undefined as void };
  const createClient = vi.fn((options: { on: { connected: () => void } }) => {
    events.connected = options.on.connected;
    return { subscribe, terminate };
  });
  return { createClient, dispose, subscribe, terminate, events };
});

vi.mock("graphql-ws", () => ({ createClient: mocks.createClient }));

import {
  controlPlaneSubscriptions,
  isControlPlaneAuthenticationError,
  onControlPlaneConnected,
  onControlPlaneRecovery,
} from "./control-plane-client";

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sink() {
  return { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
}

describe("control-plane subscription recovery", () => {
  test("reconnects and resubscribes after an authentication operation error", async () => {
    vi.useFakeTimers();
    const sink = {
      next: vi.fn(),
      error: vi.fn(),
      complete: vi.fn(),
    };

    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription Test { changed }" },
      sink,
    );
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    const firstAttempt = mocks.subscribe.mock.calls[0]?.[1];
    firstAttempt!.error([
      { message: "Authentication is required for this GraphQL operation." },
    ]);

    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
    expect(sink.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);

    const secondAttempt = mocks.subscribe.mock.calls[1]?.[1];
    secondAttempt!.next({ data: { changed: true } });
    expect(sink.next).toHaveBeenCalledWith({ data: { changed: true } });
    unsubscribe();
  });

  test("forwards non-authentication operation errors without retrying", async () => {
    vi.useFakeTimers();
    const sink = {
      next: vi.fn(),
      error: vi.fn(),
      complete: vi.fn(),
    };
    const callsBefore = mocks.subscribe.mock.calls.length;

    controlPlaneSubscriptions().subscribe(
      { query: "subscription Invalid { missing }" },
      sink,
    );
    const attempt = mocks.subscribe.mock.calls[callsBefore]?.[1];
    const error = [{ message: "Cannot query field missing" }];
    attempt!.error(error);

    expect(sink.error).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(callsBefore + 1);
  });

  test("recognizes the server's credential error payloads", () => {
    expect(
      isControlPlaneAuthenticationError([
        { message: "The supplied credential is invalid." },
      ]),
    ).toBe(true);
    expect(
      isControlPlaneAuthenticationError([{ message: "Unknown operation" }]),
    ).toBe(false);
    expect(
      isControlPlaneAuthenticationError([
        { message: "Expired", extensions: { code: "UNAUTHENTICATED" } },
      ]),
    ).toBe(true);
  });

  test("shares a transient operation retry and reconciles without disconnecting a healthy socket", async () => {
    vi.useFakeTimers();
    const first = sink();
    const second = sink();
    const recover = vi.fn();
    cleanup.push(onControlPlaneRecovery(recover));
    const payload = {
      query: "subscription Retry { changed }",
      variables: { filter: { a: 1, b: 2 } },
    };
    const disposeFirst = controlPlaneSubscriptions().subscribe(payload, first);
    const disposeSecond = controlPlaneSubscriptions().subscribe(
      { ...payload, variables: { filter: { b: 2, a: 1 } } },
      second,
    );
    cleanup.push(disposeFirst, disposeSecond);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    const failedAttempt = mocks.subscribe.mock.calls[0]![1];
    failedAttempt.error([
      {
        message: "Temporary database interruption",
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      },
    ]);
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(first.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
    failedAttempt.complete();
    failedAttempt.next({ data: { changed: "obsolete" } });
    expect(first.complete).not.toHaveBeenCalled();
    expect(first.next).not.toHaveBeenCalled();
    const current = mocks.subscribe.mock.calls[1]![1];
    current.next({ data: { changed: "current" } });
    expect(first.next).toHaveBeenCalledWith({ data: { changed: "current" } });
    expect(second.next).toHaveBeenCalledWith({ data: { changed: "current" } });
    disposeFirst();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    current.next({ data: { changed: "newer" } });
    expect(first.next).toHaveBeenCalledOnce();
    expect(second.next).toHaveBeenCalledTimes(2);
    disposeSecond();
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  });

  test("preserves independent lifetimes when callers reuse the same sink", () => {
    const sharedSink = sink();
    const payload = { query: "subscription SameSink { changed }" };
    const first = controlPlaneSubscriptions().subscribe(payload, sharedSink);
    const second = controlPlaneSubscriptions().subscribe(payload, sharedSink);
    cleanup.push(first, second);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    mocks.subscribe.mock.calls[0]![1].next({ data: { changed: true } });
    expect(sharedSink.next).toHaveBeenCalledTimes(2);
    first();
    expect(mocks.dispose).not.toHaveBeenCalled();
    second();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  test("keeps distinct projections and variable values separate", () => {
    for (const payload of [
      { query: "subscription Distinct { changed }", variables: { id: 1 } },
      { query: "subscription Distinct { changed }", variables: { id: 2 } },
      {
        query: "subscription Distinct { changed { id } }",
        variables: { id: 1 },
      },
    ])
      cleanup.push(controlPlaneSubscriptions().subscribe(payload, sink()));
    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
  });

  test("canceling the last consumer removes a pending retry and its recovery notification", async () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    cleanup.push(onControlPlaneRecovery(recover));
    const dispose = controlPlaneSubscriptions().subscribe(
      { query: "subscription CanceledRetry { changed }" },
      sink(),
    );
    mocks.subscribe.mock.calls[0]![1].error(
      new Error("Connection interrupted"),
    );
    dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  test("backs off repeated operation failures and resets after a delivered event", async () => {
    vi.useFakeTimers();
    cleanup.push(
      controlPlaneSubscriptions().subscribe(
        { query: "subscription Backoff { changed }" },
        sink(),
      ),
    );
    const fail = () =>
      mocks.subscribe.mock.calls
        .at(-1)![1]
        .error(new Error("temporarily unavailable"));
    fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    fail();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
    mocks.subscribe.mock.calls[2]![1].next({ data: { changed: true } });
    fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.subscribe).toHaveBeenCalledTimes(4);
  });

  test("all consumers receive reconnect catch-up even if one listener throws", () => {
    const failure = new Error("listener failed");
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const connected = vi.fn();
    const recovered = vi.fn();
    const defaultRecovery = vi.fn();
    cleanup.push(
      onControlPlaneConnected(() => {
        throw failure;
      }),
    );
    cleanup.push(
      onControlPlaneConnected(connected),
      onControlPlaneRecovery(recovered, { includeInitial: true }),
      onControlPlaneRecovery(defaultRecovery),
    );
    mocks.events.connected();
    mocks.events.connected();
    expect(connected).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(defaultRecovery).toHaveBeenCalledExactlyOnceWith({
      initialConnection: false,
    });
    expect(recovered).toHaveBeenNthCalledWith(1, { initialConnection: true });
    expect(recovered).toHaveBeenNthCalledWith(2, { initialConnection: false });
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  test("normal completion ends every consumer and permits a new registration", () => {
    const first = sink();
    const second = sink();
    const payload = { query: "subscription Finite { changed }" };
    cleanup.push(controlPlaneSubscriptions().subscribe(payload, first));
    cleanup.push(controlPlaneSubscriptions().subscribe(payload, second));
    mocks.subscribe.mock.calls[0]![1].complete();
    expect(first.complete).toHaveBeenCalledOnce();
    expect(second.complete).toHaveBeenCalledOnce();
    cleanup.push(controlPlaneSubscriptions().subscribe(payload, sink()));
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });
});
