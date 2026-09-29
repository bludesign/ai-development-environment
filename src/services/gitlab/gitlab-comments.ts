import { randomUUID } from "node:crypto";
import { mapIntegrationRequests } from "@/services/integration-request";
import type {
  GitLabCommentPageView,
  GitLabCommentThreadView,
  GitLabDiscussionView,
  GitLabMergeRequestView,
  GitLabUserView,
} from "./types";

export type GitLabCommentsInput = {
  projectId?: string | null;
  iid?: number | null;
  discussionId?: string | null;
  after?: string | null;
  first?: number | null;
  refresh?: boolean | null;
};
export type CommentSource = {
  scope: "created_by_me" | "assigned_to_me" | "reviews_for_me" | "all";
  projectId: string | null;
  page: number | null;
};
type Page<T> = { items: T[]; nextPage: number | null };
type Pending = {
  mr: GitLabMergeRequestView;
  page: number;
  offset: number;
  seen: string[];
  failed: boolean;
  buffer?: Page<GitLabDiscussionView>;
};
type Continuation = {
  identity: string;
  refresh: boolean;
  sources: CommentSource[];
  sourceTurn: number;
  pending: Pending[];
  seenRequests: string[];
  warnings: string[];
};
export type CommentReader = {
  discover: (
    source: CommentSource,
    refresh: boolean,
  ) => Promise<Page<GitLabMergeRequestView>>;
  request: (
    projectId: string,
    iid: number,
    refresh: boolean,
  ) => Promise<GitLabMergeRequestView>;
  discussions: (
    mr: GitLabMergeRequestView,
    page: number,
    refresh: boolean,
  ) => Promise<Page<GitLabDiscussionView>>;
  discussion: (
    mr: GitLabMergeRequestView,
    id: string,
    refresh: boolean,
  ) => Promise<GitLabDiscussionView>;
  enrich: (mr: GitLabMergeRequestView) => Promise<GitLabMergeRequestView>;
};
const requestKey = (mr: GitLabMergeRequestView) => `${mr.projectId}:${mr.iid}`;
const cursorLifetime = 30 * 60_000;

/** Short-lived continuations retain deduplication without unbounded client cursors or a database index. */
export class GitLabCommentsFeed {
  private readonly cursors = new Map<
    string,
    { expires: number; state: Continuation }
  >();

