import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { NotificationsService } from "@/services/notifications";

import { createNotificationsResolvers } from "./notifications";

describe("notification resolvers", () => {
  test("masks the raw token returned after renaming a device", async () => {
    const device = {
      id: "device-1",
      token: "A".repeat(64),
      displayName: "Renamed phone",
    };
    const service = {
      renameNotificationDevice: vi.fn().mockResolvedValue(device),
    } as unknown as NotificationsService;
    const resolvers = createNotificationsResolvers(service);

    const renamed = await resolvers.Mutation.renameNotificationDevice(
      {},
      { id: device.id, displayName: device.displayName },
      { agentId: null } as GraphQLContext,
    );

    expect(resolvers.NotificationDevice.tokenMasked(renamed)).toBe(
      "AAAAAAAA…AAAAAAAA",
    );
  });
});
