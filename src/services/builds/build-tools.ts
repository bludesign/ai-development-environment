import * as z from "zod/v4";

export const GetBuildsInputSchema = z.object({
  status: z.string().optional(),
  codebaseId: z.string().optional(),
  worktreeId: z.string().optional(),
  first: z.number().int().min(1).max(200).default(50),
  after: z.string().optional(),
});
export const GetBuildsOutputSchema = z.object({
  builds: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

export const GetBuildInputSchema = z.object({
  buildId: z.string().min(1),
  afterSequence: z.number().int().default(-1),
  logLimit: z.number().int().min(1).max(5_000).default(1_000),
});
export const GetBuildOutputSchema = z.object({
  build: z.unknown(),
  logs: z.array(z.unknown()),
});

export const GetBuildConfigurationsInputSchema = z.object({
  worktreeId: z.string().min(1),
});
export const GetBuildConfigurationsOutputSchema = z.object({
  project: z.unknown().nullable(),
});

export const GetBuildDestinationsInputSchema = z.union([
  z.object({
    buildId: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    worktreeId: z.string().min(1),
    configurationId: z.string().min(1),
    action: z.string().optional(),
    requestId: z.string().min(1),
  }),
]);
export const GetBuildDestinationsOutputSchema = z.object({
  destinations: z.array(z.unknown()),
});

export const StartBuildToolInputSchema = z.object({
  worktreeId: z.string().min(1),
  configurationId: z.string().min(1),
  destination: z.record(z.string(), z.unknown()),
  scriptIds: z.array(z.string()).default([]),
  action: z.string().optional(),
  advancedSettings: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().min(1),
});
export const StartBuildToolOutputSchema = z.object({ build: z.unknown() });

export const CancelBuildToolInputSchema = z.object({
  buildId: z.string().min(1),
  requestId: z.string().min(1),
});
export const CancelBuildToolOutputSchema = z.object({ build: z.unknown() });

export const RunBuildToolInputSchema = z.object({
  buildId: z.string().min(1),
  destinations: z.array(z.record(z.string(), z.unknown())).min(1),
  requestId: z.string().min(1),
});
export const RunBuildToolOutputSchema = z.object({
  deployments: z.array(z.unknown()),
});

export const ExportBuildToolInputSchema = z.object({
  buildId: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  requestId: z.string().min(1),
});
export const ExportBuildToolOutputSchema = z.object({ export: z.unknown() });
