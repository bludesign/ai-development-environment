import type { PrismaClient } from "../../src/generated/prisma/client";

import { daysAgo, hoursAgo, minutesAgo } from "./time";

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
        createdAt: daysAgo(180),
        updatedAt: daysAgo(5),
      },
      {
        id: "user-screenshot-developer",
        name: "Jordan Lee",
        email: "jordan@acme.example",
        emailVerified: false,
        role: "user",
        createdAt: daysAgo(120),
        updatedAt: daysAgo(8),
      },
    ],
  });
  await prisma.account.createMany({
    data: [
      {
        id: "account-screenshot-admin",
        issuer: "local:credential",
        accountId: "user-screenshot-admin",
        providerId: "credential",
        userId: "user-screenshot-admin",
        // Deliberately unusable: screenshot users authenticate through the seeded session.
        password: "mock-password-hash-not-a-credential",
        createdAt: daysAgo(180),
        updatedAt: daysAgo(5),
      },
      {
        id: "account-screenshot-developer",
        issuer: "local:oauth:company-oidc",
        accountId: "jordan-oidc-subject",
        providerId: "company-oidc",
        userId: "user-screenshot-developer",
        createdAt: daysAgo(120),
        updatedAt: daysAgo(8),
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
      createdAt: minutesAgo(12),
      updatedAt: minutesAgo(2),
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
      lastRequest: hoursAgo(23),
      createdAt: daysAgo(30),
      updatedAt: hoursAgo(2),
    },
  });
  await prisma.authSettings.create({
    data: {
      id: "default",
      bootstrapCompleted: true,
      registrationEnabled: true,
      createdAt: daysAgo(180),
      updatedAt: daysAgo(10),
    },
  });
}
