import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { authManagementRequest } from "@/lib/auth-management-client";
import { UsersPage } from "./users-page";
import { ApiKeysPage } from "./api-keys-page";

vi.mock("@/lib/auth-management-client", () => ({
  authManagementRequest: vi.fn(),
}));
const request = vi.mocked(authManagementRequest);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("users search cancels obsolete results and leaves auth configuration out of the search", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () =>
    Response.json({ mode: "password", registration: { enabled: false } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  let finishOld!: (value: unknown) => void;
  request.mockImplementation(async (path) => {
    if (path === "users?search=old")
      return (await new Promise<unknown>((resolve) => {
        finishOld = resolve;
      })) as never;
    return { currentUserId: "me", users: [] } as never;
  });
  render(<UsersPage />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const search = screen.getByRole("textbox", { name: /search/i });
  fireEvent.change(search, { target: { value: "old" } });
  await act(() => vi.advanceTimersByTimeAsync(200));
  const oldSignal = request.mock.calls.find(
    ([path]) => path === "users?search=old",
  )![1]!.signal!;
  fireEvent.change(search, { target: { value: "new" } });
  expect(oldSignal.aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(200));
  await act(async () =>
    finishOld({
      users: [{ id: "stale", name: "Stale user" }],
      currentUserId: "me",
    }),
  );
  expect(screen.queryByText("Stale user")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("API key refreshes do not fetch owners until the create dialog opens", async () => {
  request.mockImplementation(async (path) =>
    path.startsWith("users")
      ? ({ users: [] } as never)
      : ({ apiKeys: [] } as never),
  );
  render(<ApiKeysPage />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0]?.[0]).toBe("api-keys");
  fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls.every(([path]) => path === "api-keys")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /create.*key/i }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([path]) => path === "users?summary=1"),
    ).toHaveLength(1),
  );
});
