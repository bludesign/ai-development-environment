import { describe, expect, test, vi } from "vitest";

import type { NormalizedCrash } from "@/services/crashes/types";
import { createCrashToolGroup } from "./crashes";

const now = new Date("2026-09-29T12:00:00.000Z");
const normalized: NormalizedCrash = {
  format: "IPS",
  incidentId: "incident-1",
  appName: "Example",
  bundleId: "com.example.app",
  appVersion: "1.0",
  buildVersion: "10",
  osVersion: "iOS 26",
  deviceModel: "iPhone",
  arch: "arm64",
  processName: "Example",
  processPath: null,
  crashedAt: now.toISOString(),
  exceptionType: "EXC_BAD_ACCESS",
  exceptionCodes: null,
  signal: "SIGSEGV",
  exceptionSubtype: null,
  exceptionReason: null,
  terminationReason: null,
  applicationSpecificInformation: [],
  crashedThread: 0,
  lastExceptionBacktrace: null,
  images: [
    {
      index: 0,
      uuid: "ABC",
      name: "Example",
      arch: "arm64",
      base: "0x1000",
      size: 100,
      path: null,
      isApp: true,
    },
  ],
  threads: [
    {
      index: 0,
      name: "Main",
      queue: "main",
      crashed: true,
      frames: [
        {
          imageIndex: 0,
          imageName: "Example",
          imageOffset: "0x10",
          address: "0x1010",
          symbol: "App.start",
          symbolOffset: 0,
          sourceFile: "App.swift",
          sourceLine: 42,
        },
      ],
    },
  ],
};
const crash = {
  id: "crash-1",
  filename: "Example.ips",
  format: "IPS",
  status: "MISSING_DSYMS",
  statusMessage: null,
  appName: "Example",
  bundleId: "com.example.app",
  appVersion: "1.0",
  buildVersion: "10",
  exceptionType: "EXC_BAD_ACCESS",
  signal: "SIGSEGV",
  signature: "signature",
  signatureTitle: "App.start",
  crashedAt: now,
  createdAt: now,
  symbolicatedAt: null,
  normalizedJson: JSON.stringify(normalized),
  symbolicationJson: "{}",
  storagePath: "/private/storage/secret-crash",
  apiKeyId: "secret-key",
  clientIp: "secret-ip",
  searchText: "internal-search",
  binaryImages: [{ imageIndex: 0, frameCount: 1, dsymId: null }],
};
const dsym = {
  id: "dsym-1",
  bundleName: "Example.dSYM",
  binaryName: "Example",
  bundleIdentifier: "com.example.app",
  shortVersion: "1.0",
  bundleVersion: "10",
  dwarfSizeBytes: 512,
  createdAt: now,
  dwarfPath: "/private/secret-dwarf",
  infoPlistPath: "/private/secret-info",
  searchText: "internal-search",
  upload: {
    id: "upload-1",
    filename: "Example.zip",
    status: "READY",
    source: "BUILD",
    buildId: "build-1",
    linkedBuildId: "build-1",
    projectName: "Example",
    ownerKey: "secret-owner",
    apiKeyId: "secret-api",
    stagingPath: "/private/secret-stage",
    storageDirectory: "/private/secret-storage",
    url: "https://example.com/?token=secret-url",
  },
  slices: [
    {
      id: "slice-1",
      uuid: "ABC",
      arch: "arm64",
      textVmAddr: "0x1000",
      dsymId: "dsym-1",
    },
  ],
};

function tool(group: ReturnType<typeof createCrashToolGroup>, name: string) {
  return group.tools.find((entry) => entry.name === name)!;
}

