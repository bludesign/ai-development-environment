import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CrashDetailPage } from "./crash-detail-page";
import { CrashesPage } from "./crashes-page";
import { DsymsPage } from "./dsyms-page";
import type { CrashDetail, CrashSummary, DsymSummary } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
  onControlPlaneRecovery: () => () => undefined,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => "/crashes",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("buildId=build-1"),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const frame = {
  index: 4,
  imageName: "CrashDemo",
  imageUuid: "776386D0-4386-3F24-9B21-5F7C02EB2873",
  address: "0x104da8d6c",
  imageOffset: "0xd6c",
  symbol: "Loader.item(at:)",
  symbolOffset: null,
  sourceFile: "/src/boom.swift",
  sourceLine: 3,
  inlined: false,
  isAppFrame: true,
  symbolicated: true,
};

const crash: CrashSummary = {
  id: "crash-1",
  format: "IPS",
  source: "API",
  status: "SYMBOLICATED",
  statusMessage: null,
  filename: "CrashDemo.ips",
  appName: "CrashDemo",
  bundleId: "com.example.CrashDemo",
  appVersion: "2.4.0",
  buildVersion: "512",
  osVersion: "iPhone OS 26.0",
  deviceModel: "iPhone17,1",
  exceptionType: "EXC_BREAKPOINT",
  signal: "SIGTRAP",
  signatureTitle: "EXC_BREAKPOINT · Loader.item(at:)",
  crashedAt: "2026-09-20T21:21:33.000Z",
  createdAt: "2026-09-20T21:22:00.000Z",
  topAppFrame: frame,
};

const upload = {
  id: "upload-1",
  filename: "dSYMs.zip",
  status: "READY" as const,
  error: null,
  source: "BUILD" as const,
  uploadedBy: null,
  buildId: "build-1",
  linkedBuildId: "build-1",
  url: null,
  projectName: "Demo",
  sizeBytes: 5918,
  uploadOffset: 0,
  attempts: 1,
  dsymCount: 1,
  createdAt: "2026-09-20T20:00:00.000Z",
  updatedAt: "2026-09-20T20:00:00.000Z",
  completedAt: "2026-09-20T20:00:01.000Z",
};

const dsym: DsymSummary = {
  id: "dsym-1",
  bundleName: "CrashDemo.dSYM",
  binaryName: "CrashDemo",
  bundleIdentifier: "com.example.CrashDemo",
  shortVersion: "2.4.0",
  bundleVersion: "512",
  dwarfSizeBytes: 14236,
  createdAt: "2026-09-20T20:00:01.000Z",
  crashCount: 1,
  slices: [
    {
      id: "slice-1",
      uuid: "776386D0-4386-3F24-9B21-5F7C02EB2873",
      arch: "arm64",
      textVmAddr: "0x100000000",
    },
  ],
  upload,
};

test("lists crash reports with their status and top app frame", async () => {
  request.mockResolvedValue({
    crashReports: {
      nodes: [crash],
      nextCursor: null,
      totalCount: 1,
      matchingCount: 1,
    },
    crashFacets: {
      apps: [
        { bundleId: "com.example.CrashDemo", appName: "CrashDemo", count: 1 },
      ],
      appVersions: ["2.4.0"],
    },
  } as never);
  render(<CrashesPage />);
  expect(await screen.findByText("CrashDemo")).toBeTruthy();
  expect(screen.getByText("EXC_BREAKPOINT · Loader.item(at:)")).toBeTruthy();
  expect(screen.getByText("boom.swift:3")).toBeTruthy();
  expect(screen.getByText("2.4.0 (512)")).toBeTruthy();
  expect(screen.getAllByText("Symbolicated").length).toBeGreaterThan(0);
  expect(request.mock.calls[0]![0]).toContain("query CrashesPage");
});

test("filters dSYMs by the build in the address and links the build", async () => {
  request.mockResolvedValue({
    dsyms: { nodes: [dsym], nextCursor: null, totalCount: 1, matchingCount: 1 },
    dsymProjects: ["Demo"],
    dsymUploads: [
      {
        ...upload,
        id: "upload-2",
        filename: "Big.zip",
        status: "FAILED",
        error: "The zip holds no dSYM bundles",
      },
    ],
  } as never);
  render(<DsymsPage />);
  expect(await screen.findByText("CrashDemo.dSYM")).toBeTruthy();
  expect(request.mock.calls[0]![1]).toMatchObject({
    filter: { buildId: "build-1" },
  });
  expect(screen.getByText("776386D0-4386-3F24-9B21-5F7C02EB2873")).toBeTruthy();
  expect(screen.getByText("build-1").closest("a")?.getAttribute("href")).toBe(
    "/builds/build-1",
  );
  expect(screen.getByText("The zip holds no dSYM bundles")).toBeTruthy();
});

test("shows missing dSYMs and the symbolicated threads of a crash", async () => {
  const detail: CrashDetail = {
    ...crash,
    status: "PARTIALLY_SYMBOLICATED",
    statusMessage: "Missing dSYMs for Widgets",
    sizeBytes: 6985,
    incidentId: "6DDE6F6E",
    arch: "ARM-64",
    exceptionCodes: "0x1",
    exceptionSubtype: null,
    exceptionReason: null,
    terminationReason: "SIGNAL 5 Trace/BPT trap: 5",
    applicationSpecificInformation: ["Fatal error: Index out of range"],
    crashedThread: 0,
    updatedAt: crash.createdAt,
    symbolicatedAt: crash.createdAt,
    signature: "abc123",
    uploadedBy: null,
    apiKeyName: "CI",
    clientIp: null,
    attempts: 1,
    threads: [
      {
        index: 0,
        name: null,
        queue: "com.apple.main-thread",
        crashed: true,
        frames: [
          { ...frame, index: 4, symbol: "inner()", inlined: true },
          frame,
        ],
      },
    ],
    lastExceptionBacktrace: null,
    binaryImages: [],
    missingImages: [
      {
        id: "crash-1:2",
        uuid: "11111111-2222-3333-4444-555555555555",
        name: "Widgets",
        arch: "arm64",
        loadAddress: "0x1",
        path: null,
        isApp: true,
        frameCount: 2,
        dsym: null,
      },
    ],
    attachedDsyms: [dsym],
    similarCrashCount: 0,
    similarCrashes: [],
    symbolicatedText: "Thread 0 Crashed:",
    originalDownloadUrl: "/api/crash-files/reports/crash-1",
    symbolicatedDownloadUrl:
      "/api/crash-files/reports/crash-1?variant=symbolicated",
  };
  request.mockResolvedValue({ crashReport: detail } as never);
  render(<CrashDetailPage crashId="crash-1" />);
  expect(await screen.findByText("dSYMs are missing")).toBeTruthy();
  expect(
    screen.getByText("Widgets · 11111111-2222-3333-4444-555555555555 (arm64)"),
  ).toBeTruthy();
  expect(screen.getByText("Missing dSYMs for Widgets")).toBeTruthy();
  expect(screen.getByText("inner()")).toBeTruthy();
  expect(screen.getAllByText("Loader.item(at:)").length).toBeGreaterThan(0);
  expect(screen.getByText("Fatal error: Index out of range")).toBeTruthy();
  await waitFor(() =>
    expect(
      screen
        .getByText("Symbolicated report")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/api/crash-files/reports/crash-1?variant=symbolicated"),
  );
});
