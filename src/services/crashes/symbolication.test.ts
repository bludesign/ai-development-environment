import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { detectAndParse } from "./parsers";
import {
  crashSignature,
  displayThreads,
  mergeSymbolication,
  renderCrashText,
  settledStatus,
  symbolicationCandidates,
} from "./symbolication";
import { EMPTY_SYMBOLICATION } from "./types";

const APP_UUID = "776386D043863F249B215F7C02EB2873";
const crash = detectAndParse(
  readFileSync(resolve(__dirname, "__fixtures__/CrashDemo.ips")),
)[0]!;

const frame = (symbol: string, line: number) => ({
  symbol,
  image: "CrashDemo",
  file: "/src/boom.swift",
  line,
  symbolOffset: null,
});

function symbolicated(offsets: Record<string, ReturnType<typeof frame>[]>) {
  return mergeSymbolication(
    EMPTY_SYMBOLICATION,
    {
      lookups: [
        {
          dsymId: "dsym-1",
          uuid: APP_UUID,
          results: Object.entries(offsets).map(([offset, frames]) => ({
            offset,
            frames,
          })),
          error: null,
        },
      ],
      xcodeVersion: "Xcode 27.0",
    },
    { generation: 1, agentId: "agent-1", at: new Date("2026-09-24T00:00:00Z") },
  );
}

describe("crash symbolication", () => {
  test("asks only for app frames the device left unnamed", () => {
    const candidates = [...symbolicationCandidates(crash).values()];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.image.uuid).toBe(APP_UUID);
    expect([...candidates[0]!.offsets]).toEqual(["0xd6c", "0xb18", "0x9c8"]);
  });

  test("merges agent answers into the crashed thread, inlined frames first", () => {
    const result = symbolicated({
      "0xd6c": [frame("inner()", 2), frame("Loader.item(at:)", 3)],
      "0xb18": [frame("handleTap(_:)", 5)],
    });
    const [thread] = displayThreads(crash, result);
    const app = thread!.frames.filter((entry) => entry.isAppFrame);
    expect(
      app.map((entry) => [
        entry.index,
        entry.symbol,
        entry.sourceLine,
        entry.inlined,
        entry.symbolicated,
      ]),
    ).toEqual([
      [4, "inner()", 2, true, true],
      [4, "Loader.item(at:)", 3, false, true],
      [5, "handleTap(_:)", 5, false, true],
      [6, null, null, false, false],
    ]);
    expect(settledStatus(crash, result, new Set([APP_UUID]))).toEqual({
      status: "PARTIALLY_SYMBOLICATED",
      message: null,
    });
  });

  test("settles fully symbolicated, missing, and failed crashes", () => {
    const complete = symbolicated({
      "0xd6c": [frame("Loader.item(at:)", 3)],
      "0xb18": [frame("handleTap(_:)", 5)],
      "0x9c8": [frame("main", 6)],
    });
    expect(settledStatus(crash, complete, new Set([APP_UUID])).status).toBe(
      "SYMBOLICATED",
    );
    expect(settledStatus(crash, EMPTY_SYMBOLICATION, new Set())).toEqual({
      status: "MISSING_DSYMS",
      message: "Missing dSYMs for CrashDemo",
    });
    const failed = mergeSymbolication(
      EMPTY_SYMBOLICATION,
      {
        lookups: [
          {
            dsymId: "dsym-1",
            uuid: APP_UUID,
            results: [],
            error: "atos cannot load symbols",
          },
        ],
        xcodeVersion: null,
      },
      { generation: 1, agentId: null, at: new Date() },
    );
    expect(settledStatus(crash, failed, new Set([APP_UUID]))).toEqual({
      status: "FAILED",
      message: "atos cannot load symbols",
    });
  });

  test("keeps signatures stable for the same failure and readable", () => {
    const result = symbolicated({
      "0xd6c": [frame("Loader.item(at:)", 3)],
      "0xb18": [frame("handleTap(_:)", 5)],
    });
    const first = crashSignature(crash, result);
    expect(first.title).toBe("EXC_BREAKPOINT · Loader.item(at:)");
    expect(crashSignature(crash, result).signature).toBe(first.signature);
    expect(crashSignature(crash).signature).not.toBe(first.signature);
    expect(crashSignature(crash).title).toBe(
      "EXC_BREAKPOINT · CrashDemo+0xd6c",
    );
  });

  test("renders Apple's text format with the added symbols", () => {
    const text = renderCrashText(
      crash,
      symbolicated({ "0xd6c": [frame("Loader.item(at:)", 3)] }),
    );
    expect(text).toContain("Exception Type:  EXC_BREAKPOINT (SIGTRAP)");
    expect(text).toContain("Thread 0 Crashed:");
    expect(text).toMatch(
      /4 {3}CrashDemo\s+\t0x0000000104da8d6c Loader\.item\(at:\) \(boom\.swift:3\)/,
    );
    expect(text).toMatch(
      /5 {3}CrashDemo\s+\t0x0000000104da8b18 0x104da8000 \+ 2840/,
    );
    expect(text).toContain(
      "<776386d043863f249b215f7c02eb2873> /private/var/containers/Bundle/Application/5E0F/CrashDemo.app/CrashDemo",
    );
  });
});
