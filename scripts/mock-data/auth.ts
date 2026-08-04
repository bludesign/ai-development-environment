import type { PrismaClient } from "../../src/generated/prisma/client";

export const screenshotSessionToken = "screenshot-session-token";

export async function seedAuth(prisma: PrismaClient): Promise<void> {
  await prisma.user.createMany({
    data: [
      {
        id: "user-screenshot-admin",
        name: "Avery Morgan",
        email: "avery@acme.example",
        emailVerified: false,
        role: "user",
      },
      {
        id: "user-screenshot-developer",
        name: "Jordan Lee",
        email: "jordan@acme.example",
        emailVerified: false,
        role: "user",
      },
    ],
  });
  await prisma.account.createMany({
    data: [
      {
        id: "account-screenshot-admin",
        accountId: "user-screenshot-admin",
        providerId: "credential",
        userId: "user-screenshot-admin",
        // Deliberately unusable: screenshot users authenticate through the seeded session.
        password: "mock-password-hash-not-a-credential",
      },
      {
        id: "account-screenshot-developer",
        accountId: "jordan-oidc-subject",
        providerId: "company-oidc",
        userId: "user-screenshot-developer",
      },
    ],
  });
  await prisma.session.create({
    data: {
      id: "session-screenshot-admin",
      token: screenshotSessionToken,
      userId: "user-screenshot-admin",
      expiresAt: new Date("2035-01-01T00:00:00.000Z"),
      ipAddress: "192.0.2.42",
      userAgent: "Screenshot Browser",
    },
  });
  await prisma.apiKey.create({
    data: {
      id: "api-key-screenshot-ci",
      configId: "default",
      name: "CI automation",
      start: "aide_mock_ci",
      prefix: "aide_",
      referenceId: "user-screenshot-developer",
      // The fixture contains metadata and a non-reversible placeholder, never a usable raw key.
      key: "sha256:screenshot-only-non-secret-placeholder",
      enabled: true,
      rateLimitEnabled: false,
      requestCount: 18,
      lastRequest: new Date("2026-07-31T14:30:00.000Z"),
    },
  });
  await prisma.authSettings.create({
    data: {
      id: "default",
      bootstrapCompleted: true,
      registrationEnabled: true,
    },
  });
}
