import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, daysFromNow } from "./time";

export async function seedSigning(prisma: PrismaClient): Promise<void> {
  await prisma.signingCertificateAsset.create({
    data: {
      id: ids.signing.certificateDistribution,
      agentId: ids.agents.build,
      sha1: "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678",
      sha256: "sha256-distribution-cert-0001",
      name: "Apple Distribution: Acme Inc. (ACME9T4R2K)",
      teamId: "ACME9T4R2K",
      certificateType: "DISTRIBUTION",
      notBefore: daysAgo(200),
      expiresAt: daysFromNow(165),
      hasPrivateKey: true,
      observedAt: hoursAgo(6),
    },
  });

  await prisma.signingCertificateAsset.create({
    data: {
      id: "signing-cert-development",
      agentId: ids.agents.build,
      sha1: "B2C3D4E5F60718293A4B5C6D7E8F901234567890",
      name: "Apple Development: Jane Doe (ACME9T4R2K)",
      teamId: "ACME9T4R2K",
      certificateType: "DEVELOPMENT",
      notBefore: daysAgo(120),
      expiresAt: daysFromNow(245),
      hasPrivateKey: true,
      observedAt: hoursAgo(6),
    },
  });

  await prisma.signingProfileAsset.create({
    data: {
      id: ids.signing.profileAppStore,
      agentId: ids.agents.build,
      uuid: "acme0000-1111-2222-3333-444455556666",
      contentHash: "sha256-appstore-profile-0001",
      name: "Acme App Store",
      profileType: "APP_STORE",
      bundleId: "com.acme.app",
      teamId: "ACME9T4R2K",
      teamName: "Acme Inc.",
      platformsJson: JSON.stringify(["iOS"]),
      deviceCount: 0,
      certificateSha1sJson: JSON.stringify([
        "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678",
      ]),
      createdAt: daysAgo(30),
      expiresAt: daysFromNow(335),
      xcodeManaged: false,
      observedAt: hoursAgo(6),
    },
  });

  await prisma.signingProfileAsset.create({
    data: {
      id: "signing-profile-development",
      agentId: ids.agents.build,
      uuid: "acme7777-8888-9999-aaaa-bbbbccccdddd",
      contentHash: "sha256-development-profile-0001",
      name: "Acme Development",
      profileType: "DEVELOPMENT",
      bundleId: "com.acme.app",
      teamId: "ACME9T4R2K",
      teamName: "Acme Inc.",
      platformsJson: JSON.stringify(["iOS"]),
      deviceCount: 2,
      deviceUdidsJson: JSON.stringify([
        "00008130-000A1B2C3D4E5F60",
        "00008120-000B2C3D4E5F6071",
      ]),
      certificateSha1sJson: JSON.stringify([
        "B2C3D4E5F60718293A4B5C6D7E8F901234567890",
      ]),
      createdAt: daysAgo(20),
      expiresAt: daysFromNow(20),
      xcodeManaged: true,
      observedAt: hoursAgo(6),
    },
  });
}
