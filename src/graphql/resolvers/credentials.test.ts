import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createCredentialResolvers } from "./credentials";

const controlContext = {
  agentId: null,
} as GraphQLContext;

describe("credential resolvers", () => {
  test("returns metadata-only status and inventory to the control plane", async () => {
    const status = {
      storageType: "database",
      state: "WARNING",
      encryptionState: "PLAINTEXT",
      details: [{ label: "Location", value: "Application database" }],
      itemCount: 1,
      mismatchCount: 0,
      warnings: [
        {
          code: "DATABASE_UNENCRYPTED",
          message: "Database credentials are plaintext",
        },
      ],
    };
    const items = [
      {
        id: "jira/default/api-token",
        kind: "jira-api-token",
        ownerId: "default",
        ownerFeature: "Jira",
        storageType: "database",
        protection: "PLAINTEXT",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
    const service = {
      status: vi.fn().mockResolvedValue(status),
      list: vi.fn().mockResolvedValue(items),
    };
    const resolvers = createCredentialResolvers(service as never);
    await expect(
      resolvers.Query.credentialStoreStatus(null, null, controlContext),
    ).resolves.toEqual(status);
    await expect(
      resolvers.Query.credentials(null, null, controlContext),
    ).resolves.toEqual(items);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("apiToken");
  });

  test("rejects authenticated agents", () => {
    const resolvers = createCredentialResolvers({} as never);
    const agentContext = { agentId: "agent-1" } as GraphQLContext;
    expect(() => resolvers.Query.credentials(null, null, agentContext)).toThrow(
      "Agent credentials",
    );
    expect(() =>
      resolvers.Query.credentialStoreStatus(null, null, agentContext),
    ).toThrow("Agent credentials");
  });
});
