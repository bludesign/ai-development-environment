import { describe, expect, test } from "vitest";

import {
  ATOS_GROUP_DELIMITER,
  atosArguments,
  formatUuid,
  normalizeUuid,
  parseAtosLine,
  parseAtosOutput,
  parseCrashSymbolicationPayload,
  parseCrashSymbolicationResult,
} from "./crashes.js";

const sha = "a".repeat(64);

function payload() {
  return {
    crashId: "crash-1",
    dsyms: [
      {
        dsymId: "dsym-1",
        sha256: sha,
        sizeBytes: 14_236,
        binaryName: "CrashDemo",
        downloadPath: "/api/agent/dsyms/dsym-1/dwarf",
      },
    ],
    lookups: [
      {
        dsymId: "dsym-1",
        uuid: "776386d0-4386-3f24-9b21-5f7c02eb2873",
        arch: "arm64",
        offsets: ["0xD6C", "0xb18"],
      },
    ],
  };
}

describe("crash symbolication contract", () => {
  test("normalizes UUIDs and offsets in the payload", () => {
    expect(parseCrashSymbolicationPayload(payload())).toEqual({
      ...payload(),
      lookups: [
        {
          dsymId: "dsym-1",
          uuid: "776386D043863F249B215F7C02EB2873",
          arch: "arm64",
          offsets: ["0xd6c", "0xb18"],
        },
      ],
    });
  });

  test("rejects lookups for dSYMs the payload does not list", () => {
    const value = payload();
    value.lookups[0]!.dsymId = "other";
    expect(() => parseCrashSymbolicationPayload(value)).toThrow(
      "not listed in dsyms",
    );
  });

  test("rejects binary names that could escape the cache folder", () => {
    const value = payload();
    value.dsyms[0]!.binaryName = "../CrashDemo";
    expect(() => parseCrashSymbolicationPayload(value)).toThrow(
      "plain file name",
    );
  });

  test("rejects download paths outside the agent routes", () => {
    const value = payload();
    value.dsyms[0]!.downloadPath = "https://example.com/dwarf";
    expect(() => parseCrashSymbolicationPayload(value)).toThrow(
      "not an agent route",
    );
  });

  test("formats UUIDs the way Xcode prints them", () => {
    expect(normalizeUuid("<776386d043863f249b215f7c02eb2873>")).toBe(
      "776386D043863F249B215F7C02EB2873",
    );
    expect(formatUuid("776386d043863f249b215f7c02eb2873")).toBe(
      "776386D0-4386-3F24-9B21-5F7C02EB2873",
    );
    expect(() => normalizeUuid("not-a-uuid")).toThrow();
  });

  test("builds atos arguments that take image offsets directly", () => {
    expect(
      atosArguments({
        arch: "arm64",
        dwarfPath: "/cache/CrashDemo",
        offsetsFile: "/tmp/offsets",
      }),
    ).toEqual([
      "atos",
      "-arch",
      "arm64",
      "-o",
      "/cache/CrashDemo",
      "--offset",
      "-i",
      "--fullPath",
      "-d",
      ATOS_GROUP_DELIMITER,
      "-f",
      "/tmp/offsets",
    ]);
  });

  test("parses the line forms atos prints", () => {
    expect(
      parseAtosLine("Loader.item(at:) (in CrashDemo) (/src/boom.swift:3)"),
    ).toEqual({
      symbol: "Loader.item(at:)",
      image: "CrashDemo",
      file: "/src/boom.swift",
      line: 3,
      symbolOffset: null,
    });
    expect(parseAtosLine("middle(_:) (in Crash2) + 12")).toEqual({
      symbol: "middle(_:)",
      image: "Crash2",
      file: null,
      line: null,
      symbolOffset: 12,
    });
    expect(
      parseAtosLine(
        "closure #1 in ViewController.viewDidLoad() (in App) (ViewController.swift:42)",
      )?.symbol,
    ).toBe("closure #1 in ViewController.viewDidLoad()");
    expect(parseAtosLine("0x3fff0")).toBeNull();
  });

  test("splits inlined frames per address", () => {
    const stdout = [
      "inner(_:) (in Crash) (crash.swift:1)",
      "middle(_:) (in Crash) (crash.swift:2)",
      ATOS_GROUP_DELIMITER,
      "0x3fff0",
      ATOS_GROUP_DELIMITER,
      "",
    ].join("\n");
    const results = parseAtosOutput(stdout, ["0x890", "0x3fff0"]);
    expect(results[0]!.frames.map((frame) => frame.symbol)).toEqual([
      "inner(_:)",
      "middle(_:)",
    ]);
    expect(results[1]).toEqual({ offset: "0x3fff0", frames: [] });
  });

  test("refuses output that does not answer every address", () => {
    expect(() =>
      parseAtosOutput(`main (in Crash)\n${ATOS_GROUP_DELIMITER}\n`, [
        "0x1",
        "0x2",
      ]),
    ).toThrow("answered 1 addresses but 2 were requested");
  });

  test("validates agent results before they are stored", () => {
    expect(
      parseCrashSymbolicationResult({
        lookups: [
          {
            dsymId: "dsym-1",
            uuid: "776386d0-4386-3f24-9b21-5f7c02eb2873",
            results: [
              {
                offset: "0xD6C",
                frames: [
                  {
                    symbol: "Loader.item(at:)",
                    image: "CrashDemo",
                    file: "boom.swift",
                    line: 3,
                    symbolOffset: null,
                  },
                ],
              },
            ],
            error: null,
          },
        ],
        xcodeVersion: "Xcode 27.0",
      }).lookups[0]!.results[0]!.offset,
    ).toBe("0xd6c");
    expect(() =>
      parseCrashSymbolicationResult({
        lookups: [
          {
            dsymId: "d",
            uuid: "776386d0-4386-3f24-9b21-5f7c02eb2873",
            results: [{ offset: "0x1", frames: [{ symbol: "x", line: -1 }] }],
            error: null,
          },
        ],
        xcodeVersion: null,
      }),
    ).toThrow("line must be a non-negative integer");
  });
});
