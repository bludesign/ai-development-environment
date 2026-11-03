import { describe, expect, test, vi } from "vitest";

import type { RunsService } from "@/services/runs";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import { createRunResolvers } from "./runs";

describe("run metadata resolvers", () => {
  test("projects only typed session information from raw attempt metadata", () => {
    const resolvers = createRunResolvers({} as RunsService);
    expect(
      resolvers.RunAttempt.sessionInfo({
        rawMetadataJson: JSON.stringify({
          path: "/sessions/native.jsonl",
          cwd: "/repo",
          secret: "private",
          aideSessionInfo: {
            activityLogPath: "/aide/events.jsonl",
            secret: "also private",
          },
        }),
      }),
    ).toEqual({
      nativeTranscriptPath: "/sessions/native.jsonl",
      workingDirectory: "/repo",
      activityLogPath: "/aide/events.jsonl",
    });
    expect(
      resolvers.RunAttempt.sessionInfo({ rawMetadataJson: "invalid json" }),
    ).toBeNull();
  });

  test("passes session information only through the owning-agent mutation", async () => {
    const updateAttemptNativeId = vi.fn().mockResolvedValue({ id: "attempt" });
    const resolvers = createRunResolvers({
      updateAttemptNativeId,
    } as unknown as RunsService);
    const sessionInfo = { nativeTranscriptPath: "/sessions/native.jsonl" };
    await resolvers.Mutation.updateRunAttemptNativeId(
      null,
      {
        attemptId: "attempt",
        nativeId: "native",
        providerVersion: "1.2.3",
        sessionInfo,
      },
      { agentId: "agent" } as GraphQLContext,
    );
    expect(updateAttemptNativeId).toHaveBeenCalledWith(
      "agent",
      "attempt",
      "native",
      "1.2.3",
      sessionInfo,
    );
    expect(() =>
      resolvers.Mutation.updateRunAttemptNativeId(
        null,
        {
          attemptId: "attempt",
          nativeId: "native",
          sessionInfo,
        },
        { agentId: null } as GraphQLContext,
      ),
    ).toThrow("Agent authentication is required");
  });

  test("normalizes historical FINAL patches without changing rollback checkpoints", () => {
    const resolvers = createRunResolvers({} as RunsService);
    const patch =
      "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    const checkpoint = {
      kind: "FINAL",
      diffSummary: "Staged:\n file.ts | 1 +",
      diffPatch: `Worktree changes that will be undone:\n\n${patch}\n\nIndex changes that will be undone:\n\n${patch}`,
    };
    expect(resolvers.RunCheckpoint.diffPatch(checkpoint)).toBe(patch);
    expect(resolvers.RunCheckpoint.diffSummary(checkpoint)).toBeNull();
    expect(
      resolvers.RunCheckpoint.diffPatch({ ...checkpoint, kind: "QUESTION" }),
    ).toBe(checkpoint.diffPatch);
  });
});
