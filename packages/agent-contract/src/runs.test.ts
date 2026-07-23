import { describe, expect, test } from "vitest";

import { parseRunSessionReadPayload } from "./runs";

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
