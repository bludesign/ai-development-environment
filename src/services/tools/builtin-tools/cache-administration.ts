import * as z from "zod/v4";

import type { CacheServerService } from "@/services/cache-server";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { JiraService } from "@/services/jira";

import {
  DESTRUCTIVE_ANNOTATIONS,
  DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createCacheAdministrationGroup(
  cache: CacheServerService,
  jira: JiraService,
  github: GitHubService,
  gitlab?: GitLabService,
): BuiltInToolGroup {
  return {
    id: "builtin:cache-administration",
    name: "Cache Administration",
    tools: [],
    children: [
      {
        id: "builtin:cache-administration:cache-server",
        name: "Cache Server",
        children: [],
        tools: [
          serviceTool({
            name: "get_cache_server_entries",
            title: "Get cache-server entries",
            description:
              "List cache-server entries with filters and pagination.",
            inputSchema: z.object({
              filters: z
                .object({
                  key: z.string().nullable().optional(),
                  version: z.string().nullable().optional(),
                  scope: z.string().nullable().optional(),
                  repoId: z.string().nullable().optional(),
                  itemsPerPage: z.number().int().min(1).max(500).default(20),
                  page: z.number().int().min(1).default(1),
                })
                .default({ itemsPerPage: 20, page: 1 }),
            }),
            service: cache,
            method: "listCacheEntries",
            arguments: ({ filters }) => [filters],
            resultKey: "page",
            annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
          }),
          serviceTool({
            name: "get_cache_server_entry",
            title: "Get cache-server entry",
            description:
              "Get cache-entry detail without secret connection values.",
            inputSchema: z.object({ id: z.string().min(1) }),
            service: cache,
            method: "getCacheEntryDetail",
            arguments: ({ id }) => [id],
            resultKey: "entry",
            annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
          }),
          serviceTool({
            name: "match_cache_server_entry",
            title: "Match cache-server entry",
            description: "Find a cache entry matching build cache keys.",
            inputSchema: z.object({
              input: z.object({
                primaryKey: z.string().min(1),
                restoreKeys: z.array(z.string()).nullable().optional(),
                scopes: z.array(z.string()).min(1),
                repoId: z.string().min(1),
                version: z.string().min(1),
              }),
            }),
            service: cache,
            method: "matchCacheEntry",
            arguments: ({ input }) => [input],
            resultKey: "match",
            annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
          }),
          serviceTool({
            name: "get_cache_storage_location",
            title: "Get cache storage location",
            description: "Get one cache storage-location summary.",
            inputSchema: z.object({ id: z.string().min(1) }),
            service: cache,
            method: "getStorageLocation",
            arguments: ({ id }) => [id],
            resultKey: "location",
            annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
          }),
          serviceTool({
            name: "delete_cache_server_entries",
            title: "Delete cache-server entries",
            description: "Permanently delete selected cache-server entries.",
            inputSchema: z.object({ ids: z.array(z.string().min(1)).min(1) }),
            service: cache,
            method: "deleteCacheEntriesByIds",
            arguments: ({ ids }) => [ids],
            resultKey: "deleted",
            annotations: DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
          }),
        ],
      },
      {
        id: "builtin:cache-administration:jira",
        name: "Jira Cache",
        children: [],
        tools: [
          serviceTool({
            name: "get_jira_cache_metrics",
            title: "Get Jira cache metrics",
            description:
              "Get Jira cache hit, live-call, error, and latency metrics.",
            inputSchema: z.object({}),
            service: jira,
            method: "cacheMetrics",
            arguments: () => [],
            resultKey: "metrics",
          }),
          serviceTool({
            name: "get_jira_api_calls",
            title: "Get Jira API calls",
            description: "List redacted Jira API-call history.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(500).default(100),
              offset: z.number().int().min(0).default(0),
            }),
            service: jira,
            method: "listApiCalls",
            arguments: (value) => [value.limit, value.offset],
            resultKey: "page",
          }),
          serviceTool({
            name: "get_jira_cached_entries",
            title: "Get Jira cached entries",
            description: "List cached Jira ticket entries.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(500).default(100),
              offset: z.number().int().min(0).default(0),
            }),
            service: jira,
            method: "listCachedTickets",
            arguments: (value) => [value.limit, value.offset],
            resultKey: "page",
          }),
          serviceTool({
            name: "clear_jira_cache",
            title: "Clear Jira cache",
            description: "Permanently clear all cached Jira tickets.",
            inputSchema: z.object({}),
            service: jira,
            method: "clearCache",
            arguments: () => [],
            resultKey: "cleared",
            annotations: DESTRUCTIVE_EXTERNAL_ANNOTATIONS,
          }),
        ],
      },
      {
        id: "builtin:cache-administration:github",
        name: "GitHub Cache",
        children: [],
        tools: [
          serviceTool({
            name: "get_github_cache_metrics",
            title: "Get GitHub cache metrics",
            description: "Get GitHub cache and API-call metrics.",
            inputSchema: z.object({}),
            service: github,
            method: "cacheMetrics",
            arguments: () => [],
            resultKey: "metrics",
          }),
          serviceTool({
            name: "get_github_api_calls",
            title: "Get GitHub API calls",
            description: "List redacted GitHub API-call history.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(500).default(100),
              offset: z.number().int().min(0).default(0),
            }),
            service: github,
            method: "apiCalls",
            arguments: (value) => [value.limit, value.offset, {}],
            resultKey: "page",
          }),
          serviceTool({
            name: "get_github_cached_entries",
            title: "Get GitHub cached entries",
            description: "List cached GitHub API entries.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(500).default(100),
              offset: z.number().int().min(0).default(0),
            }),
            service: github,
            method: "cachedEntries",
            arguments: (value) => [value.limit, value.offset],
            resultKey: "page",
          }),
          serviceTool({
            name: "clear_github_cache",
            title: "Clear GitHub cache",
            description: "Permanently clear cached GitHub API entries.",
            inputSchema: z.object({}),
            service: github,
            method: "clearCache",
            arguments: () => [],
            resultKey: "cleared",
            annotations: DESTRUCTIVE_ANNOTATIONS,
          }),
        ],
      },
      ...(gitlab
        ? [
            {
              id: "builtin:cache-administration:gitlab",
              name: "GitLab Cache",
              children: [],
              tools: [
                serviceTool({
                  name: "get_gitlab_cache_metrics",
                  title: "Get GitLab cache metrics",
                  description: "Get GitLab cache and API-call metrics.",
                  inputSchema: z.object({}),
                  service: gitlab,
                  method: "cacheMetrics",
                  arguments: () => [],
                  resultKey: "metrics",
                }),
                serviceTool({
                  name: "get_gitlab_api_calls",
                  title: "Get GitLab API calls",
                  description: "List redacted GitLab API-call history.",
                  inputSchema: z.object({
                    limit: z.number().int().min(1).max(500).default(100),
                    offset: z.number().int().min(0).default(0),
                  }),
                  service: gitlab,
                  method: "apiCalls",
                  arguments: ({ limit, offset }) => [limit, offset],
                  resultKey: "page",
                }),
                serviceTool({
                  name: "get_gitlab_cached_entries",
                  title: "Get GitLab cached entries",
                  description: "List cached GitLab REST API entries.",
                  inputSchema: z.object({
                    limit: z.number().int().min(1).max(500).default(100),
                    offset: z.number().int().min(0).default(0),
                  }),
                  service: gitlab,
                  method: "cachedEntries",
                  arguments: ({ limit, offset }) => [limit, offset],
                  resultKey: "page",
                }),
                serviceTool({
                  name: "clear_gitlab_cache",
                  title: "Clear GitLab cache",
                  description: "Permanently clear cached GitLab REST entries.",
                  inputSchema: z.object({}),
                  service: gitlab,
                  method: "clearCache",
                  arguments: () => [],
                  resultKey: "cleared",
                  annotations: DESTRUCTIVE_ANNOTATIONS,
                }),
              ],
            },
          ]
        : []),
    ],
  };
}
