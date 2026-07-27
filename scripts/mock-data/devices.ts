import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo, daysFromNow } from "./time";

export async function seedDevices(prisma: PrismaClient): Promise<void> {
  await prisma.iosDevice.create({
    data: {
      id: ids.devices.iphone,
      udid: "00008130-000A1B2C3D4E5F60",
      displayName: "Acme QA iPhone",
      product: "iPhone16,1",
      osVersion: "iOS 18.5",
      platform: "IOS",
      status: "REGISTERED",
      appleDeviceId: "ACMEDEV000001",
      appleStatus: "ENABLED",
      registeredAt: daysAgo(14),
      lastSeenAt: hoursAgo(2),
      createdAt: daysAgo(14),
    },
  });

  await prisma.iosDevice.create({
    data: {
      id: ids.devices.ipad,
      udid: "00008120-000B2C3D4E5F6071",
      displayName: "Acme Design iPad",
      product: "iPad14,1",
      osVersion: "iPadOS 18.5",
      platform: "IOS",
      status: "REGISTERED",
      appleDeviceId: "ACMEDEV000002",
      appleStatus: "ENABLED",
      registeredAt: daysAgo(9),
      lastSeenAt: daysAgo(1),
      createdAt: daysAgo(9),
    },
  });

  await prisma.iosDeviceEnrollment.create({
    data: {
      id: "device-enrollment-iphone",
      deviceId: ids.devices.iphone,
      tokenHash: "enrollment-token-hash-iphone",
      displayName: "Acme QA iPhone",
      status: "COMPLETED",
      expiresAt: daysAgo(13),
      downloadedAt: daysAgo(14),
      consumedAt: daysAgo(14),
      createdAt: daysAgo(14),
      ipObservations: {
        create: [
          {
            id: "ip-observation-iphone",
            deviceId: ids.devices.iphone,
            ipAddress: "203.0.113.42",
            source: "PROFILE_DOWNLOAD",
            headerSource: "CLOUDFLARE",
            observedAt: daysAgo(14),
          },
        ],
      },
    },
  });

  await prisma.iosDeviceEnrollment.create({
    data: {
      id: ids.deviceEnrollments.pending,
      tokenHash: "enrollment-token-hash-pending",
      displayName: "New Tester Device",
      status: "ISSUED",
      expiresAt: daysFromNow(6),
      createdAt: minutesAgo(30),
    },
  });
}
