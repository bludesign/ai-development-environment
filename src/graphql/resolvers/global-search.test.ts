import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GlobalSearchService } from "@/services/global-search";

import { createGlobalSearchResolvers } from "./global-search";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("global search resolver", () => {
  test("passes validated defaults to the local search service", async () => {
    const service = {
      search: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as GlobalSearchService;
    const resolver = createGlobalSearchResolvers(service);

    await expect(
      resolver.Query.globalSearch(
        {},
        { query: "AIDE-42", firstPerGroup: null, relatedFirst: null },
        context(null),
      ),
    ).resolves.toEqual({ items: [] });
    expect(service.search).toHaveBeenCalledWith("AIDE-42", 5, 3);
  });

  test("rejects agent-authenticated callers before searching", () => {
    const service = {
      search: vi.fn(),
    } as unknown as GlobalSearchService;
    const resolver = createGlobalSearchResolvers(service);

    expect(() =>
      resolver.Query.globalSearch({}, { query: "AIDE-42" }, context("agent-1")),
    ).toThrow("Agent credentials cannot perform control-plane operations");
    expect(service.search).not.toHaveBeenCalled();
  });
});
