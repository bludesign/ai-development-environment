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
  lastFetchAttemptAt: z.string().nullable().optional(),
  lastFetchError: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  localBranches: z.array(z.string()).optional(),
  remoteBranches: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
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

export const GetCodebaseInputSchema = z.union([
  z.object({
    id: z.string().min(1).describe("Registered codebase ID"),
  }),
  z.object({
    path: z
      .string()
      .min(1)
      .describe("Exact absolute folder path of the codebase"),
    agentId: z
      .string()
      .min(1)
      .optional()
      .describe("Agent ID used to disambiguate a shared folder path"),
  }),
]);

export const GetCodebaseOutputSchema = z.object({
  codebase: CodebaseToolRecordSchema,
});

export const SearchCodebasesInputSchema = z
  .object({
    query: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    repositoryId: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    availability: availabilitySchema.optional(),
    syncState: syncStateSchema.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .refine(
    ({ query, agentId, repositoryId, branch, availability, syncState }) =>
      Boolean(
        query || agentId || repositoryId || branch || availability || syncState,
      ),
    { message: "At least one codebase search criterion is required" },
  );

export const SearchCodebasesOutputSchema = z.object({
  codebases: z.array(CodebaseToolRecordSchema),
  matchingCount: z.number().int().nonnegative(),
});

export const CodebaseRepositoryToolRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  canonicalOrigin: z.string(),
  displayOrigin: z.string(),
  jiraBranchRegex: z.string().nullable(),
  keepBaseBranchUpToDate: z.boolean(),
  codebaseCount: z.number().int().nonnegative(),
  agentIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GetCodebaseRepositoriesOutputSchema = z.object({
  repositories: z.array(CodebaseRepositoryToolRecordSchema),
});

export const GetCodebaseRepositoryInputSchema = z.object({
  id: z.string().min(1),
});

export const GetCodebaseRepositoryOutputSchema = z.object({
  repository: CodebaseRepositoryToolRecordSchema.extend({
    codebases: z.array(CodebaseToolRecordSchema),
  }),
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

  private stringArray(value: string): string[] {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  private record(
    repository: Awaited<ReturnType<CodebasesService["overview"]>>[number],
    codebase: Awaited<
      ReturnType<CodebasesService["overview"]>
    >[number]["codebases"][number],
  ): CodebaseToolRecord {
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
      lastFetchAttemptAt: codebase.lastFetchAttemptAt?.toISOString() ?? null,
      lastFetchError: codebase.lastFetchError,
      defaultBranch: codebase.defaultBranch,
      localBranches: this.stringArray(codebase.localBranchesJson),
      remoteBranches: this.stringArray(codebase.remoteBranchesJson),
      createdAt: codebase.createdAt.toISOString(),
      updatedAt: codebase.updatedAt.toISOString(),
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
  }

  async list(): Promise<CodebaseToolRecord[]> {
    const repositories = await this.codebasesService.overview();
    return repositories.flatMap((repository) =>
      repository.codebases.map((codebase) => this.record(repository, codebase)),
    );
  }

  async getByPath(path: string, agentId?: string): Promise<CodebaseToolRecord> {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new CodebaseLookupError(
        "INVALID_PATH",
        "A non-empty codebase path is required",
      );
    }
    const matches = (await this.list()).filter(
      (codebase) =>
        codebase.path === path && (!agentId || codebase.agent.id === agentId),
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

  async getById(id: string): Promise<CodebaseToolRecord> {
    const match = (await this.list()).find((codebase) => codebase.id === id);
    if (!match) {
      throw new CodebaseLookupError(
        "CODEBASE_NOT_FOUND",
        `No codebase is registered with id ${id}`,
      );
    }
    return match;
  }

  async get(
    input: z.output<typeof GetCodebaseInputSchema>,
  ): Promise<CodebaseToolRecord> {
    return "id" in input
      ? this.getById(input.id)
      : this.getByPath(input.path, input.agentId);
  }

  async search(
    input: z.output<typeof SearchCodebasesInputSchema>,
  ): Promise<{ codebases: CodebaseToolRecord[]; matchingCount: number }> {
    const needle = input.query?.toLocaleLowerCase();
    const matches = (await this.list()).filter((codebase) => {
      if (input.agentId && codebase.agent.id !== input.agentId) return false;
      if (input.repositoryId && codebase.repository.id !== input.repositoryId) {
        return false;
      }
      if (input.branch && codebase.branch !== input.branch) return false;
      if (input.availability && codebase.availability !== input.availability) {
        return false;
      }
      if (input.syncState && codebase.syncState !== input.syncState) {
        return false;
      }
      if (!needle) return true;
      return [
        codebase.id,
        codebase.path,
        codebase.observedOrigin,
        codebase.branch ?? "",
        codebase.repository.name,
        codebase.repository.description,
        codebase.repository.canonicalOrigin,
        codebase.agent.name,
        codebase.agent.hostname,
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
    return {
      codebases: matches.slice(0, input.limit),
      matchingCount: matches.length,
    };
  }

  async repositories() {
    const repositories = await this.codebasesService.overview();
    return repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      description: repository.description,
      canonicalOrigin: repository.canonicalOrigin,
      displayOrigin: repository.displayOrigin,
      jiraBranchRegex: repository.jiraBranchRegex,
      keepBaseBranchUpToDate: repository.keepBaseBranchUpToDate,
      codebaseCount: repository.codebases.length,
      agentIds: [
        ...new Set(repository.codebases.map((codebase) => codebase.agentId)),
      ],
      createdAt: repository.createdAt.toISOString(),
      updatedAt: repository.updatedAt.toISOString(),
    }));
  }

  async repository(id: string) {
    const repositories = await this.codebasesService.overview();
    const repository = repositories.find((item) => item.id === id);
    if (!repository) throw new Error("Codebase repository not found");
    const summary = (await this.repositories()).find((item) => item.id === id)!;
    return {
      ...summary,
      codebases: repository.codebases.map((codebase) =>
        this.record(repository, codebase),
      ),
    };
  }
}
