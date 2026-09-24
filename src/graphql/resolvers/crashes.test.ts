// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { detectAndParse } from "@/services/crashes/parsers";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createCrashResolvers } from "./crashes";

const crash = detectAndParse(
  readFileSync(
    resolve(process.cwd(), "src/services/crashes/__fixtures__/CrashDemo.ips"),
  ),
)[0]!;

const service = {
  crashReports: vi.fn(),
  dsymsByIds: vi.fn(async () => []),
  similarCrashes: vi.fn(),
  similarCrashCount: vi.fn(),
};
const resolvers = createCrashResolvers(service as never);

const row = {
  id: "crash-1",
  signature: "sig",
  normalizedJson: JSON.stringify(crash),
  symbolicationJson: JSON.stringify({
    generation: 0,
    agentId: "agent-1",
    xcodeVersion: null,
    symbolicatedAt: null,
    images: {
      "776386D043863F249B215F7C02EB2873": {
        dsymId: "dsym-1",
        error: null,
        offsets: {
          "0xd6c": [
            {
              symbol: "Loader.item(at:)",
              image: "CrashDemo",
              file: "/src/boom.swift",
              line: 3,
              symbolOffset: null,
            },
          ],
        },
      },
    },
  }),
  createdAt: new Date("2026-09-23T00:00:00Z"),
  updatedAt: new Date("2026-09-23T00:00:00Z"),
  crashedAt: null,
  symbolicatedAt: null,
  binaryImages: [{ imageIndex: 0, frameCount: 3, dsymId: null }],
};

describe("crash resolvers", () => {
  test("derives threads, the top app frame, and dashed UUIDs from the row", () => {
    const threads = resolvers.CrashReport.threads(row);
    expect(threads[0]!.frames[4]).toMatchObject({
      symbol: "Loader.item(at:)",
      sourceLine: 3,
      symbolicated: true,
      imageUuid: "776386D0-4386-3F24-9B21-5F7C02EB2873",
    });
    expect(resolvers.CrashReport.topAppFrame(row)).toMatchObject({
      symbol: "Loader.item(at:)",
    });
    expect(resolvers.CrashReport.symbolicatedText(row)).toContain(
      "Loader.item(at:) (boom.swift:3)",
    );
  });

  test("lists app binaries without a dSYM as missing", () => {
    const missing = resolvers.CrashReport.missingImages(row);
    expect(missing).toEqual([
      expect.objectContaining({
        name: "CrashDemo",
        uuid: "776386D0-4386-3F24-9B21-5F7C02EB2873",
        frameCount: 3,
      }),
    ]);
    expect(
      resolvers.CrashReport.missingImages({
        ...row,
        binaryImages: [{ imageIndex: 0, frameCount: 3, dsymId: "dsym-1" }],
      }),
    ).toEqual([]);
  });

  test("refuses agent credentials", () => {
    expect(() =>
      resolvers.Query.crashReports(null, {}, {
        agentId: "agent-1",
      } as GraphQLContext),
    ).toThrow("Agent credentials cannot perform crash operations");
    expect(service.crashReports).not.toHaveBeenCalled();
  });
});
