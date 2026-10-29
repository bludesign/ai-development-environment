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
import {
  CRASH_REPORT_STATUSES,
  DSYM_UPLOAD_STATUSES,
} from "@/services/crashes/types";

import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

const Id = z.string().trim().min(1).max(256);
const Ids = z.object({ ids: z.array(Id).min(1).max(500) });
const Settings = z.object({
  collectionEnabled: z.boolean(),
  symbolicationAgentId: z.string().nullable(),
  retentionDays: z.number().int(),
  dsymRetentionDays: z.number().int().nullable(),
});
const Upload = z.object({
  id: z.string(),
  filename: z.string(),
  status: z.enum(DSYM_UPLOAD_STATUSES),
  error: z.string().nullable(),
  source: z.string(),
  buildId: z.string().nullable(),
  linkedBuildId: z.string().nullable(),
  projectName: z.string().nullable(),
  sizeBytes: z.number(),
  uploadOffset: z.number(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
function uploadView(
  row: Awaited<ReturnType<CrashesService["retryDsymUpload"]>>,
) {
  return Upload.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

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
      defineTool({
        name: "get_crash_facets",
        title: "Get crash facets",
        description:
          "List stored app identifiers and versions for crash filters.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          facets: z.object({
            apps: z.array(
              z.object({
                bundleId: z.string(),
                appName: z.string().nullable(),
                count: z.number().int(),
              }),
            ),
            appVersions: z.array(z.string()),
          }),
        }),
        handler: async () => ({ facets: await service.crashFacets() }),
      }),
      defineTool({
        name: "get_dsym_projects",
        title: "Get dSYM projects",
        description: "List project names available for dSYM filters.",
        inputSchema: z.object({}),
        outputSchema: z.object({ projects: z.array(z.string()) }),
        handler: async () => ({ projects: await service.dsymProjects() }),
      }),
      defineTool({
        name: "get_crash_settings",
        title: "Get crash settings",
        description:
          "Read crash collection, symbolication-agent and retention settings.",
        inputSchema: z.object({}),
        outputSchema: z.object({ settings: Settings }),
        handler: async () => ({ settings: await service.settings() }),
      }),
      defineTool({
        name: "update_crash_settings",
        title: "Update crash settings",
        description:
          "Update collection, symbolication and retention. Null dSYM retention keeps dSYMs until deleted.",
        inputSchema: z.object({
          collectionEnabled: z.boolean().optional(),
          symbolicationAgentId: Id.nullable().optional(),
          retentionDays: z.number().int().min(1).max(3650).optional(),
          dsymRetentionDays: z
            .number()
            .int()
            .min(1)
            .max(3650)
            .nullable()
            .optional(),
        }),
        outputSchema: z.object({ settings: Settings }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          settings: await service.updateSettings(input),
        }),
      }),
      defineTool({
        name: "get_crash_symbolication_agents",
        title: "Get crash symbolication agents",
        description:
          "List eligible symbolication agents and their connection state.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          agents: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              hostname: z.string(),
              online: z.boolean(),
            }),
          ),
        }),
        handler: async () => ({ agents: await service.symbolicationAgents() }),
      }),
      defineTool({
        name: "symbolicate_crash_report",
        title: "Symbolicate crash report",
        description:
          "Restart symbolication using current dSYM matches and return the readable crash projection.",
        inputSchema: z.object({ id: Id }),
        outputSchema: z.object({ crash: CrashDetail.nullable() }),
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
        handler: async ({ id }) => {
          const row = await service.symbolicate(id);
          return { crash: row ? crashDetail(row) : null };
        },
      }),
      defineTool({
        name: "delete_crash_reports",
        title: "Delete crash reports",
        description:
          "Permanently delete selected crash reports and retained data.",
        inputSchema: Ids,
        outputSchema: z.object({ count: z.number().int() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ ids }) => ({
          count: await service.deleteCrashReports(ids),
        }),
      }),
      defineTool({
        name: "delete_dsyms",
        title: "Delete dSYMs",
        description:
          "Permanently delete selected dSYM bundles and stored files.",
        inputSchema: Ids,
        outputSchema: z.object({ count: z.number().int() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ ids }) => ({ count: await service.deleteDsyms(ids) }),
      }),
      defineTool({
        name: "get_dsym_uploads",
        title: "Get dSYM uploads",
        description:
          "Read up to 50 recent upload jobs. Omitting statuses lists unfinished or failed jobs. Excludes uploaded bytes, ownership and storage paths.",
        inputSchema: z.object({
          statuses: z.array(z.enum(DSYM_UPLOAD_STATUSES)).max(5).optional(),
        }),
        outputSchema: z.object({ uploads: z.array(Upload) }),
        handler: async ({ statuses }) => ({
          uploads: (await service.dsymUploads(statuses)).map(uploadView),
        }),
      }),
      defineTool({
        name: "update_dsym_upload",
        title: "Update dSYM upload",
        description:
          "Replace build, project and optional HTTP(S) provenance metadata on an upload; omitted metadata fields clear their current values.",
        inputSchema: z.object({
          id: Id,
          input: z.object({
            buildId: z.string().max(200).nullable().optional(),
            projectName: z.string().max(200).nullable().optional(),
            url: z
              .url({ protocol: /^https?$/ })
              .max(2000)
              .nullable()
              .optional(),
          }),
        }),
        outputSchema: z.object({ upload: Upload }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ id, input }) => ({
          upload: uploadView(await service.updateDsymUpload(id, input)),
        }),
      }),
      defineTool({
        name: "retry_dsym_upload",
        title: "Retry dSYM upload",
        description: "Retry a failed build-artifact dSYM import.",
        inputSchema: z.object({ id: Id }),
        outputSchema: z.object({ upload: Upload }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ id }) => ({
          upload: uploadView(await service.retryDsymUpload(id)),
        }),
      }),
      defineTool({
        name: "delete_dsym_upload",
        title: "Delete dSYM upload",
        description: "Permanently delete an upload and its dSYM files.",
        inputSchema: z.object({ id: Id }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ id }) => ({
          deleted: await service.deleteDsymUpload(id),
        }),
      }),
    ],
  };
}
