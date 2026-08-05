import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { authDatabaseHooks, getRegistrationStatus } from "./registration";

type Settings = {
  id: string;
  bootstrapCompleted: boolean;
  registrationEnabled: boolean;
  bootstrapClaimId: string | null;
  bootstrapClaimedAt: Date | null;
};

function database(userCount = 0, overrides: Partial<Settings> = {}) {
  const state: Settings = {
    id: "default",
    bootstrapCompleted: false,
    registrationEnabled: true,
    bootstrapClaimId: null,
    bootstrapClaimedAt: null,
    ...overrides,
  };
  let users = userCount;
  const authSettings = {
    // The settings row exists in every fixture, so `findUnique` answers and the
    // `upsert` fallback stays for the first-miss path only, which a test overrides
    // with `null` — hence the explicit nullable signature.
    findUnique: vi.fn<() => Promise<Settings | null>>(async () => ({
      ...state,
    })),
    upsert: vi.fn(async () => ({ ...state })),
    update: vi.fn(async ({ data }: { data: Partial<Settings> }) => {
      Object.assign(state, data);
      return { ...state };
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: {
          bootstrapCompleted?: boolean;
          OR?: Array<
            { bootstrapClaimedAt: null } | { bootstrapClaimedAt: { lt: Date } }
          >;
        };
        data: Partial<Settings>;
      }) => {
        if (
          where.bootstrapCompleted !== undefined &&
          state.bootstrapCompleted !== where.bootstrapCompleted
        ) {
          return { count: 0 };
        }
        if (where.OR) {
          const claimAvailable = where.OR.some((condition) => {
            if (condition.bootstrapClaimedAt === null) {
              return state.bootstrapClaimedAt === null;
            }
            return Boolean(
              state.bootstrapClaimedAt &&
              state.bootstrapClaimedAt < condition.bootstrapClaimedAt.lt,
            );
          });
          if (!claimAvailable) return { count: 0 };
        }
        Object.assign(state, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    authSettings,
    user: { count: vi.fn(async () => users) },
  };
  return {
    prisma,
    state,
    setUserCount(value: number) {
      users = value;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("registration policy", () => {
  test("reports initial setup on an empty database", async () => {
    const fixture = database();
    getPrismaClient.mockResolvedValue(fixture.prisma);
    await expect(getRegistrationStatus()).resolves.toEqual({
      enabled: true,
      setupRequired: true,
    });
  });

  test("allows only one concurrent first-account claim", async () => {
    const fixture = database();
    getPrismaClient.mockResolvedValue(fixture.prisma);
    const before = authDatabaseHooks.user.create.before;
    const attempts = await Promise.allSettled([
      before({ email: "one@example.com" }, null),
      before({ email: "two@example.com" }, null),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );

    fixture.setUserCount(1);
    await authDatabaseHooks.user.create.after();
    expect(fixture.state).toMatchObject({
      bootstrapCompleted: true,
      registrationEnabled: false,
      bootstrapClaimId: null,
      bootstrapClaimedAt: null,
    });
  });

  test("does not close registration after a user manually reopens it", async () => {
    const fixture = database(1, {
      bootstrapCompleted: true,
      registrationEnabled: true,
    });
    getPrismaClient.mockResolvedValue(fixture.prisma);
    await authDatabaseHooks.user.create.before(
      { email: "new@example.com" },
      null,
    );
    await authDatabaseHooks.user.create.after();
    expect(fixture.state.registrationEnabled).toBe(true);
  });

  test("authenticated account creation bypasses public registration", async () => {
    const fixture = database(1, {
      bootstrapCompleted: true,
      registrationEnabled: false,
    });
    getPrismaClient.mockResolvedValue(fixture.prisma);
    await expect(
      authDatabaseHooks.user.create.before(
        { email: "managed@example.com" },
        { path: "/admin/create-user", context: { session: null } },
      ),
    ).resolves.toMatchObject({ data: { role: "user", banned: false } });
    expect(fixture.prisma.authSettings.updateMany).not.toHaveBeenCalled();
  });

  test("the admin path waives closed registration but never the bootstrap claim", async () => {
    // The path is the only signal the hook gets, and it is not corroborated by a
    // session, so it must not be able to skip the race that guards the very first
    // account. Two concurrent admin-path creations on an empty database still
    // settle to exactly one winner.
    const fixture = database();
    getPrismaClient.mockResolvedValue(fixture.prisma);
    const managementContext = { path: "/admin/create-user" };
    const attempts = await Promise.allSettled([
      authDatabaseHooks.user.create.before(
        { email: "one@example.com" },
        managementContext,
      ),
      authDatabaseHooks.user.create.before(
        { email: "two@example.com" },
        managementContext,
      ),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });

  test("reading registration status does not write when the row exists", async () => {
    const fixture = database(1, { bootstrapCompleted: true });
    getPrismaClient.mockResolvedValue(fixture.prisma);

    await expect(getRegistrationStatus()).resolves.toEqual({
      enabled: true,
      setupRequired: false,
    });
    // `/api/auth/config` is unauthenticated and polled by the healthcheck, so the
    // read path must stay a read.
    expect(fixture.prisma.authSettings.findUnique).toHaveBeenCalled();
    expect(fixture.prisma.authSettings.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.authSettings.update).not.toHaveBeenCalled();
  });

  test("creates the settings row on the first miss", async () => {
    const fixture = database();
    fixture.prisma.authSettings.findUnique.mockResolvedValueOnce(null);
    getPrismaClient.mockResolvedValue(fixture.prisma);

    await expect(getRegistrationStatus()).resolves.toEqual({
      enabled: true,
      setupRequired: true,
    });
    expect(fixture.prisma.authSettings.upsert).toHaveBeenCalled();
  });

  test("prevents deletion of the current or final user", async () => {
    const fixture = database(2, { bootstrapCompleted: true });
    getPrismaClient.mockResolvedValue(fixture.prisma);
    await expect(
      authDatabaseHooks.user.delete.before(
        { id: "user-1" },
        { context: { session: { user: { id: "user-1" } } } },
      ),
    ).rejects.toThrow("currently using");

    fixture.setUserCount(1);
    await expect(
      authDatabaseHooks.user.delete.before({ id: "user-2" }, null),
    ).rejects.toThrow("final account");
  });
});
