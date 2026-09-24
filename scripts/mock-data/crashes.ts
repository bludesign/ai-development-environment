import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { detectAndParse } from "../../src/services/crashes/parsers";
import {
  crashSignature,
  mergeSymbolication,
  settledStatus,
  symbolicationCandidates,
} from "../../src/services/crashes/symbolication";
import {
  EMPTY_SYMBOLICATION,
  type CrashReportStatus,
  type CrashSymbolication,
} from "../../src/services/crashes/types";
import { ids } from "./ids";
import { hoursAgo, minutesAgo, daysAgo } from "./time";

/**
 * Crash reports and dSYMs for the Crashes pages. The reports are the checked-in
 * CrashDemo fixtures renamed to the Acme app, so every format the parser
 * accepts shows up, and the symbols are what `atos` would have answered.
 */

const FIXTURES = path.resolve(
  process.cwd(),
  "src/services/crashes/__fixtures__",
);
const APP_UUID = "3F9C7E2A1B4D4C8E9A0B1C2D3E4F5A6B";
const WIDGETS_UUID = "8D2E4F607A1B4C3D9E8F0A1B2C3D4E5F";
const CI_APP_UUID = "C4D5E6F708194A2BB3C4D5E6F7081920";
const UNKNOWN_UUID = "5B6C7D8E9F014A2B8C3D4E5F60718293";

/** The crash data folder the screenshot server reads; kept apart from dev's. */
export function mockCrashDataDirectory(): string {
  return path.resolve(
    process.env.CRASH_DATA_DIRECTORY ?? "prisma/mock-crash-data",
  );
}

