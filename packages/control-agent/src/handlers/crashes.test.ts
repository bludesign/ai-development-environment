import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ATOS_GROUP_DELIMITER } from "@ai-development-environment/agent-contract/crashes";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const captureCommand = vi.hoisted(() => vi.fn());
vi.mock("../capture-command.js", () => ({ captureCommand }));

import { symbolicateCrash, trimDsymCache } from "./crashes.js";

const dwarf = Buffer.from("pretend DWARF bytes");
const sha256 = createHash("sha256").update(dwarf).digest("hex");
let cache: string;

beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "aide-dsym-cache-"));
  process.env.CONTROL_AGENT_DSYM_CACHE = cache;
  captureCommand.mockReset();
});

afterEach(async () => {
  delete process.env.CONTROL_AGENT_DSYM_CACHE;
  await rm(cache, { recursive: true, force: true });
});

function payload(offsets = ["0xd6c", "0xb18"]) {
  return {
    crashId: "crash-1",
    dsyms: [
      {
        dsymId: "dsym-1",
        sha256,
        sizeBytes: dwarf.length,
        binaryName: "CrashDemo",
        downloadPath: "/api/agent/dsyms/dsym-1/dwarf",
      },
    ],
    lookups: [
      {
        dsymId: "dsym-1",
        uuid: "776386D043863F249B215F7C02EB2873",
        arch: "arm64",
        offsets,
      },
    ],
  };
}

const downloadDsymDwarf = vi.fn(async (input: { path: string }) => {
  await writeFile(input.path, dwarf);
});

function context() {
  return {
    agentId: "agent-1",
    reportWorktreeActivity: async () => null,
    downloadDsymDwarf,
  };
}

function atos(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout,
    stderr: "",
    outputTruncated: false,
  };
}

async function run(value = payload()) {
  return symbolicateCrash(
    value,
    60_000,
    new AbortController().signal,
    async () => undefined,
    context(),
  );
}

describe("crash symbolication handler", () => {
  test("downloads each DWARF file once and returns atos answers", async () => {
    captureCommand.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "xcodebuild") return atos("Xcode 27.0\nBuild 27A266a\n");
      const offsetsFile = args[args.indexOf("-f") + 1]!;
      expect(await readFile(offsetsFile, "utf8")).toBe("0xd6c\n0xb18\n");
      expect(args).toContain(join(cache, sha256, "CrashDemo"));
      return atos(
        [
          "inner() (in CrashDemo) (/src/boom.swift:2)",
          "Loader.item(at:) (in CrashDemo) (/src/boom.swift:3)",
          ATOS_GROUP_DELIMITER,
          "0xb18",
          ATOS_GROUP_DELIMITER,
          "",
        ].join("\n"),
      );
    });
    const result = (await run()) as unknown as {
      exitCode: number;
      lookups: {
        results: { offset: string; frames: { symbol: string }[] }[];
        error: string | null;
      }[];
      xcodeVersion: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.xcodeVersion).toBe("Xcode 27.0 Build 27A266a");
    expect(result.lookups[0]!.error).toBeNull();
    expect(
      result.lookups[0]!.results.map((entry) =>
        entry.frames.map((frame) => frame.symbol),
      ),
    ).toEqual([["inner()", "Loader.item(at:)"], []]);

    downloadDsymDwarf.mockClear();
    await run();
    expect(downloadDsymDwarf).not.toHaveBeenCalled();
  });

  test("reports an atos failure on the image instead of failing the job", async () => {
    captureCommand.mockImplementation(async ({ args }: { args: string[] }) =>
      args[0] === "xcodebuild"
        ? atos("")
        : {
            ...atos(""),
            exitCode: 1,
            stderr:
              "atos cannot load symbols for the file for architecture arm64e.",
          },
    );
    const result = (await run()) as unknown as {
      exitCode: number;
      lookups: { error: string | null }[];
    };
    expect(result.exitCode).toBe(0);
    expect(result.lookups[0]!.error).toContain("cannot load symbols");
  });

  test("records a failed download against the image that needed it", async () => {
    downloadDsymDwarf.mockRejectedValueOnce(
      new Error("Downloaded dSYM checksum did not match"),
    );
    captureCommand.mockResolvedValue(atos(""));
    const result = (await run()) as unknown as {
      lookups: { error: string | null }[];
    };
    expect(result.lookups[0]!.error).toBe(
      "Downloaded dSYM checksum did not match",
    );
    expect(await readdir(join(cache, sha256))).toEqual([]);
  });

  test("evicts the least recently used cache entries past the limit", async () => {
    for (const [name, age] of [
      ["old", 3],
      ["newer", 2],
      ["kept", 1],
    ] as const) {
      await mkdir(join(cache, name));
      await writeFile(join(cache, name, "binary"), Buffer.alloc(10));
      const time = new Date(Date.now() - age * 60_000);
      await utimes(join(cache, name), time, time);
    }
    await trimDsymCache(cache, new Set(["kept"]), 15);
    expect((await readdir(cache)).sort()).toEqual(["kept"]);
  });
});
