import { formatUuid } from "@ai-development-environment/agent-contract/crashes";

import type {
  CrashesService,
  CrashReportFilter,
  DsymFilter,
} from "@/services/crashes/crashes.service";
import {
  crashSymbolication,
  normalizedCrash,
} from "@/services/crashes/crashes.service";
import {
  displayFrames,
  displayThreads,
  renderCrashText,
} from "@/services/crashes/symbolication";
import type {
  CrashSymbolication,
  DisplayFrame,
  NormalizedCrash,
} from "@/services/crashes/types";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot perform crash operations");
  }
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

type CrashParent = {
  id: string;
  signature: string;
  normalizedJson: string;
  symbolicationJson: string;
  createdAt: Date;
  updatedAt: Date;
  crashedAt: Date | null;
  symbolicatedAt: Date | null;
  binaryImages: {
    imageIndex: number;
    frameCount: number;
    dsymId: string | null;
  }[];
};

type DsymParent = {
  id: string;
  uploadId: string;
  createdAt: Date;
  slices: { id: string; uuid: string; arch: string; textVmAddr: string }[];
};

type UploadParent = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  dsyms?: unknown[];
};

const parsed = new WeakMap<
  object,
  { crash: NormalizedCrash | null; symbolication: CrashSymbolication }
>();

/** Parses a crash row's JSON once per request, however many fields need it. */
function details(row: CrashParent) {
  const cached = parsed.get(row);
  if (cached) return cached;
  const value = {
    crash: normalizedCrash(row),
    symbolication: crashSymbolication(row),
  };
  parsed.set(row, value);
  return value;
}

function dashed(uuid: string | null): string | null {
  if (!uuid) return null;
  try {
    return formatUuid(uuid);
  } catch {
    return uuid;
  }
}

function frameView(frame: DisplayFrame) {
  return { ...frame, imageUuid: dashed(frame.imageUuid) };
}

function binaryImages(row: CrashParent) {
  const { crash } = details(row);
  if (!crash) return [];
  const stored = new Map(
    row.binaryImages.map((image) => [image.imageIndex, image]),
  );
  return crash.images.map((image) => ({
    id: `${row.id}:${image.index}`,
    uuid: dashed(image.uuid),
    name: image.name,
    arch: image.arch,
    loadAddress: image.base,
    path: image.path,
    isApp: image.isApp,
    frameCount: stored.get(image.index)?.frameCount ?? 0,
    dsymId: stored.get(image.index)?.dsymId ?? null,
  }));
}

