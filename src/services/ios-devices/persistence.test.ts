// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { IosDevicesService } from "./ios-devices.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.getPrismaClient.mockResolvedValue({
    iosDeviceEnrollment: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
    },
  });
});

describe("iOS device persistence lifecycle", () => {
  test("the migration cascades local device deletion through enrollments and IP history", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(
        readFileSync(
          join(
            process.cwd(),
            "prisma/migrations/20260720010000_add_ios_device_enrollment/migration.sql",
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          `INSERT INTO IosDevice
            (id, udid, displayName, updatedAt)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        )
        .run("device-1", "00008030-001C2D3E4F50002E", "Test iPhone");
      database
        .prepare(
          `INSERT INTO IosDeviceEnrollment
            (id, deviceId, tokenHash, displayName, expiresAt, updatedAt)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run("enrollment-1", "device-1", "token-hash", "Test iPhone");
      database
        .prepare(
          `INSERT INTO IosDeviceIpObservation
            (id, deviceId, enrollmentId, ipAddress, source, headerSource)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ip-1",
          "device-1",
          "enrollment-1",
          "203.0.113.4",
          "PROFILE_RESPONSE",
          "CLOUDFLARE",
        );

      database.prepare("DELETE FROM IosDevice WHERE id = ?").run("device-1");
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM IosDevice").get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM IosDeviceEnrollment")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM IosDeviceIpObservation")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test("adds and backfills the registration claim timestamp", () => {
    const database = new Database(":memory:");
    try {
      database.exec(
        readFileSync(
          join(
            process.cwd(),
            "prisma/migrations/20260720010000_add_ios_device_enrollment/migration.sql",
          ),
          "utf8",
        ),
      );
      database
        .prepare(
          `INSERT INTO IosDevice
            (id, udid, displayName, status, updatedAt)
           VALUES (?, ?, ?, 'REGISTERING', ?)`,
        )
        .run(
          "device-1",
          "00008030-001C2D3E4F50002E",
          "Test iPhone",
          "2026-07-20T12:00:00.000Z",
        );

      database.exec(
        readFileSync(
          join(
            process.cwd(),
            "prisma/migrations/20260720020000_add_ios_registration_claim_timestamp/migration.sql",
          ),
          "utf8",
        ),
      );

      expect(
        database
          .prepare("SELECT registrationClaimedAt FROM IosDevice WHERE id = ?")
          .get("device-1"),
      ).toEqual({ registrationClaimedAt: "2026-07-20T12:00:00.000Z" });
    } finally {
      database.close();
    }
  });

  test("expires active tokens and purges only unattached records after seven days", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    await new IosDevicesService().purgeExpiredEnrollments(now);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["ISSUED", "DOWNLOADED"] },
        expiresAt: { lt: now },
      },
      data: { status: "EXPIRED", failureCode: "TOKEN_EXPIRED" },
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        deviceId: null,
        expiresAt: { lt: new Date("2026-07-13T12:00:00.000Z") },
      },
    });
  });
});