describe("crash investigation MCP tools", () => {
  test.each([
    ["get_crash_reports", { filter: { search: "x".repeat(201) } }],
    ["get_crash_reports", { after: "x".repeat(4097) }],
    ["get_crash_reports", { filter: { bundleId: "x".repeat(257) } }],
    ["get_crash_report", { id: "x".repeat(257) }],
    ["get_dsyms", { filter: { search: "x".repeat(201) } }],
    ["get_dsyms", { after: "x".repeat(4097) }],
    ["get_dsyms", { filter: { uuid: "x".repeat(257) } }],
    ["get_dsym", { id: "x".repeat(257) }],
  ])(
    "rejects oversized %s filters before querying stored diagnostics",
    async (name, input) => {
      const query = vi.fn();
      const group = createCrashToolGroup({
        crashReports: query,
        crashReport: query,
        dsyms: query,
        dsym: query,
      } as never);
      await expect(tool(group, name).invoke(input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );

  test("paginates summaries with filters and excludes raw report storage fields", async () => {
    const crashReports = vi.fn().mockResolvedValue({
      nodes: [crash],
      nextCursor: "next",
      totalCount: 3,
      matchingCount: 1,
    });
    const group = createCrashToolGroup({ crashReports } as never);
    const result = await tool(group, "get_crash_reports").invoke({
      filter: { bundleId: "com.example.app" },
      after: "cursor",
    });
    expect(crashReports).toHaveBeenCalledWith(
      { bundleId: "com.example.app" },
      50,
      "cursor",
    );
    expect(result).toMatchObject({
      page: {
        nodes: [{ id: "crash-1", createdAt: now.toISOString() }],
        nextCursor: "next",
        matchingCount: 1,
      },
    });
    for (const forbidden of [
      "secret",
      "normalizedJson",
      "symbolicationJson",
      "binaryImages",
      "searchText",
    ]) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
    await expect(
      tool(group, "get_crash_reports").invoke({ first: 201 }),
    ).rejects.toThrow();
    await expect(
      tool(group, "get_crash_reports").invoke({
        filter: { status: "UNKNOWN" },
      }),
    ).rejects.toThrow();
    expect(crashReports).toHaveBeenCalledTimes(1);
  });

  test("renders readable frames and missing dSYMs without exposing original uploads", async () => {
    const crashReport = vi
      .fn()
      .mockResolvedValueOnce(crash)
      .mockResolvedValueOnce(null);
    const group = createCrashToolGroup({ crashReport } as never);
    const result = await tool(group, "get_crash_report").invoke({
      id: "crash-1",
    });
    expect(crashReport).toHaveBeenCalledWith("crash-1");
    expect(result).toMatchObject({
      crash: {
        threads: [
          { crashed: true, frames: [{ symbol: "App.start", sourceLine: 42 }] },
        ],
        symbolicatedText: expect.stringContaining("App.start"),
        images: [
          { name: "Example", uuid: "ABC", missingDsym: true, dsymId: null },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("normalizedJson");
    await expect(
      tool(group, "get_crash_report").invoke({ id: "missing" }),
    ).resolves.toEqual({ crash: null });
  });

  test("returns only dSYM metadata and architecture slices", async () => {
    const dsyms = vi.fn().mockResolvedValue({
      nodes: [dsym],
      nextCursor: null,
      totalCount: 1,
      matchingCount: 1,
    });
    const get = vi.fn().mockResolvedValueOnce(dsym).mockResolvedValueOnce(null);
    const group = createCrashToolGroup({ dsyms, dsym: get } as never);
    const result = await tool(group, "get_dsyms").invoke({
      filter: { uuid: "ABC" },
      first: 10,
    });
    expect(dsyms).toHaveBeenCalledWith({ uuid: "ABC" }, 10, undefined);
    expect(result).toMatchObject({
      page: {
        nodes: [
          {
            slices: [{ uuid: "ABC", arch: "arm64" }],
            upload: { buildId: "build-1" },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("searchText");
    await tool(group, "get_dsym").invoke({ id: "dsym-1" });
    expect(get).toHaveBeenCalledWith("dsym-1");
    await expect(
      tool(group, "get_dsym").invoke({ id: "missing" }),
    ).resolves.toEqual({ dsym: null });
    expect(
      group.tools.every(
        ({ annotations }) =>
          annotations.readOnlyHint && !annotations.destructiveHint,
      ),
    ).toBe(true);
  });
});