function dashed(uuid: string): string {
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

function acme(text: string, uuid: string): string {
  const fixture = "776386D043863F249B215F7C02EB2873";
  return text
    .replaceAll("com.example.CrashDemo", "com.acme.mobile")
    .replaceAll("CrashDemo", "AcmeApp")
    .replaceAll(dashed(fixture).toLowerCase(), dashed(uuid).toLowerCase())
    .replaceAll(dashed(fixture), dashed(uuid))
    .replaceAll(fixture.toLowerCase(), uuid.toLowerCase());
}

function ipsReport(uuid: string, version: string, build: string): string {
  const [header, ...rest] = acme(
    readFileSync(path.join(FIXTURES, "CrashDemo.ips"), "utf8"),
    uuid,
  ).split("\n");
  const head = JSON.parse(header!);
  const body = JSON.parse(rest.join("\n"));
  Object.assign(head, {
    bundleID: "com.acme.mobile",
    app_version: version,
    build_version: build,
    os_version: "iPhone OS 26.0 (23A341)",
    platform: 2,
  });
  Object.assign(body, {
    modelCode: "iPhone17,1",
    osVersion: { train: "iPhone OS 26.0", build: "23A341" },
  });
  return `${JSON.stringify(head)}\n${JSON.stringify(body, null, 2)}`;
}

const APP_SYMBOLS: Record<string, [string, string, number][]> = {
  "0xd6c": [["CartViewModel.item(at:)", "CartViewModel.swift", 88]],
  "0xb18": [
    ["CheckoutView.selectedItem.getter", "CheckoutView.swift", 139],
    ["CheckoutView.submit()", "CheckoutView.swift", 142],
  ],
  "0x9c8": [["AcmeApp.main()", "AcmeApp.swift", 12]],
};

function symbolicate(
  dsymId: string,
  uuid: string,
  at: Date,
): CrashSymbolication {
  return mergeSymbolication(
    EMPTY_SYMBOLICATION,
    {
      lookups: [
        {
          dsymId,
          uuid,
          error: null,
          results: Object.entries(APP_SYMBOLS).map(([offset, frames]) => ({
            offset,
            frames: frames.map(([symbol, file, line]) => ({
              symbol,
              image: "AcmeApp",
              file: `/Users/ci/acme/ios-app/Sources/${file}`,
              line,
              symbolOffset: null,
            })),
          })),
        },
      ],
      xcodeVersion: "Xcode 27.0 Build version 27A266a",
    },
    { generation: 0, agentId: ids.agents.build, at },
  );
}

type SeedCrash = {
  id: string;
  filename: string;
  contents: string;
  source: "UPLOAD" | "API";
  uploadedBy: string | null;
  apiKeyName: string | null;
  createdAt: Date;
  /** Receives when the crash arrived, so symbols land a moment later. */
  symbolication: (receivedAt: Date) => CrashSymbolication;
  matched: string[];
  status?: { status: CrashReportStatus; message: string | null };
  dsymId: string | null;
};

async function createCrash(prisma: PrismaClient, seed: SeedCrash) {
  const [crash] = detectAndParse(Buffer.from(seed.contents));
  const symbolication = seed.symbolication(seed.createdAt);
  const { signature, title } = crashSignature(crash!, symbolication);
  const status =
    seed.status ?? settledStatus(crash!, symbolication, new Set(seed.matched));
  const extension = path.extname(seed.filename);
  const storagePath = `reports/${seed.id}${extension}`;
  const directory = path.join(mockCrashDataDirectory(), "reports");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(mockCrashDataDirectory(), storagePath),
    seed.contents,
  );
  const candidates = symbolicationCandidates(crash!);
  await prisma.crashReport.create({
    data: {
      id: seed.id,
      format: crash!.format,
      source: seed.source,
      uploadedBy: seed.uploadedBy,
      apiKeyName: seed.apiKeyName,
      clientIp: seed.source === "API" ? "203.0.113.42" : null,
      filename: seed.filename,
      storagePath,
      sha256: createHash("sha256").update(seed.contents).digest("hex"),
      sizeBytes: Buffer.byteLength(seed.contents),
      incidentId: crash!.incidentId,
      appName: crash!.appName,
      bundleId: crash!.bundleId ?? "com.acme.mobile",
      appVersion: crash!.appVersion,
      buildVersion: crash!.buildVersion,
      osVersion: crash!.osVersion,
      deviceModel: crash!.deviceModel,
      arch: crash!.arch,
      exceptionType: crash!.exceptionType,
      exceptionCodes: crash!.exceptionCodes,
      signal: crash!.signal,
      terminationReason: crash!.terminationReason,
      crashedThread: crash!.crashedThread,
      crashedAt: new Date(seed.createdAt.getTime() - 90_000),
      signature,
      signatureTitle: title,
      status: status.status,
      statusMessage: status.message,
      attempts: status.status === "FAILED" ? 3 : 1,
      agentId: ids.agents.build,
      symbolicatedAt: symbolication.symbolicatedAt
        ? new Date(symbolication.symbolicatedAt)
        : null,
      normalizedJson: JSON.stringify(crash),
      symbolicationJson: JSON.stringify(symbolication),
      searchText: [
        crash!.appName,
        crash!.bundleId,
        crash!.appVersion,
        crash!.exceptionType,
        title,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
      createdAt: seed.createdAt,
      binaryImages: {
        create: crash!.images
          .filter((image) => image.isApp && image.uuid)
          .map((image) => ({
            id: randomUUID(),
            imageIndex: image.index,
            uuid: image.uuid!,
            name: image.name,
            arch: image.arch,
            loadAddress: image.base,
            path: image.path,
            frameCount: candidates.get(image.index)?.frames ?? 0,
            dsymId: seed.dsymId,
          })),
      },
    },
  });
}

type SeedDsym = {
  id: string;
  bundleName: string;
  binaryName: string;
  bundleIdentifier: string;
  shortVersion: string;
  bundleVersion: string;
  uuid: string;
  sizeBytes: number;
};

async function createUpload(
  prisma: PrismaClient,
  upload: {
    id: string;
    filename: string;
    source: "UPLOAD" | "API" | "BUILD";
    uploadedBy: string | null;
    buildId: string | null;
    linkedBuildId?: string;
    buildArtifactId?: string;
    url: string | null;
    projectName: string | null;
    status: "READY" | "FAILED";
    error?: string;
    createdAt: Date;
    dsyms: SeedDsym[];
  },
) {
  const storageDirectory = `dsyms/${upload.id}`;
  await prisma.dsymUpload.create({
    data: {
      id: upload.id,
      filename: upload.filename,
      sha256: createHash("sha256").update(upload.id).digest("hex"),
      sizeBytes:
        upload.dsyms.reduce((sum, dsym) => sum + dsym.sizeBytes, 0) / 3,
      storageDirectory: upload.status === "READY" ? storageDirectory : null,
      source: upload.source,
      uploadedBy: upload.uploadedBy,
      buildId: upload.buildId,
      linkedBuildId: upload.linkedBuildId ?? null,
      buildArtifactId: upload.buildArtifactId ?? null,
      url: upload.url,
      projectName: upload.projectName,
      status: upload.status,
      error: upload.error ?? null,
      attempts: 1,
      completedAt: upload.status === "READY" ? upload.createdAt : null,
      createdAt: upload.createdAt,
    },
  });
  for (const dsym of upload.dsyms) {
    const folder = `${storageDirectory}/${dsym.id}/${dsym.bundleName}/Contents`;
    await prisma.dsym.create({
      data: {
        id: dsym.id,
        uploadId: upload.id,
        bundleName: dsym.bundleName,
        binaryName: dsym.binaryName,
        bundleIdentifier: dsym.bundleIdentifier,
        shortVersion: dsym.shortVersion,
        bundleVersion: dsym.bundleVersion,
        dwarfPath: `${folder}/Resources/DWARF/${dsym.binaryName}`,
        dwarfSha256: createHash("sha256").update(dsym.id).digest("hex"),
        dwarfSizeBytes: dsym.sizeBytes,
        infoPlistPath: `${folder}/Info.plist`,
        searchText: [
          dsym.bundleName,
          dsym.bundleIdentifier,
          dsym.shortVersion,
          dsym.bundleVersion,
          upload.buildId,
          upload.projectName,
          dsym.uuid,
          dashed(dsym.uuid),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
        createdAt: upload.createdAt,
        slices: {
          create: {
            id: randomUUID(),
            uuid: dsym.uuid,
            arch: "arm64",
            textVmAddr: "0x100000000",
          },
        },
      },
    });
  }
}

export async function seedCrashes(prisma: PrismaClient): Promise<void> {
  await prisma.crashSettings.create({
    data: {
      id: "default",
      symbolicationAgentId: ids.agents.build,
      retentionDays: 90,
    },
  });

  await createUpload(prisma, {
    id: ids.dsymUploads.build,
    filename: `${ids.builds.archive}-dSYMs.zip`,
    source: "BUILD",
    uploadedBy: null,
    buildId: ids.builds.archive,
    linkedBuildId: ids.builds.archive,
    buildArtifactId: "artifact-archive-dsyms",
    url: null,
    projectName: "Acme Mobile",
    status: "READY",
    createdAt: hoursAgo(3),
    dsyms: [
      {
        id: ids.dsyms.app,
        bundleName: "AcmeApp.app.dSYM",
        binaryName: "AcmeApp",
        bundleIdentifier: "com.acme.mobile",
        shortVersion: "3.2.0",
        bundleVersion: "412",
        uuid: APP_UUID,
        sizeBytes: 118_400_000,
      },
      {
        id: ids.dsyms.widgets,
        bundleName: "AcmeWidgets.appex.dSYM",
        binaryName: "AcmeWidgets",
        bundleIdentifier: "com.acme.mobile.widgets",
        shortVersion: "3.2.0",
        bundleVersion: "412",
        uuid: WIDGETS_UUID,
        sizeBytes: 21_700_000,
      },
    ],
  });
  await createUpload(prisma, {
    id: ids.dsymUploads.ci,
    filename: "dSYMs.zip",
    source: "API",
    uploadedBy: "API key GitHub Actions",
    buildId: "1287",
    url: "https://github.com/acme/ios-app/actions/runs/1287",
    projectName: "Acme Mobile",
    status: "READY",
    createdAt: daysAgo(6),
    dsyms: [
      {
        id: ids.dsyms.ciApp,
        bundleName: "AcmeApp.app.dSYM",
        binaryName: "AcmeApp",
        bundleIdentifier: "com.acme.mobile",
        shortVersion: "3.1.0",
        bundleVersion: "398",
        uuid: CI_APP_UUID,
        sizeBytes: 112_900_000,
      },
    ],
  });
  await createUpload(prisma, {
    id: ids.dsymUploads.failed,
    filename: "dSYMs-1290.zip",
    source: "API",
    uploadedBy: "API key GitHub Actions",
    buildId: "1290",
    url: "https://github.com/acme/ios-app/actions/runs/1290",
    projectName: "Acme Mobile",
    status: "FAILED",
    error:
      "The zip holds no dSYM bundles. Zip the .dSYM folders, for example an archive's dSYMs folder",
    createdAt: minutesAgo(40),
    dsyms: [],
  });

  const symbolicated = (receivedAt: Date) =>
    symbolicate(
      ids.dsyms.app,
      APP_UUID,
      new Date(receivedAt.getTime() + 20_000),
    );
  await createCrash(prisma, {
    id: ids.crashes.checkout,
    filename: "AcmeApp-2026-01-28-091012.ips",
    contents: ipsReport(APP_UUID, "3.2.0", "412"),
    source: "API",
    uploadedBy: null,
    apiKeyName: null,
    createdAt: minutesAgo(25),
    symbolication: symbolicated,
    matched: [APP_UUID],
    dsymId: ids.dsyms.app,
  });
  await createCrash(prisma, {
    id: ids.crashes.checkoutRepeat,
    filename: "AcmeApp 2026-01-27.crash",
    contents: acme(
      readFileSync(path.join(FIXTURES, "CrashDemo.crash"), "utf8"),
      APP_UUID,
    ).replace(
      "Version:             2.4.0 (512)",
      "Version:             3.2.0 (412)",
    ),
    source: "UPLOAD",
    uploadedBy: "alex@acme.example.com",
    apiKeyName: null,
    createdAt: hoursAgo(20),
    symbolication: symbolicated,
    matched: [APP_UUID],
    dsymId: ids.dsyms.app,
  });
  await createCrash(prisma, {
    id: ids.crashes.metrickit,
    filename: "metrickit-payload.json",
    contents: acme(
      readFileSync(path.join(FIXTURES, "metrickit-payload.json"), "utf8"),
      UNKNOWN_UUID,
    )
      .replace('"appVersion": "2.4.0"', '"appVersion": "3.3.0"')
      .replace('"appBuildVersion": "512"', '"appBuildVersion": "418"'),
    source: "API",
    uploadedBy: null,
    apiKeyName: "Acme Mobile",
    createdAt: hoursAgo(5),
    symbolication: () => EMPTY_SYMBOLICATION,
    matched: [],
    dsymId: null,
  });
  await createCrash(prisma, {
    id: ids.crashes.failed,
    filename: "AcmeApp-2026-01-21-173344.ips",
    contents: ipsReport(CI_APP_UUID, "3.1.0", "398"),
    source: "API",
    uploadedBy: null,
    apiKeyName: null,
    createdAt: daysAgo(4),
    symbolication: () => EMPTY_SYMBOLICATION,
    matched: [CI_APP_UUID],
    status: {
      status: "FAILED",
      message:
        "atos cannot load symbols for the file AcmeApp for architecture arm64.",
    },
    dsymId: ids.dsyms.ciApp,
  });
}
