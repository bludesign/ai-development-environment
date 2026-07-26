import { describe, expect, test } from "vitest";

import { parseAgentDiskSpaceReport } from "./disk-space.js";

const report = () => ({
  observedAt: new Date().toISOString(),
  volumes: [
    {
      id: "device-1",
      totalBytes: 100,
      freeBytes: 40,
      roles: ["MAIN"],
      paths: ["/"],
    },
  ],
  entries: [
    {
      path: "/DerivedData/App-hash",
      rootPath: "/DerivedData",
      name: "App-hash",
      kind: "PROJECT",
      workspacePath: "/Repos/App/App.xcodeproj",
      modifiedAt: new Date(0).toISOString(),
      volumeId: "device-1",
    },
  ],
  warnings: [],
});

describe("disk space report parser", () => {
  test("accepts a well-formed report", () => {
    expect(parseAgentDiskSpaceReport(report())).toMatchObject({
      volumes: [{ id: "device-1", capacityId: "device-1" }],
      entries: [{ name: "App-hash" }],
    });
  });

  test("preserves shared capacity identifiers while accepting legacy reports", () => {
    const current = report();
    expect(
      parseAgentDiskSpaceReport({
        ...current,
        volumes: current.volumes.map((volume) => ({
          ...volume,
          capacityId: "apfs:disk3",
        })),
      }).volumes[0]?.capacityId,
    ).toBe("apfs:disk3");
    expect(parseAgentDiskSpaceReport(report()).volumes[0]?.capacityId).toBe(
      "device-1",
    );
  });

  test("rejects duplicate volumes and entries mapped to unknown filesystems", () => {
    const duplicate = report();
    duplicate.volumes.push({ ...duplicate.volumes[0]! });
    expect(() => parseAgentDiskSpaceReport(duplicate)).toThrow("Duplicate");

    const unknown = report();
    unknown.entries[0]!.volumeId = "missing";
    expect(() => parseAgentDiskSpaceReport(unknown)).toThrow("unknown volume");
  });

  test("rejects impossible capacity readings and future timestamps", () => {
    const impossible = report();
    impossible.volumes[0]!.freeBytes = 101;
    expect(() => parseAgentDiskSpaceReport(impossible)).toThrow("exceed total");

    const future = report();
    future.observedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(() => parseAgentDiskSpaceReport(future)).toThrow("future");
  });
});
