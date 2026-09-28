import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AppSyncPanel } from "./app-sync-panel";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: () => () => undefined,
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
}));
afterEach(() => {
  cleanup();
  vi.mocked(controlPlaneRequest).mockReset();
});

test("sync offers only missing checkouts on eligible agents and preserves the overview fingerprint", async () => {
  const repository = {
    key: "repo",
    label: "App",
    incoming: { canonicalOrigin: "github.com/acme/app" },
  };
  const destination = {
    repositoryKey: "repo",
    repositoryId: "repo-id",
    remoteUrl: "git@github.com:acme/app.git",
    relativePath: "app",
    destinationPath: "/Repos/app",
    error: null,
  };
  const overview = {
    appId: "app-id",
    fingerprint: "coverage-1",
    selectedAgentIds: [],
    repositories: [repository],
    agents: [
      {
        id: "present",
        name: "Studio",
        eligible: true,
        baseRepoDirectory: "/Repos",
        reason: null,
      },
      {
        id: "missing",
        name: "Laptop",
        eligible: true,
        baseRepoDirectory: "/Repos",
        reason: null,
      },
      {
        id: "offline",
        name: "Offline Mac",
        eligible: false,
        baseRepoDirectory: "/Repos",
        reason: "Agent is offline",
      },
    ],
    destinations: [
      { ...destination, agentId: "present", status: "PRESENT" },
      { ...destination, agentId: "missing", status: "MISSING" },
      { ...destination, agentId: "offline", status: "MISSING" },
    ],
  };
  const request = vi.mocked(controlPlaneRequest);
  request.mockImplementation(async (query) => {
    if (query.includes("query AppRepositorySync"))
      return { appRepositorySync: overview } as never;
    if (query.includes("mutation SyncAppRepositories"))
      throw new Error("Agent went offline");
    throw new Error(`Unexpected operation ${query}`);
  });
  render(<AppSyncPanel appId="app-id" />);
  expect(await screen.findByText("Already present")).toBeDefined();
  const agents = screen.getAllByRole("checkbox", {
    name: "Select missing repositories on this agent",
  });
  expect((agents[0] as HTMLButtonElement).disabled).toBe(true);
  expect((agents[2] as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(agents[1]!);
  fireEvent.click(screen.getByRole("button", { name: "Clone selected (1)" }));
  await waitFor(() =>
    expect(
      request.mock.calls.find(([query]) =>
        query.includes("mutation SyncAppRepositories"),
      )?.[1],
    ).toMatchObject({
      appId: "app-id",
      fingerprint: "coverage-1",
      destinations: [
        { repositoryKey: "repo", agentId: "missing", relativePath: "app" },
      ],
    }),
  );
  expect(await screen.findByText("Agent went offline")).toBeDefined();
  const firstAttempt = request.mock.calls.find(([query]) =>
    query.includes("mutation SyncAppRepositories"),
  )?.[1];
  overview.fingerprint = "coverage-2";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.queryByText("Agent went offline")).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clone selected (1)" }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation SyncAppRepositories"),
      ),
    ).toHaveLength(2),
  );
  expect(
    request.mock.calls.filter(([query]) =>
      query.includes("mutation SyncAppRepositories"),
    )[1]?.[1],
  ).toEqual(firstAttempt);
});
