import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, fromNow, hoursAgo, minutesAgo, secondsAgo } from "./time";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

type ScanEntry = {
  path: string;
  rootPath: string;
  name: string;
  kind: "PROJECT" | "PENDING" | "SHARED_CACHE" | "DEVICE_SUPPORT";
  workspacePath: string | null;
  modifiedAt: string;
  volumeId: string;
  sizeBytes: number;
};

/**
 * One agent's Derived Data as its `buildData.scan` job reported it. `workspacePath` is what
 * links an entry to a worktree, so the Studio Mac paths below match the folders codebases.ts
 * checks out; the other agents own no worktrees and their entries render as unlinked.
 */
function scan(
  rootFolder: string,
  volumeId: string,
  entries: Omit<ScanEntry, "rootPath" | "volumeId">[],
): ScanEntry[] {
  const rootPath = `${rootFolder}/Library/Developer/Xcode/DerivedData`;
  return entries.map((entry) => ({ ...entry, rootPath, volumeId }));
}

const STUDIO_ENTRIES = scan("/Users/acme", "disk3s5", [
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/AcmeWebApp-abcdefghijklmnop",
    name: "AcmeWebApp-abcdefghijklmnop",
    kind: "PROJECT",
    workspacePath: "/Users/acme/Repositories/web-app",
    modifiedAt: hoursAgo(4).toISOString(),
    sizeBytes: 12 * GIB,
  },
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/AcmeWebApp-qrstuvwxyz012345",
    name: "AcmeWebApp-qrstuvwxyz012345",
    kind: "PROJECT",
    workspacePath: "/Users/acme/Repositories/web-app-quick-search",
    modifiedAt: hoursAgo(1).toISOString(),
    sizeBytes: 7 * GIB,
  },
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/AcmeiOSApp-hijklmnopqrstuvw",
    name: "AcmeiOSApp-hijklmnopqrstuvw",
    kind: "PROJECT",
    workspacePath: "/Users/acme/Repositories/ios-app",
    modifiedAt: hoursAgo(9).toISOString(),
    sizeBytes: 24 * GIB,
  },
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/ModuleCache.noindex",
    name: "ModuleCache.noindex",
    kind: "SHARED_CACHE",
    workspacePath: null,
    modifiedAt: daysAgo(1).toISOString(),
    sizeBytes: 3 * GIB,
  },
]);

const BUILD_ENTRIES = scan("/Users/acme", "disk2s4", [
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/AcmeiOSApp-zyxwvutsrqponmlk",
    name: "AcmeiOSApp-zyxwvutsrqponmlk",
    kind: "PROJECT",
    workspacePath: "/Users/acme/Builds/ios-app",
    modifiedAt: hoursAgo(2).toISOString(),
    sizeBytes: 41 * GIB,
  },
  {
    path: "/Users/acme/Library/Developer/Xcode/DerivedData/ModuleCache.noindex",
    name: "ModuleCache.noindex",
    kind: "SHARED_CACHE",
    workspacePath: null,
    modifiedAt: hoursAgo(6).toISOString(),
    sizeBytes: 6 * GIB,
  },
  {
    path: "/Users/acme/Library/Developer/Xcode/iOS DeviceSupport/17.5 (21F79)",
    name: "17.5 (21F79)",
    kind: "DEVICE_SUPPORT",
    workspacePath: null,
    modifiedAt: daysAgo(12).toISOString(),
    sizeBytes: 780 * MIB,
  },
]);

const CI_ENTRIES = scan("/Users/ci", "disk4s2", [
  {
    path: "/Users/ci/Library/Developer/Xcode/DerivedData/AcmeiOSApp-0123456789abcdef",
    name: "AcmeiOSApp-0123456789abcdef",
    kind: "PROJECT",
    workspacePath: "/Users/ci/checkouts/ios-app",
    modifiedAt: hoursAgo(3).toISOString(),
    sizeBytes: 18 * GIB,
  },
  {
    path: "/Users/ci/Library/Developer/Xcode/DerivedData/ModuleCache.noindex",
    name: "ModuleCache.noindex",
    kind: "SHARED_CACHE",
    workspacePath: null,
    modifiedAt: hoursAgo(5).toISOString(),
    sizeBytes: 2 * GIB,
  },
]);

