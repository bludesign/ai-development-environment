import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CacheServerPage } from "./cache-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

const entry = {
  id: "entry-1",
  key: "initial-entry",
  version: "v1",
  scope: "refs/heads/main",
  repoId: "repo-1",
  updatedAt: 1700000000000,
  locationId: "location-1",
};

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("CacheServerPage", () => {
  test("discards an older list response after filters change", async () => {
    let resolveSlow: ((value: unknown) => void) | undefined;
    let slowRequested = false;
    const slowResponse = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query CacheServerConfigured")) {
        return { cacheServerSettings: { configured: true } } as never;
      }
      if (query.includes("query CacheServerEntries")) {
        const key = (variables as { key?: string | null } | undefined)?.key;
        if (key === "slow") {
          slowRequested = true;
          return slowResponse as never;
        }
        if (key === "fast") {
          return {
            cacheEntries: {
              total: 1,
              items: [{ ...entry, id: "fresh", key: "fresh-entry" }],
            },
          } as never;
        }
        return { cacheEntries: { total: 1, items: [entry] } } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<CacheServerPage />);
    await screen.findByText("initial-entry");

    const keyInput = screen.getByLabelText("Key");
    fireEvent.change(keyInput, { target: { value: "slow" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(slowRequested).toBe(true));

    fireEvent.change(keyInput, { target: { value: "fast" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("fresh-entry");

    await act(async () => {
      resolveSlow?.({
        cacheEntries: {
          total: 1,
          items: [{ ...entry, id: "stale", key: "stale-entry" }],
        },
      });
      await slowResponse;
    });

    expect(screen.getByText("fresh-entry")).toBeDefined();
    expect(screen.queryByText("stale-entry")).toBeNull();
  });

  test("returns to the last valid page after deleting its final row", async () => {
    let deleted = false;

    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("query CacheServerConfigured")) {
        return { cacheServerSettings: { configured: true } } as never;
      }
      if (query.includes("mutation DeleteCacheEntry")) {
        deleted = true;
        return { deleteCacheEntry: true } as never;
      }
      if (query.includes("query CacheServerEntries")) {
        const requestedPage = (variables as { page: number }).page;
        if (requestedPage === 2) {
          return {
            cacheEntries: deleted
              ? { total: 20, items: [] }
              : {
                  total: 21,
                  items: [{ ...entry, id: "last-entry", key: "last-entry" }],
                },
          } as never;
        }
        return {
          cacheEntries: {
            total: deleted ? 20 : 21,
            items: [{ ...entry, id: "page-one", key: "page-one-entry" }],
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<CacheServerPage />);
    await screen.findByText("page-one-entry");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("last-entry");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await screen.findByText("page-one-entry");
    expect(screen.queryByText("last-entry")).toBeNull();
    expect(
      requestMock.mock.calls.some(
        ([query, variables]) =>
          deleted &&
          query.includes("query CacheServerEntries") &&
          (variables as { page?: number } | undefined)?.page === 1,
      ),
    ).toBe(true);
  });
});
