import { randomUUID } from "node:crypto";

import { APIError } from "better-auth/api";

import { getPrismaClient } from "@/data/prisma-client";

const AUTH_SETTINGS_ID = "default";
const BOOTSTRAP_CLAIM_TTL_MS = 3 * 60 * 1000;

type AuthHookContext = {
  path?: string;
  context?: {
    session?: { user?: { id?: string } } | null;
  };
} | null;

/**
 * Whether this creation came through the admin endpoint, which an operator uses
 * to add accounts while public registration is closed.
 *
 * The path is the only signal Better Auth offers here: `/admin/create-user`
 * resolves its own session locally and never publishes it on the hook context
 * (unlike the endpoints behind `adminMiddleware`), so there is no session to
 * corroborate against. That is why this only waives the `registrationEnabled`
 * gate — the endpoint's own `UNAUTHORIZED` check already guards it — and never
 * the bootstrap claim, which stays unconditional in `claimInitialRegistration`.
 * A spoofed path therefore cannot be used to create the *first* account.
 */
function isAuthenticatedManagementCreation(context: AuthHookContext): boolean {
  return context?.path?.includes("/admin/create-user") ?? false;
}

/**
 * Read-first, because this backs `/api/auth/config` — an unauthenticated route
 * that the Docker healthcheck and the control agent's readiness probe both poll.
 * Upserting on every call turned a liveness check into a write, and gave any
 * anonymous caller a cheap way to generate them. The row is created on the first
 * miss and read thereafter.
 */
async function readAuthSettings() {
  const prisma = await getPrismaClient();
  return (
    (await prisma.authSettings.findUnique({
      where: { id: AUTH_SETTINGS_ID },
    })) ??
    (await prisma.authSettings.upsert({
      where: { id: AUTH_SETTINGS_ID },
      create: { id: AUTH_SETTINGS_ID },
      update: {},
    }))
  );
}

export async function getRegistrationStatus(): Promise<{
  enabled: boolean;
  setupRequired: boolean;
}> {
  const prisma = await getPrismaClient();
  const [settings, userCount] = await Promise.all([
    readAuthSettings(),
    prisma.user.count(),
  ]);

  if (!settings.bootstrapCompleted && userCount === 0) {
    return { enabled: true, setupRequired: true };
  }

  if (!settings.bootstrapCompleted && userCount > 0) {
    await prisma.authSettings.update({
      where: { id: AUTH_SETTINGS_ID },
      data: {
        bootstrapCompleted: true,
        registrationEnabled: false,
        bootstrapClaimId: null,
        bootstrapClaimedAt: null,
      },
    });
    return { enabled: false, setupRequired: false };
  }

  return {
    enabled: settings.registrationEnabled,
    setupRequired: false,
  };
}

export async function setRegistrationEnabled(enabled: boolean): Promise<void> {
  const prisma = await getPrismaClient();
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    throw new APIError("BAD_REQUEST", {
      message: "Create the initial account before changing registration.",
    });
  }
  await prisma.authSettings.upsert({
    where: { id: AUTH_SETTINGS_ID },
    create: {
      id: AUTH_SETTINGS_ID,
      bootstrapCompleted: true,
      registrationEnabled: enabled,
    },
    update: { registrationEnabled: enabled },
  });
}

/**
 * Gate one account creation.
 *
 * `allowWhenRegistrationClosed` is set for the admin endpoint, which must keep
 * working after public registration is turned off. It waives only that gate: the
 * bootstrap claim below runs for every caller, so the race that protects the
 * first account on an empty database cannot be skipped by any request, however it
 * is routed.
 */
async function claimInitialRegistration({
  allowWhenRegistrationClosed = false,
}: { allowWhenRegistrationClosed?: boolean } = {}): Promise<void> {
  const prisma = await getPrismaClient();
  const settings = await readAuthSettings();

  if (settings.bootstrapCompleted) {
    if (!settings.registrationEnabled && !allowWhenRegistrationClosed) {
      throw new APIError("FORBIDDEN", {
        message: "Account registration is disabled.",
      });
    }
    return;
  }

  // Accounts exist but the flag never got set — a database seeded directly, or a
  // crash between creating the first user and completing the claim. Adopt the
  // settled state, then apply the ordinary closed-registration rule to this
  // request.
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    await prisma.authSettings.update({
      where: { id: AUTH_SETTINGS_ID },
      data: {
        bootstrapCompleted: true,
        registrationEnabled: false,
        bootstrapClaimId: null,
        bootstrapClaimedAt: null,
      },
    });
    if (allowWhenRegistrationClosed) return;
    throw new APIError("FORBIDDEN", {
      message: "Account registration is disabled.",
    });
  }

  const staleBefore = new Date(Date.now() - BOOTSTRAP_CLAIM_TTL_MS);
  const claimId = randomUUID();
  const claimed = await prisma.authSettings.updateMany({
    where: {
      id: AUTH_SETTINGS_ID,
      bootstrapCompleted: false,
      OR: [
        { bootstrapClaimedAt: null },
        { bootstrapClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { bootstrapClaimId: claimId, bootstrapClaimedAt: new Date() },
  });

  if (claimed.count !== 1) {
    throw new APIError("CONFLICT", {
      message:
        "The initial account is already being created. Try again shortly.",
    });
  }
}

async function completeInitialRegistration(): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.authSettings.updateMany({
    where: { id: AUTH_SETTINGS_ID, bootstrapCompleted: false },
    data: {
      bootstrapCompleted: true,
      registrationEnabled: false,
      bootstrapClaimId: null,
      bootstrapClaimedAt: null,
    },
  });
}

export const authDatabaseHooks = {
  user: {
    create: {
      before: async (
        user: Record<string, unknown>,
        context: AuthHookContext,
      ) => {
        await claimInitialRegistration({
          allowWhenRegistrationClosed:
            isAuthenticatedManagementCreation(context),
        });
        return {
          data: {
            ...user,
            role: "user",
            banned: false,
            banReason: null,
            banExpires: null,
          },
        };
      },
      after: async () => {
        await completeInitialRegistration();
      },
    },
    update: {
      before: async (user: Record<string, unknown>) => ({
        data: {
          ...user,
          role: "user",
          banned: false,
          banReason: null,
          banExpires: null,
        },
      }),
    },
    delete: {
      before: async (user: { id: string }, context: AuthHookContext) => {
        const currentUserId = context?.context?.session?.user?.id;
        if (currentUserId && currentUserId === user.id) {
          throw new APIError("BAD_REQUEST", {
            message: "You cannot delete the account you are currently using.",
          });
        }
        const prisma = await getPrismaClient();
        if ((await prisma.user.count()) <= 1) {
          throw new APIError("BAD_REQUEST", {
            message: "The final account cannot be deleted.",
          });
        }
        return true;
      },
    },
  },
};
