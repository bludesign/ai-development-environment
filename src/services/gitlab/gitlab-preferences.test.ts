import { beforeEach, describe, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({
  transaction: vi.fn(),
  settingsUpsert: vi.fn(),
  projectDeleteMany: vi.fn(),
  cacheDeleteMany: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    $transaction: database.transaction,
    gitLabSettings: { upsert: database.settingsUpsert },
    gitLabProject: { deleteMany: database.projectDeleteMany },
    gitLabRestCacheEntry: { deleteMany: database.cacheDeleteMany },
  }),
}));

import { GitLabService } from "./gitlab.service";
import type { GitLabSettingsView } from "./types";

describe("GitLab preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  test("partially updates local preferences without verifying GitLab", async () => {
    const service = new GitLabService();
    const view = {
      defaultDeleteWorktree: true,
    } as GitLabSettingsView;
    vi.spyOn(service, "getSettings").mockResolvedValue(view);

    await expect(
      service.savePreferences({ defaultDeleteWorktree: true }),
    ).resolves.toBe(view);

    expect(database.settingsUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { id: "default" },
      create: {
        id: "default",
        memberProjectsOnly: true,
        defaultSquash: true,
        defaultMoveTicketToDone: false,
        defaultDeleteWorktree: true,
      },
      update: { defaultDeleteWorktree: true },
    });
  });

  test("clears credentials without resetting saved preferences", async () => {
    const credentials = { deleteMany: vi.fn().mockResolvedValue(undefined) };
    const service = new GitLabService(credentials as never);
    const view = {
      configured: false,
      memberProjectsOnly: false,
      defaultSquash: false,
      defaultMoveTicketToDone: true,
      defaultDeleteWorktree: true,
    } as GitLabSettingsView;
    vi.spyOn(service, "projects").mockResolvedValue([]);
    vi.spyOn(service, "getSettings").mockResolvedValue(view);
    database.transaction.mockResolvedValue([]);

    await expect(service.clearCredentials()).resolves.toBe(view);

    expect(database.settingsUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: { id: "default" },
      update: {
        currentUserId: null,
        currentUsername: null,
        currentUserName: null,
        currentUserAvatarUrl: null,
        currentUserWebUrl: null,
        version: null,
        revision: null,
        verifiedAt: null,
      },
    });
    expect(
      database.settingsUpsert.mock.calls.at(-1)?.[0].update,
    ).not.toHaveProperty("memberProjectsOnly");
  });
});
