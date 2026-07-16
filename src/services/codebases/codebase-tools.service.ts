import * as z from "zod/v4";

import { AGENT_ONLINE_WINDOW_MS } from "@/services/agent-control";

import type { CodebasesService } from "./codebases.service";

const syncStateSchema = z.enum([
  "IN_SYNC",
  "AHEAD",
  "BEHIND",
  "DIVERGED",
  "NO_UPSTREAM",
  "DETACHED",
  "UNKNOWN",
]);

const availabilitySchema = z.enum([
  "AVAILABLE",
  "MISSING",
  "NOT_REPOSITORY",
  "ORIGIN_MISMATCH",
  "ERROR",
]);

export const CodebaseToolRecordSchema = z.object({
  id: z.string(),
  path: z.string(),
  observedOrigin: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  syncState: syncStateSchema,
  availability: availabilitySchema,
  statusError: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  repository: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    canonicalOrigin: z.string(),
    displayOrigin: z.string(),
  }),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    hostname: z.string(),
    connectionStatus: z.enum(["ONLINE", "OFFLINE"]),
  }),
  activeJob: z
    .object({
      id: z.string(),
      kind: z.string(),
      status: z.enum(["QUEUED", "RUNNING"]),
    })
    .nullable(),
});

export const GetCodebasesOutputSchema = z.object({
  codebases: z.array(CodebaseToolRecordSchema),
});

export const GetCodebasesInputSchema = z.object({});

export const GetCodebaseInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Exact absolute folder path of the codebase"),
});

export const GetCodebaseOutputSchema = z.object({
  codebase: CodebaseToolRecordSchema,
});

export type CodebaseToolRecord = z.infer<typeof CodebaseToolRecordSchema>;

export type CodebaseLookupErrorCode =
  "INVALID_PATH" | "CODEBASE_NOT_FOUND" | "AMBIGUOUS_PATH";

export class CodebaseLookupError extends Error {
  constructor(
    readonly code: CodebaseLookupErrorCode,
    message: string,
    readonly matches: Array<{
      agentId: string;
      name: string;
      hostname: string;
    }> = [],
  ) {
    super(message);
    this.name = "CodebaseLookupError";
  }
}

function connectionStatus(agent: {
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
}): "ONLINE" | "OFFLINE" {
  return agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt.getTime() <= AGENT_ONLINE_WINDOW_MS &&
    agent.disconnectedAt === null
    ? "ONLINE"
    : "OFFLINE";
}

export class CodebaseToolsService {
  constructor(private readonly codebasesService: CodebasesService) {}

  async list(): Promise<CodebaseToolRecord[]> {
    const repositories = await this.codebasesService.overview();
    return repositories.flatMap((repository) =>
      repository.codebases.map((codebase) => {
        const activeJob = codebase.jobs[0] ?? null;
        return CodebaseToolRecordSchema.parse({
          id: codebase.id,
          path: codebase.folder,
          observedOrigin: codebase.observedOrigin,
          branch: codebase.branch,
          headSha: codebase.headSha,
          upstream: codebase.upstream,
          ahead: codebase.ahead,
          behind: codebase.behind,
          syncState: codebase.syncState,
          availability: codebase.availability,
          statusError: codebase.statusError,
          lastCheckedAt: codebase.lastCheckedAt?.toISOString() ?? null,
          lastFetchedAt: codebase.lastFetchedAt?.toISOString() ?? null,
          repository: {
            id: repository.id,
            name: repository.name,
            description: repository.description,
            canonicalOrigin: repository.canonicalOrigin,
            displayOrigin: repository.displayOrigin,
          },
          agent: {
            id: codebase.agent.id,
            name: codebase.agent.name,
            hostname: codebase.agent.hostname,
            connectionStatus: connectionStatus(codebase.agent),
          },
          activeJob: activeJob
            ? {
                id: activeJob.id,
                kind: activeJob.kind,
                status: activeJob.status,
              }
            : null,
        });
      }),
    );
  }

  async getByPath(path: string): Promise<CodebaseToolRecord> {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new CodebaseLookupError(
        "INVALID_PATH",
        "A non-empty codebase path is required",
      );
    }
    const matches = (await this.list()).filter(
      (codebase) => codebase.path === path,
    );
    if (matches.length === 0) {
      throw new CodebaseLookupError(
        "CODEBASE_NOT_FOUND",
        `No codebase is registered at path ${path}`,
      );
    }
    if (matches.length > 1) {
      const agents = matches.map(({ agent }) => ({
        agentId: agent.id,
        name: agent.name,
        hostname: agent.hostname,
      }));
      throw new CodebaseLookupError(
        "AMBIGUOUS_PATH",
        `More than one agent has a codebase registered at path ${path}`,
        agents,
      );
    }
    return matches[0];
  }
}