const AGENT_SCANS = [
  { agentId: ids.agents.studio, entries: STUDIO_ENTRIES, warnings: [] },
  { agentId: ids.agents.build, entries: BUILD_ENTRIES, warnings: [] },
  {
    agentId: ids.agents.ci,
    entries: CI_ENTRIES,
    warnings: ["Skipped /Volumes/Scratch: the volume was not mounted."],
  },
];

/**
 * A *finished* Derived Data scan under a fixed id. The Build Data page starts a collection
 * under a client-generated request id on mount and then waits for every online agent to scan;
 * with no agent connected, each capture used to photograph the "queued" progress card and left
 * three QUEUED jobs behind — jobs the Polling page then counted as pending reconciliation work,
 * which is why that count drifted between runs. The `build-data` route in playwright/routes.ts
 * pins `crypto.randomUUID` to this id, so the page finds this collection already complete and
 * dispatches nothing.
 */
export async function seedBuildData(prisma: PrismaClient): Promise<void> {
  await prisma.buildDataCollection.create({
    data: {
      id: ids.buildDataCollections.captured,
      createdAt: minutesAgo(2),
      // Never reached: the collection finished first. A deadline in the future also keeps the
      // expiry pass from touching it if the fixture is ever loaded without `finishedAt`.
      deadlineAt: fromNow(30_000),
      finishedAt: secondsAgo(115),
      agents: {
        // QUEUING is the "a job was dispatched for this agent" state; the scan jobs below
        // carry the reports that turn each member SUCCEEDED.
        create: AGENT_SCANS.map(({ agentId }) => ({
          agentId,
          initialStatus: "QUEUING",
        })),
      },
    },
  });

  await prisma.agentJob.createMany({
    data: AGENT_SCANS.map(({ agentId, entries, warnings }) => ({
      id: `job-build-data-scan-${agentId}`,
      agentId,
      kind: "buildData.scan",
      payloadJson: JSON.stringify({
        mode: "DEFAULT",
        path: null,
        worktrees: [],
      }),
      status: "SUCCEEDED",
      idempotencyKey: `build-data:scan:${ids.buildDataCollections.captured}`,
      buildDataCollectionId: ids.buildDataCollections.captured,
      resultJson: JSON.stringify({
        entries: entries.map(({ sizeBytes: _sizeBytes, ...entry }) => entry),
        warnings,
      }),
      timeoutSeconds: 600,
      visibility: "SYSTEM",
      createdAt: minutesAgo(2),
      startedAt: minutesAgo(2),
      finishedAt: secondsAgo(115),
    })),
  });

  // Sizes are a second, opt-in pass behind the page's "Calculate sizes" button. Seeding one
  // finished pass shows the entry table with real numbers instead of empty size cells.
  await prisma.agentJob.createMany({
    data: AGENT_SCANS.map(({ agentId, entries }) => ({
      id: `job-build-data-size-${agentId}`,
      agentId,
      kind: "buildData.size",
      payloadJson: JSON.stringify({
        targets: entries.map(({ path, rootPath }) => ({ path, rootPath })),
      }),
      status: "SUCCEEDED",
      idempotencyKey: `build-data:size:${ids.buildDataCollections.captured}`,
      buildDataCollectionId: ids.buildDataCollections.captured,
      resultJson: JSON.stringify({
        sizes: entries.map(({ path, sizeBytes }) => ({
          path,
          sizeBytes,
          error: null,
        })),
      }),
      timeoutSeconds: 600,
      visibility: "SYSTEM",
      createdAt: secondsAgo(110),
      startedAt: secondsAgo(110),
      finishedAt: secondsAgo(105),
    })),
  });
}
