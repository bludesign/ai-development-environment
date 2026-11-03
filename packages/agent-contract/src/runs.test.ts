import { describe, expect, test } from "vitest";

import {
  getRunSessionInfo,
  mergeRunSessionInfo,
  normalizeRunSessionInfo,
  parseRunSessionReadPayload,
} from "./runs";

describe("run session read payload contract", () => {
  test("accepts a well-formed Claude/Codex request", () => {
    expect(
      parseRunSessionReadPayload({
        provider: "CLAUDE",
        nativeId: "edf5832e-7708-4ad5-80cd-41a317fb8c2e",
        folder: "/Users/dev/Workspaces/app",
      }),
    ).toEqual({
      provider: "CLAUDE",
      nativeId: "edf5832e-7708-4ad5-80cd-41a317fb8c2e",
      folder: "/Users/dev/Workspaces/app",
    });
    expect(
      parseRunSessionReadPayload({
        provider: "CODEX",
        nativeId: "019f80ca-8092-7701-a01a-40a32a8ef040",
        folder: "/Users/dev/Workspaces/app",
      }).provider,
    ).toBe("CODEX");
  });

  test("rejects unsupported providers", () => {
    expect(() =>
      parseRunSessionReadPayload({
        provider: "OPENCODE",
        nativeId: "abc",
        folder: "/tmp",
      }),
    ).toThrow(/Unsupported session file provider/);
  });

  test("rejects a nativeId that could traverse the filesystem", () => {
    for (const nativeId of ["../secret", "a/b", "..\\win", "id/.."]) {
      expect(() =>
        parseRunSessionReadPayload({
          provider: "CLAUDE",
          nativeId,
          folder: "/tmp",
        }),
      ).toThrow(/invalid path characters/);
    }
  });

  test("rejects missing fields", () => {
    expect(() =>
      parseRunSessionReadPayload({ provider: "CLAUDE", nativeId: "abc" }),
    ).toThrow(/folder/);
  });
});

describe("run session information", () => {
  test.each([
    [
      { path: "/custom/codex/archived_sessions/session.jsonl", cwd: "/repo" },
      {
        nativeTranscriptPath: "/custom/codex/archived_sessions/session.jsonl",
        workingDirectory: "/repo",
      },
    ],
    [
      { cwd: "/claude/repo", sessionId: "claude-session" },
      { workingDirectory: "/claude/repo" },
    ],
    [
      { location: { directory: "/opencode/repo" }, id: "session" },
      { workingDirectory: "/opencode/repo" },
    ],
  ])(
    "projects known historical provider fields without exposing other metadata",
    (raw, expected) => {
      expect(
        getRunSessionInfo(JSON.stringify({ ...raw, secret: "private" })),
      ).toEqual(expected);
    },
  );

  test.each([
    null,
    undefined,
    "not json",
    "null",
    "[]",
    { aideSessionInfo: [] },
  ])("handles missing or malformed metadata (%s)", (value) =>
    expect(getRunSessionInfo(value)).toBeNull(),
  );

  test("preserves exact paths and ignores unknown or invalid fields", () => {
    expect(
      normalizeRunSessionInfo({
        nativeTranscriptPath: "/a directory/session.jsonl",
        activityLogPath: 123,
        workingDirectory: "",
        secret: "private",
      }),
    ).toEqual({ nativeTranscriptPath: "/a directory/session.jsonl" });
  });

  test("partial reports preserve known locations and internal import digests", () => {
    const metadata = {
      importedHistoryDigest: "history",
      importedSnapshotDigest: "snapshot",
      aideSessionInfo: {
        nativeTranscriptPath: "/sessions/session.jsonl",
        workingDirectory: "/repo",
      },
    };
    expect(
      mergeRunSessionInfo(JSON.stringify(metadata), {
        activityLogPath: "/aide/events.jsonl",
      }),
    ).toEqual({
      ...metadata,
      aideSessionInfo: {
        ...metadata.aideSessionInfo,
        activityLogPath: "/aide/events.jsonl",
      },
    });
    expect(
      getRunSessionInfo(
        mergeRunSessionInfo(
          { path: "/old/session.jsonl" },
          { nativeTranscriptPath: null },
        ),
      ),
    ).toEqual({ nativeTranscriptPath: null });
  });
});