export const createCrashResolvers = (service: CrashesService) => ({
  CrashReport: {
    createdAt: (row: CrashParent) => row.createdAt.toISOString(),
    updatedAt: (row: CrashParent) => row.updatedAt.toISOString(),
    crashedAt: (row: CrashParent) => iso(row.crashedAt),
    symbolicatedAt: (row: CrashParent) => iso(row.symbolicatedAt),
    exceptionSubtype: (row: CrashParent) =>
      details(row).crash?.exceptionSubtype ?? null,
    exceptionReason: (row: CrashParent) =>
      details(row).crash?.exceptionReason ?? null,
    applicationSpecificInformation: (row: CrashParent) =>
      details(row).crash?.applicationSpecificInformation ?? [],
    threads: (row: CrashParent) => {
      const { crash, symbolication } = details(row);
      if (!crash) return [];
      return displayThreads(crash, symbolication).map((thread) => ({
        ...thread,
        frames: thread.frames.map(frameView),
      }));
    },
    topAppFrame: (row: CrashParent) => {
      const { crash, symbolication } = details(row);
      const thread =
        crash?.threads.find((entry) => entry.crashed) ?? crash?.threads[0];
      if (!crash || !thread) return null;
      const frame = displayFrames(
        thread.frames,
        crash.images,
        symbolication,
      ).find((entry) => entry.isAppFrame && !entry.inlined);
      return frame ? frameView(frame) : null;
    },
    lastExceptionBacktrace: (row: CrashParent) => {
      const { crash, symbolication } = details(row);
      if (!crash?.lastExceptionBacktrace) return null;
      return displayFrames(
        crash.lastExceptionBacktrace,
        crash.images,
        symbolication,
      ).map(frameView);
    },
    binaryImages,
    missingImages: (row: CrashParent) =>
      binaryImages(row).filter(
        (image) => image.isApp && image.frameCount > 0 && !image.dsymId,
      ),
    attachedDsyms: (row: CrashParent) =>
      service.dsymsByIds([
        ...new Set(
          row.binaryImages
            .map((image) => image.dsymId)
            .filter((id): id is string => Boolean(id)),
        ),
      ]),
    similarCrashes: (row: CrashParent, { first }: { first?: number | null }) =>
      service.similarCrashes(row, first),
    similarCrashCount: (row: CrashParent) => service.similarCrashCount(row),
    symbolicatedText: (row: CrashParent) => {
      const { crash, symbolication } = details(row);
      return crash ? renderCrashText(crash, symbolication) : "";
    },
    originalDownloadUrl: (row: CrashParent) =>
      `/api/crash-files/reports/${row.id}`,
    symbolicatedDownloadUrl: (row: CrashParent) =>
      `/api/crash-files/reports/${row.id}?variant=symbolicated`,
  },
  CrashBinaryImage: {
    dsym: (image: { dsymId: string | null }) =>
      image.dsymId ? service.dsym(image.dsymId) : null,
  },
  Dsym: {
    createdAt: (row: DsymParent) => row.createdAt.toISOString(),
    slices: (row: DsymParent) =>
      row.slices.map((slice) => ({ ...slice, uuid: dashed(slice.uuid) })),
    siblingDsyms: (row: DsymParent) => service.siblingDsyms(row),
    crashes: (
      row: DsymParent,
      { first, after }: { first?: number | null; after?: string | null },
    ) => service.crashesForDsym(row.id, first, after),
    crashCount: (row: DsymParent) => service.crashCountForDsym(row.id),
    downloadUrl: (row: DsymParent) => `/api/crash-files/dsyms/${row.id}`,
  },
  DsymUpload: {
    createdAt: (row: UploadParent) => row.createdAt.toISOString(),
    updatedAt: (row: UploadParent) => row.updatedAt.toISOString(),
    completedAt: (row: UploadParent) => iso(row.completedAt),
    dsymCount: (row: UploadParent) =>
      row.dsyms ? row.dsyms.length : service.dsymCountForUpload(row.id),
  },
  CrashSettings: {
    symbolicationAgent: async (row: {
      symbolicationAgentId: string | null;
    }) => {
      if (!row.symbolicationAgentId) return null;
      const agents = await service.symbolicationAgents();
      return (
        agents.find((agent) => agent.id === row.symbolicationAgentId) ?? null
      );
    },
  },
  Query: {
    crashReports: (
      _root: unknown,
      args: {
        filter?: CrashReportFilter | null;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.crashReports(args.filter ?? {}, args.first, args.after);
    },
    crashReport: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.crashReport(id);
    },
    crashFacets: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.crashFacets();
    },
    dsyms: (
      _root: unknown,
      args: {
        filter?: DsymFilter | null;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dsyms(args.filter ?? {}, args.first, args.after);
    },
    dsym: (_root: unknown, { id }: { id: string }, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.dsym(id);
    },
    dsymProjects: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.dsymProjects();
    },
    dsymUploads: (
      _root: unknown,
      { statuses }: { statuses?: string[] | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dsymUploads(statuses);
    },
    crashSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    crashSymbolicationAgents: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.symbolicationAgents();
    },
  },
  Mutation: {
    symbolicateCrashReport: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.symbolicate(id);
    },
    deleteCrashReports: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteCrashReports(ids);
    },
    deleteDsyms: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteDsyms(ids);
    },
    deleteDsymUpload: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteDsymUpload(id);
    },
    retryDsymUpload: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.retryDsymUpload(id);
    },
    updateDsymUpload: (
      _root: unknown,
      {
        id,
        input,
      }: {
        id: string;
        input: {
          buildId?: string | null;
          url?: string | null;
          projectName?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateDsymUpload(id, input);
    },
    updateCrashSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          collectionEnabled?: boolean | null;
          symbolicationAgentId?: string | null;
          retentionDays?: number | null;
          dsymRetentionDays?: number | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateSettings(input);
    },
  },
  Subscription: {
    crashReportsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeCrashReports();
      },
      resolve: (payload: unknown) => payload,
    },
    dsymsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeDsyms();
      },
      resolve: (payload: unknown) => payload,
    },
  },
});
