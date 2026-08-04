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

function isAuthenticatedManagementCreation(context: AuthHookContext): boolean {
  return context?.path?.includes("/admin/create-user") ?? false;
}

export async function getRegistrationStatus(): Promise<{
  enabled: boolean;
  setupRequired: boolean;
}> {
  const prisma = await getPrismaClient();
  const [settings, userCount] = await Promise.all([
    prisma.authSettings.upsert({
      where: { id: AUTH_SETTINGS_ID },
      create: { id: AUTH_SETTINGS_ID },
      update: {},
    }),
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

async function claimInitialRegistration(): Promise<void> {
  const prisma = await getPrismaClient();
  const settings = await prisma.authSettings.upsert({
    where: { id: AUTH_SETTINGS_ID },
    create: { id: AUTH_SETTINGS_ID },
    update: {},
  });

  if (settings.bootstrapCompleted) {
    if (!settings.registrationEnabled) {
      throw new APIError("FORBIDDEN", {
        message: "Account registration is disabled.",
      });
    }
    return;
  }

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
        if (!isAuthenticatedManagementCreation(context)) {
          await claimInitialRegistration();
        }
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