  async load(
    input: GitLabCommentsInput,
    context: { identity: string; viewer: GitLabUserView; projectIds: string[] },
    read: CommentReader,
  ): Promise<GitLabCommentPageView> {
    if (
      (input.iid != null && !input.projectId) ||
      (input.discussionId && input.iid == null)
    ) {
      throw new Error(
        "Select a project and merge request before selecting a discussion.",
      );
    }
    if (
      input.iid != null &&
      (!Number.isSafeInteger(input.iid) || input.iid < 1)
    ) {
      throw new Error("A positive merge-request number is required.");
    }
    const first = Math.max(1, Math.min(25, input.first ?? 25));
    const identity = JSON.stringify([
      context.identity,
      input.projectId ?? null,
      input.iid ?? null,
      input.discussionId ?? null,
    ]);
    for (const [key, value] of this.cursors)
      if (value.expires <= Date.now()) this.cursors.delete(key);
    let state: Continuation;
    if (input.after) {
      const saved = this.cursors.get(input.after);
      if (!saved || saved.state.identity !== identity) {
        throw new Error(
          "Comments continuation expired or the selection changed. Refresh comments to continue.",
        );
      }
      state = structuredClone(saved.state);
      state.refresh ||= input.refresh === true;
    } else {
      state = {
        identity,
        refresh: input.refresh === true,
        sources:
          input.iid != null
            ? []
            : input.projectId
              ? [{ scope: "all", projectId: input.projectId, page: 1 }]
              : [
                  ...(
                    [
                      "created_by_me",
                      "assigned_to_me",
                      "reviews_for_me",
                    ] as const
                  ).map((scope) => ({ scope, projectId: null, page: 1 })),
                  ...context.projectIds.map((projectId) => ({
                    scope: "all" as const,
                    projectId,
                    page: 1,
                  })),
                ],
        sourceTurn: 0,
        pending: [],
        seenRequests: [],
        warnings: [],
      };
      if (input.iid != null) {
        const mr = await read.request(
          input.projectId!,
          input.iid,
          state.refresh,
        );
        state.pending.push({ mr, page: 1, offset: 0, seen: [], failed: false });
        state.seenRequests.push(requestKey(mr));
      }
    }
    const requests = new Map<string, GitLabMergeRequestView>();
    const warnings = [...state.warnings];
    const threads: GitLabCommentThreadView[] = [];
    const warn = (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    };

    // Discover at most four provider pages in a response. Advance fairly through all sources.
    if (
      !state.pending.length ||
      state.pending.every((pending) => pending.failed)
    ) {
      const sources: CommentSource[] = [];
      for (
        let examined = 0;
        examined < state.sources.length && sources.length < 4;
        examined++
      ) {
        const source = state.sources[state.sourceTurn % state.sources.length]!;
        state.sourceTurn = (state.sourceTurn + 1) % state.sources.length;
        if (source.page !== null) sources.push(source);
      }
      const pages = await mapIntegrationRequests(sources, async (source) => {
        try {
          return { source, page: await read.discover(source, state.refresh) };
        } catch {
          return { source, page: null };
        }
      });
      const known = new Set(state.seenRequests);
      for (const { source, page } of pages) {
        if (!page) {
          warn(
            `Could not load ${source.projectId ? `project ${source.projectId}` : source.scope.replaceAll("_", " ")} merge requests. Load more to retry, or refresh.`,
          );
          continue;
        }
        for (const mr of page.items) {
          const key = requestKey(mr);
          if (known.has(key)) continue;
          known.add(key);
          state.seenRequests.push(key);
          state.pending.push({
            mr,
            page: 1,
            offset: 0,
            seen: [],
            failed: false,
          });
          requests.set(key, mr);
        }
        if (page.nextPage !== null && page.nextPage <= source.page!) {
          const message =
            "GitLab returned a repeated request page. Refresh or select a merge request directly to recover the missing comments.";
          state.warnings.push(message);
          warn(message);
          source.page = null;
        } else source.page = page.nextPage;
      }
      state.pending.sort(
        (a, b) => Date.parse(b.mr.updatedAt) - Date.parse(a.mr.updatedAt),
      );
    }

    // Prioritize unread pages without letting failed requests block later discovery.
    // Retain each fetched page so provider changes cannot move rows past its saved offset.
    const batch = [
      ...state.pending.filter((pending) => !pending.failed),
      ...state.pending.filter((pending) => pending.failed),
    ].slice(0, 4);
    const pages = await mapIntegrationRequests(batch, async (pending) => {
      if (pending.buffer)
        return { pending, page: pending.buffer, mr: pending.mr };
      try {
        const page = input.discussionId
          ? {
              items: [
                await read.discussion(
                  pending.mr,
                  input.discussionId,
                  state.refresh,
                ),
              ],
              nextPage: null,
            }
          : await read.discussions(pending.mr, pending.page, state.refresh);
        return {
          pending,
          page,
          mr: await read.enrich(pending.mr).catch(() => pending.mr),
        };
      } catch {
        return { pending, page: null, mr: pending.mr };
      }
    });
    for (const { pending, page, mr } of pages) {
      requests.set(requestKey(mr), mr);
      if (!page) {
        pending.failed = true;
        warn(
          `Could not load comments for ${mr.projectPath ?? `project ${mr.projectId}`} !${mr.iid}. Load more to retry, or refresh.`,
        );
        state.pending.splice(state.pending.indexOf(pending), 1);
        state.pending.push(pending);
        continue;
      }
      pending.mr = mr;
      pending.failed = false;
      pending.buffer = page;
      while (pending.offset < page.items.length && threads.length < first) {
        const discussion = page.items[pending.offset++]!;
        if (pending.seen.includes(discussion.id)) continue;
        pending.seen.push(discussion.id);
        const notes = discussion.notes
          .filter((note) => !note.system)
          .map((note) => ({
            ...note,
            webUrl: note.webUrl ?? `${mr.webUrl}#note_${note.id}`,
          }))
          .sort(
            (a, b) =>
              Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
              a.id.localeCompare(b.id, undefined, { numeric: true }),
          );
        if (notes.length)
          threads.push({
            id: `${requestKey(mr)}:${discussion.id}`,
            mergeRequest: mr,
            discussion: { ...discussion, notes },
          });
      }
      if (pending.offset >= page.items.length) {
        if (page.nextPage !== null && page.nextPage > pending.page) {
          pending.page = page.nextPage;
          pending.offset = 0;
          pending.buffer = undefined;
        } else {
          if (page.nextPage !== null) {
            const message = `GitLab returned a repeated discussion page for !${mr.iid}. Refresh or open the request in GitLab for the remaining comments.`;
            state.warnings.push(message);
            warn(message);
          }
          state.pending.splice(state.pending.indexOf(pending), 1);
        }
      }
    }
    threads.sort(
      (a, b) =>
        Date.parse(b.discussion.notes[0]!.createdAt) -
          Date.parse(a.discussion.notes[0]!.createdAt) ||
        a.id.localeCompare(b.id),
    );
    const hasNextPage =
      state.pending.length > 0 ||
      state.sources.some((source) => source.page !== null);
    let endCursor: string | null = null;
    if (hasNextPage) {
      endCursor = randomUUID();
      this.cursors.set(endCursor, {
        expires: Date.now() + cursorLifetime,
        state,
      });
      while (this.cursors.size > 128)
        this.cursors.delete(this.cursors.keys().next().value!);
    }
    return {
      viewerId: context.viewer.id,
      viewerUsername: context.viewer.username,
      mergeRequests: [...requests.values()],
      threads,
      hasNextPage,
      endCursor,
      partial: warnings.length > 0,
      warnings,
    };
  }
}
