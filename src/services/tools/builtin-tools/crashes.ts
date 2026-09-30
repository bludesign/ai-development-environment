import * as z from "zod/v4";

import {
  crashSymbolication,
  normalizedCrash,
  type CrashesService,
} from "@/services/crashes/crashes.service";
import {
  displayThreads,
  renderCrashText,
} from "@/services/crashes/symbolication";
import { CRASH_REPORT_STATUSES } from "@/services/crashes/types";

import { defineTool, type BuiltInToolGroup } from "../builtin-tools";

const PageInput = z.object({
  first: z.number().int().min(1).max(200).default(50),
  after: z.string().max(4096).nullable().optional(),
});
const PageMetadata = z.object({
  nextCursor: z.string().nullable(),
  totalCount: z.number().int(),
  matchingCount: z.number().int(),
});
const CrashSummary = z.object({
  id: z.string(),
  filename: z.string(),
  format: z.string(),
  status: z.string(),
  statusMessage: z.string().nullable(),
  appName: z.string().nullable(),
  bundleId: z.string().nullable(),
  appVersion: z.string().nullable(),
  buildVersion: z.string().nullable(),
  exceptionType: z.string().nullable(),
  signal: z.string().nullable(),
  signature: z.string(),
  signatureTitle: z.string(),
  crashedAt: z.string().nullable(),
  createdAt: z.string(),
  symbolicatedAt: z.string().nullable(),
});
const FrameSchema = z.object({
  index: z.number().int(),
  imageName: z.string().nullable(),
  imageUuid: z.string().nullable(),
  address: z.string().nullable(),
  imageOffset: z.string().nullable(),
  symbol: z.string().nullable(),
  symbolOffset: z.number().nullable(),
  sourceFile: z.string().nullable(),
  sourceLine: z.number().nullable(),
  inlined: z.boolean(),
  isAppFrame: z.boolean(),
  symbolicated: z.boolean(),
});
const CrashDetail = CrashSummary.extend({
  threads: z.array(
    z.object({
      index: z.number().int(),
      name: z.string().nullable(),
      queue: z.string().nullable(),
      crashed: z.boolean(),
      frames: z.array(FrameSchema),
    }),
  ),
  symbolicatedText: z.string(),
  images: z.array(
    z.object({
      name: z.string(),
      uuid: z.string().nullable(),
      arch: z.string().nullable(),
      isApp: z.boolean(),
      dsymId: z.string().nullable(),
      missingDsym: z.boolean(),
    }),
  ),
});
const DsymSchema = z.object({
  id: z.string(),
  bundleName: z.string(),
  binaryName: z.string(),
  bundleIdentifier: z.string().nullable(),
  shortVersion: z.string().nullable(),
  bundleVersion: z.string().nullable(),
  dwarfSizeBytes: z.number(),
  createdAt: z.string(),
  upload: z.object({
    id: z.string(),
    filename: z.string(),
    status: z.string(),
    source: z.string(),
    buildId: z.string().nullable(),
    linkedBuildId: z.string().nullable(),
    projectName: z.string().nullable(),
  }),
  slices: z.array(
    z.object({
      id: z.string(),
      uuid: z.string(),
      arch: z.string(),
      textVmAddr: z.string(),
    }),
  ),
});

type CrashRow = NonNullable<Awaited<ReturnType<CrashesService["crashReport"]>>>;
function crashSummary(row: CrashRow) {
  return CrashSummary.parse({
    ...row,
    crashedAt: row.crashedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    symbolicatedAt: row.symbolicatedAt?.toISOString() ?? null,
  });
}

function crashDetail(row: CrashRow) {
  const crash = normalizedCrash(row);
  const symbols = crashSymbolication(row);
  const storedImages = new Map(
    row.binaryImages.map((image) => [image.imageIndex, image]),
  );
  return {
    ...crashSummary(row),
    threads: crash ? displayThreads(crash, symbols) : [],
    symbolicatedText: crash ? renderCrashText(crash, symbols) : "",
    images: crash
      ? crash.images.map((image) => {
          const stored = storedImages.get(image.index);
          return {
            name: image.name,
            uuid: image.uuid,
            arch: image.arch,
            isApp: image.isApp,
            dsymId: stored?.dsymId ?? null,
            missingDsym:
              image.isApp && (stored?.frameCount ?? 0) > 0 && !stored?.dsymId,
          };
        })
      : [],
  };
}

function dsymView(
  row: NonNullable<Awaited<ReturnType<CrashesService["dsym"]>>>,
) {
  // Explicit schemas strip filesystem locations, upload ownership, and API key IDs.
  return DsymSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

export function createCrashToolGroup(
  service: CrashesService,
): BuiltInToolGroup {
  return {
    id: "builtin:crashes",
    name: "Crashes and dSYMs",
    children: [],
    tools: [
      defineTool({
        name: "get_crash_reports",
        title: "Get crash reports",
        description:
          "List crash report summaries with cursor pagination and filters for app, version, signature, or symbolication status.",
        inputSchema: PageInput.extend({
          filter: z
            .object({
              search: z.string().max(200).optional(),
              status: z.enum(CRASH_REPORT_STATUSES).optional(),
              bundleId: z.string().max(256).optional(),
              appVersion: z.string().max(256).optional(),
              signature: z.string().max(256).optional(),
            })
            .default({}),
        }),
        outputSchema: z.object({
          page: PageMetadata.extend({ nodes: z.array(CrashSummary) }),
        }),
        handler: async ({ filter, first, after }) => {
          const page = await service.crashReports(filter, first, after);
          return { page: { ...page, nodes: page.nodes.map(crashSummary) } };
        },
      }),
      defineTool({
        name: "get_crash_report",
        title: "Get crash report",
        description:
          "Read a crash's symbolicated threads, readable report, and missing dSYM information. Returns null for an unknown crash; excludes stored upload data and internal filesystem locations.",
        inputSchema: z.object({ id: z.string().min(1).max(256) }),
        outputSchema: z.object({ crash: CrashDetail.nullable() }),
        handler: async ({ id }) => {
          const row = await service.crashReport(id);
          return { crash: row ? crashDetail(row) : null };
        },
      }),
      defineTool({
        name: "get_dsyms",
        title: "Get dSYMs",
        description:
          "List ready dSYM bundles by search, build, project, or binary UUID, with cursor pagination and no binary contents or storage paths.",
        inputSchema: PageInput.extend({
          filter: z
            .object({
              search: z.string().max(200).optional(),
              buildId: z.string().max(256).optional(),
              projectName: z.string().max(256).optional(),
              uuid: z.string().max(256).optional(),
            })
            .default({}),
        }),
        outputSchema: z.object({
          page: PageMetadata.extend({ nodes: z.array(DsymSchema) }),
        }),
        handler: async ({ filter, first, after }) => {
          const page = await service.dsyms(filter, first, after);
          return { page: { ...page, nodes: page.nodes.map(dsymView) } };
        },
      }),
      defineTool({
        name: "get_dsym",
        title: "Get dSYM",
        description:
          "Read a dSYM bundle's version, architecture slices, UUIDs, and build provenance. Returns null when the bundle does not exist.",
        inputSchema: z.object({ id: z.string().min(1).max(256) }),
        outputSchema: z.object({ dsym: DsymSchema.nullable() }),
        handler: async ({ id }) => {
          const row = await service.dsym(id);
          return { dsym: row ? dsymView(row) : null };
        },
      }),
    ],
  };
}
