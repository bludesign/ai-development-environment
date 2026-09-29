import { afterEach, describe, expect, test, vi } from "vitest";
const findMany = vi.hoisted(() => vi.fn(async () => [{ id: "21" }]));
const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ gitLabProject: { findMany, upsert } }),
}));
import { GitLabService } from "./gitlab.service";
import type { GitLabSettingsView } from "./types";

type Read = {
  operation: string;
  path: string;
  query?: Record<string, unknown>;
  allowStaleOnError?: boolean;
  force?: boolean;
};
type Response = { data: unknown; headers: Headers };
const viewer = {
  id: "7",
  username: "alex",
  name: "Alex",
  avatarUrl: null,
  webUrl: "https://gitlab.example/alex",
};
const rawMR = {
  id: 102,
  iid: 2,
  project_id: 99,
  title: "Unmanaged request",
  web_url:
    "https://gitlab.example/gitlab/bludesign/serverprivate/-/merge_requests/2",
  state: "opened",
  source_branch: "feature/test",
  target_branch: "main",
  sha: "abc",
  author: { ...viewer, id: 7, web_url: viewer.webUrl },
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T12:00:00Z",
};
afterEach(() => vi.restoreAllMocks());

describe("GitLab accessible discovery", () => {
  test("limits both project discovery surfaces to memberships by default", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "getSettings").mockResolvedValue({
      memberProjectsOnly: true,
    } as GitLabSettingsView);
    vi.spyOn(service, "projects").mockResolvedValue([]);
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockResolvedValue({
        data: [
          {
            id: 99,
            name: "serverprivate",
            path_with_namespace: "bludesign/serverprivate",
            web_url: "https://gitlab.example/bludesign/serverprivate",
            visibility: "private",
          },
        ],
        headers: new Headers({ "x-next-page": "3", "x-total": "72" }),
      });
    const page = await service.accessibleProjects(" bludesign ", 2, 25);
    expect(read.mock.calls[0][0]).toMatchObject({
      path: "/projects",
      query: {
        search: "bludesign",
        search_namespaces: true,
        with_merge_requests_enabled: true,
        per_page: 25,
        page: 2,
      },
    });
    expect(read.mock.calls[0][0].query).toMatchObject({ membership: true });
    expect(page).toMatchObject({
      page: 2,
      perPage: 25,
      nextPage: 3,
      total: 72,
      items: [{ id: "99", alreadyManaged: false }],
    });
    await service.availableProjects("bludesign");
    expect(read.mock.calls[1][0].query).toMatchObject({
      membership: true,
      per_page: 50,
    });
  });

  test("clamps project pagination and preserves a truthful empty end page", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "getSettings").mockResolvedValue({
      memberProjectsOnly: true,
    } as GitLabSettingsView);
    vi.spyOn(service, "projects").mockResolvedValue([]);
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockResolvedValue({ data: [], headers: new Headers() });
    expect(await service.accessibleProjects(null, -3, 200)).toMatchObject({
      page: 1,
      perPage: 100,
      nextPage: null,
      items: [],
    });
    expect(read.mock.calls[0][0].query).toMatchObject({
      membership: true,
      page: 1,
      per_page: 100,
    });
  });

  test("can include every project visible to the token on both discovery surfaces", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "getSettings").mockResolvedValue({
      memberProjectsOnly: false,
    } as GitLabSettingsView);
    vi.spyOn(service, "projects").mockResolvedValue([]);
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockResolvedValue({ data: [], headers: new Headers() });

    await service.accessibleProjects();
    await service.availableProjects();

    expect(read.mock.calls[0][0].query).not.toHaveProperty("membership");
    expect(read.mock.calls[1][0].query).not.toHaveProperty("membership");
  });

  test("adds a project by an encoded namespace path", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "projects").mockResolvedValue([]);
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockResolvedValue({
        data: {
          id: 99,
          name: "mobile",
          path_with_namespace: "acme/mobile",
          web_url: "https://gitlab.example/acme/mobile",
          visibility: "private",
        },
        headers: new Headers(),
      });

    await service.addProject("acme/mobile");

    expect(read.mock.calls[0][0].path).toBe("/projects/acme%2Fmobile");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "99" } }),
    );
  });

  test("loads comments without approval, commit, or pipeline fan-out and maps inline context", async () => {
    const service = new GitLabService();
    vi.spyOn(service, "getSettings").mockResolvedValue({
      configured: true,
      viewer,
    } as GitLabSettingsView);
    vi.spyOn(service, "projects").mockResolvedValue([]);
    vi.spyOn(
      service as unknown as {
        connection(): Promise<{ baseUrl: string; token: string }>;
      },
      "connection",
    ).mockResolvedValue({
      baseUrl: "https://gitlab.example/gitlab",
      token: "test-token",
    });
    const read = vi
      .spyOn(
        service as unknown as { get(input: Read): Promise<Response> },
        "get",
      )
      .mockImplementation(async (input) => {
        if (input.operation === "GitLabCommentMergeRequests")
          return { data: [rawMR], headers: new Headers() };
        if (input.operation === "GitLabCommentDiscussions")
          return {
            data: [
              {
                id: "thread",
                individual_note: false,
                notes: [
                  {
                    id: 42,
                    body: "Review **this**",
                    author: rawMR.author,
                    created_at: rawMR.created_at,
                    updated_at: rawMR.updated_at,
                    system: false,
                    resolvable: true,
                    resolved: false,
                    position: {
                      new_path: "src/api.ts",
                      new_line: 17,
                      old_line: null,
                    },
                  },
                ],
              },
            ],
            headers: new Headers(),
          };
        throw new Error(`Unexpected enrichment: ${input.operation}`);
      });
    const result = await service.comments();
    expect(result.partial).toBe(false);
    expect(result.threads[0].mergeRequest.projectPath).toBe(
      "bludesign/serverprivate",
    );
    expect(result.threads[0].discussion.notes[0]).toMatchObject({
      filePath: "src/api.ts",
      newLine: 17,
      oldLine: null,
      webUrl: `${rawMR.web_url}#note_42`,
    });
    expect(read.mock.calls.map(([input]) => input.operation)).toEqual([
      "GitLabCommentMergeRequests",
      "GitLabCommentMergeRequests",
      "GitLabCommentMergeRequests",
      "GitLabCommentDiscussions",
    ]);
    expect(
      read.mock.calls.every(([input]) => input.allowStaleOnError === false),
    ).toBe(true);
    expect(read.mock.calls.every(([input]) => input.force === false)).toBe(
      true,
    );
  });

  test.each([undefined, "thread"])(
    "reports direct comments read failures and disables stale fallback (discussion %s)",
    async (discussionId) => {
      const service = new GitLabService();
      vi.spyOn(service, "getSettings").mockResolvedValue({
        configured: true,
        viewer,
      } as GitLabSettingsView);
      vi.spyOn(service, "projects").mockResolvedValue([]);
      vi.spyOn(
        service as unknown as {
          connection(): Promise<{ baseUrl: string; token: string }>;
        },
        "connection",
      ).mockResolvedValue({
        baseUrl: "https://gitlab.example/gitlab",
        token: "test-token",
      });
      const read = vi
        .spyOn(
          service as unknown as { get(input: Read): Promise<Response> },
          "get",
        )
        .mockImplementation(async (input) => {
          if (input.operation === "GitLabMergeRequest")
            return { data: rawMR, headers: new Headers() };
          throw new Error("403 Forbidden");
        });
      const result = await service.comments({
        projectId: "99",
        iid: 2,
        discussionId,
        refresh: true,
      });
      expect(result).toMatchObject({
        partial: true,
        hasNextPage: true,
        threads: [],
      });
      expect(result.warnings.join(" ")).toContain("Could not load comments");
      expect(read.mock.calls.map(([input]) => input.operation)).toEqual([
        "GitLabMergeRequest",
        discussionId ? "GitLabDiscussion" : "GitLabCommentDiscussions",
      ]);
      expect(
        read.mock.calls.every(([input]) => input.allowStaleOnError === false),
      ).toBe(true);
      expect(read.mock.calls.every(([input]) => input.force === true)).toBe(
        true,
      );
    },
  );
});
