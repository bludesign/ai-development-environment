import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type SubscriptionSink = {
    next(value: unknown): void;
    error(error: unknown): void;
    complete(): void;
  };
  const subscribe = vi.fn((_payload: unknown, _sink: SubscriptionSink) =>
    vi.fn(),
  );
  const terminate = vi.fn();
  const createClient = vi.fn(() => ({ subscribe, terminate }));
  return { createClient, subscribe, terminate };
});

vi.mock("graphql-ws", () => ({ createClient: mocks.createClient }));

import {
  controlPlaneSubscriptions,
  isControlPlaneAuthenticationError,
} from "./control-plane-client";

afterEach(() => {
  vi.useRealTimers();
});

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
  });
});
