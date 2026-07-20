import { createHash, randomUUID } from "node:crypto";

import {
  SIGNING_ASSETS_SCAN_JOB_KIND,
  SIGNING_IDENTITY_DELETE_JOB_KIND,
  SIGNING_IDENTITY_IMPORT_JOB_KIND,
  SIGNING_PROFILE_DELETE_JOB_KIND,
  SIGNING_PROFILE_INSTALL_JOB_KIND,
  SIGNING_PROFILE_READ_JOB_KIND,
  parseSigningAssetsScanResult,
} from "@ai-development-environment/agent-contract/signing-assets";

import { getPrismaClient } from "@/data/prisma-client";
import {
  AppleDeveloperClient,
  storedAppleDeveloperCredentials,
} from "@/services/apple-developer";
import type { AgentControlService } from "@/services/agent-control";
import {
  agentEventBus,
  SIGNING_ASSETS_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";

type JobCompletion = {
  id: string;
  agentId: string;
  kind: string;
  status: string;
  resultJson: string | null;
  error: string | null;
};

type JsonObject = Record<string, unknown>;

function jsonObject(value: string | null): JsonObject {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

function date(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function stringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export class SigningAssetsService {
  constructor(
    private readonly agentControl: AgentControlService,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.agentControl.registerCompletionHandler(
      SIGNING_ASSETS_SCAN_JOB_KIND,
      (job) => this.completeScan(job),
    );
    for (const kind of [
      SIGNING_PROFILE_READ_JOB_KIND,
      SIGNING_PROFILE_INSTALL_JOB_KIND,
      SIGNING_PROFILE_DELETE_JOB_KIND,
      SIGNING_IDENTITY_IMPORT_JOB_KIND,
      SIGNING_IDENTITY_DELETE_JOB_KIND,
    ]) {
      this.agentControl.registerCompletionHandler(kind, (job) =>
        this.completeOperation(job),
      );
    }
  }

  private changed(): void {
    agentEventBus.publish(SIGNING_ASSETS_CHANGED_TOPIC, { changed: true });
  }

  private deleteTransferJobSoon(jobId: string): void {
    // Leave a brief retry window for an agent whose completion response is
    // lost, then remove the system payload/result material automatically.
    const timer = setTimeout(() => {
      void getPrismaClient().then((prisma) =>
        prisma.agentJob.deleteMany({
          where: { id: jobId, visibility: "SYSTEM" },
        }),
      );
    }, 30_000);
    timer.unref();
  }

  subscribe() {
    return agentEventBus.iterate<{ changed: boolean }>(
      SIGNING_ASSETS_CHANGED_TOPIC,
    );
  }

  private async completeScan(job: JobCompletion): Promise<void> {
    if (job.status !== "SUCCEEDED") return;
    const result = parseSigningAssetsScanResult(jsonObject(job.resultJson));
    const prisma = await getPrismaClient();
    const observedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.signingProfileAsset.updateMany({
        where: { agentId: job.agentId, missingAt: null },
        data: { missingAt: observedAt },
      });
      await tx.signingCertificateAsset.updateMany({
        where: { agentId: job.agentId, missingAt: null },
        data: { missingAt: observedAt },
      });
      for (const profile of result.profiles) {
        await tx.signingProfileAsset.upsert({
          where: {
            agentId_uuid: { agentId: job.agentId, uuid: profile.uuid },
          },
          create: {
            id: randomUUID(),
            agentId: job.agentId,
            uuid: profile.uuid,
            contentHash: profile.contentHash,
            name: profile.name,
            profileType: profile.profileType,
            bundleId: profile.bundleId,
            teamId: profile.teamId,
            teamName: profile.teamName,
            platformsJson: JSON.stringify(profile.platforms),
            deviceCount: profile.deviceCount,
            deviceUdidsJson: JSON.stringify(profile.deviceUdids),
            certificateSha1sJson: JSON.stringify(profile.certificateSha1s),
            createdAt: date(profile.createdAt),
            expiresAt: date(profile.expiresAt),
            expired: profile.expired,
            xcodeManaged: profile.xcodeManaged,
            observedAt,
          },
          update: {
            contentHash: profile.contentHash,
            name: profile.name,
            profileType: profile.profileType,
            bundleId: profile.bundleId,
            teamId: profile.teamId,
            teamName: profile.teamName,
            platformsJson: JSON.stringify(profile.platforms),
            deviceCount: profile.deviceCount,
            deviceUdidsJson: JSON.stringify(profile.deviceUdids),
            certificateSha1sJson: JSON.stringify(profile.certificateSha1s),
            createdAt: date(profile.createdAt),
            expiresAt: date(profile.expiresAt),
            expired: profile.expired,
            xcodeManaged: profile.xcodeManaged,
            observedAt,
            missingAt: null,
          },
        });
      }
      for (const certificate of result.certificates) {
        await tx.signingCertificateAsset.upsert({
          where: {
            agentId_sha1: { agentId: job.agentId, sha1: certificate.sha1 },
          },
          create: {
            id: randomUUID(),
            agentId: job.agentId,
            sha1: certificate.sha1,
            sha256: certificate.sha256,
            name: certificate.name,
            teamId: certificate.teamId,
            certificateType: certificate.certificateType,
            notBefore: date(certificate.notBefore),
            expiresAt: date(certificate.expiresAt),
            expired: certificate.expired,
            hasPrivateKey: certificate.hasPrivateKey,
            observedAt,
          },
          update: {
            sha256: certificate.sha256,
            name: certificate.name,
            teamId: certificate.teamId,
            certificateType: certificate.certificateType,
            notBefore: date(certificate.notBefore),
            expiresAt: date(certificate.expiresAt),
            expired: certificate.expired,
            hasPrivateKey: certificate.hasPrivateKey,
            observedAt,
            missingAt: null,
          },
        });
      }
    });
    this.deleteTransferJobSoon(job.id);
    this.changed();
  }

  private async refreshAfterMutation(agentId: string, operationId: string) {
    await this.agentControl.createJob({
      agentId,
      kind: SIGNING_ASSETS_SCAN_JOB_KIND,
      payload: {},
      idempotencyKey: `signing:${operationId}:${agentId}:refresh`,
      timeoutSeconds: 60,
      visibility: "SYSTEM",
    });
  }

  private async finishOperation(operationId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const items = await prisma.signingOperationItem.findMany({
      where: { operationId },
    });
    const active = items.some((item) =>
      ["WAITING", "QUEUED", "RUNNING"].includes(item.status),
    );
    if (active) return;
    const failed = items.filter((item) => item.status !== "SUCCEEDED");
    await prisma.signingOperation.update({
      where: { id: operationId },
      data: {
        status: failed.length ? "FAILED" : "SUCCEEDED",
        error:
          failed
            .map((item) => item.error)
            .filter(Boolean)
            .join("; ") || null,
        finishedAt: new Date(),
      },
    });
    this.changed();
  }

  private async completeOperation(job: JobCompletion): Promise<void> {
    const prisma = await getPrismaClient();
    const item = await prisma.signingOperationItem.findUnique({
      where: { jobId: job.id },
      include: { operation: true },
    });
    if (!item) return;
    await prisma.signingOperationItem.update({
      where: { id: item.id },
      data: {
        status: job.status,
        error: job.error,
        finishedAt: new Date(),
      },
    });

    if (
      job.kind === SIGNING_PROFILE_READ_JOB_KIND &&
      job.status === "SUCCEEDED" &&
      item.operation.kind === "SYNC_PROFILE"
    ) {
      const result = jsonObject(job.resultJson);
      const contentBase64 = result.contentBase64;
      if (typeof contentBase64 !== "string" || !contentBase64) {
        await prisma.signingOperation.update({
          where: { id: item.operationId },
          data: { status: "FAILED", error: "Profile read returned no content" },
        });
      } else {
        const targets = await prisma.signingOperationItem.findMany({
          where: {
            operationId: item.operationId,
            status: "WAITING",
          },
        });
        for (const target of targets) {
          const installJob = await this.agentControl.createJob({
            agentId: target.agentId,
            kind: SIGNING_PROFILE_INSTALL_JOB_KIND,
            payload: { contentBase64 },
            idempotencyKey: `signing:${item.operationId}:${target.agentId}:install`,
            timeoutSeconds: 60,
            visibility: "SYSTEM",
          });
          await prisma.signingOperationItem.update({
            where: { id: target.id },
            data: { jobId: installJob.id, status: installJob.status },
          });
        }
      }
    }
    if (
      job.kind === SIGNING_PROFILE_READ_JOB_KIND &&
      job.status !== "SUCCEEDED" &&
      item.operation.kind === "SYNC_PROFILE"
    ) {
      await prisma.signingOperationItem.updateMany({
        where: { operationId: item.operationId, status: "WAITING" },
        data: {
          status: "FAILED",
          error: "Source profile could not be read",
          finishedAt: new Date(),
        },
      });
    }

    if (
      job.status === "SUCCEEDED" &&
      job.kind !== SIGNING_PROFILE_READ_JOB_KIND
    ) {
      await this.refreshAfterMutation(job.agentId, item.operationId);
    }
    await this.finishOperation(item.operationId);
    // The operation record is the durable, redacted audit surface. Agent job
    // payloads and results (including profile bytes) are transfer material.
    this.deleteTransferJobSoon(job.id);
  }

  async refresh(agentIds?: string[]) {
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({
      where: agentIds?.length
        ? { id: { in: [...new Set(agentIds)] } }
        : undefined,
      orderBy: { name: "asc" },
    });
    const jobs = [];
    for (const agent of agents) {
      const capabilities = stringArray(agent.capabilitiesJson);
      if (!capabilities.includes(SIGNING_ASSETS_SCAN_JOB_KIND)) continue;
      jobs.push(
        await this.agentControl.createJob({
          agentId: agent.id,
          kind: SIGNING_ASSETS_SCAN_JOB_KIND,
          payload: {},
          idempotencyKey: `signing:scan:${Date.now()}:${agent.id}`,
          timeoutSeconds: 60,
          visibility: "SYSTEM",
        }),
      );
    }
    return jobs;
  }

  async agents() {
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      hostname: agent.hostname,
      supported: stringArray(agent.capabilitiesJson).includes(
        SIGNING_ASSETS_SCAN_JOB_KIND,
      ),
      lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async profiles() {
    const prisma = await getPrismaClient();
    const rows = await prisma.signingProfileAsset.findMany({
      where: { missingAt: null },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: [{ expiresAt: "asc" }, { name: "asc" }],
    });
    const grouped = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      const key = `${row.uuid}:${row.contentHash}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.values()].map((installations) => {
      const profile = installations[0]!;
      return {
        id: `${profile.uuid}:${profile.contentHash}`,
        uuid: profile.uuid,
        contentHash: profile.contentHash,
        name: profile.name,
        profileType: profile.profileType,
        bundleId: profile.bundleId,
        teamId: profile.teamId,
        teamName: profile.teamName,
        platforms: stringArray(profile.platformsJson),
        deviceCount: profile.deviceCount,
        deviceUdids: stringArray(profile.deviceUdidsJson),
        certificateSha1s: stringArray(profile.certificateSha1sJson),
        createdAt: profile.createdAt?.toISOString() ?? null,
        expiresAt: profile.expiresAt?.toISOString() ?? null,
        expired: profile.expired,
        xcodeManaged: profile.xcodeManaged,
        installedAgents: installations.map(({ agent }) => agent),
      };
    });
  }

  async profile(id: string) {
    return (await this.profiles()).find((profile) => profile.id === id) ?? null;
  }

  async profileDevices(deviceUdids: string[]) {
    const seen = new Set<string>();
    const uniqueUdids = deviceUdids.filter((udid) => {
      const normalized = udid.toUpperCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    const normalized = uniqueUdids.map((udid) => udid.toUpperCase());
    if (!normalized.length) return [];
    const prisma = await getPrismaClient();
    const devices = await prisma.iosDevice.findMany({
      where: { udid: { in: normalized } },
      select: {
        id: true,
        udid: true,
        displayName: true,
        product: true,
        osVersion: true,
        status: true,
      },
    });
    const byUdid = new Map(
      devices.map((device) => [device.udid.toUpperCase(), device]),
    );
    return uniqueUdids.map((udid) => {
      const device = byUdid.get(udid.toUpperCase());
      return {
        udid,
        deviceId: device?.id ?? null,
        displayName: device?.displayName ?? null,
        product: device?.product ?? null,
        osVersion: device?.osVersion ?? null,
        status: device?.status ?? null,
      };
    });
  }

  async certificates() {
    const prisma = await getPrismaClient();
    const rows = await prisma.signingCertificateAsset.findMany({
      where: { missingAt: null },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: [{ expiresAt: "asc" }, { name: "asc" }],
    });
    const grouped = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      grouped.set(row.sha1, [...(grouped.get(row.sha1) ?? []), row]);
    }
    return [...grouped.values()].map((installations) => {
      const certificate = installations[0]!;
      return {
        id: certificate.sha1,
        sha1: certificate.sha1,
        sha256: certificate.sha256,
        name: certificate.name,
        teamId: certificate.teamId,
        certificateType: certificate.certificateType,
        notBefore: certificate.notBefore?.toISOString() ?? null,
        expiresAt: certificate.expiresAt?.toISOString() ?? null,
        expired: certificate.expired,
        hasPrivateKey: installations.some((item) => item.hasPrivateKey),
        installedAgents: installations.map(({ agent }) => agent),
      };
    });
  }

  async operations(limit = 50) {
    const prisma = await getPrismaClient();
    return prisma.signingOperation.findMany({
      include: {
        items: {
          include: { agent: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(limit, 200)),
    });
  }

  private async operation(
    kind: string,
    assetKey: string | null,
    agentIds: string[],
    sourceAgentId: string | null = null,
    waitingAgentIds: string[] = [],
  ) {
    const prisma = await getPrismaClient();
    const id = randomUUID();
    return prisma.signingOperation.create({
      data: {
        id,
        kind,
        assetKey,
        sourceAgentId,
        items: {
          create: [...new Set(agentIds)].map((agentId) => ({
            id: randomUUID(),
            agentId,
            status: waitingAgentIds.includes(agentId) ? "WAITING" : "QUEUED",
          })),
        },
      },
      include: {
        items: {
          include: { agent: { select: { id: true, name: true } } },
        },
      },
    });
  }

  private async attachJob(itemId: string, job: { id: string; status: string }) {
    const prisma = await getPrismaClient();
    await prisma.signingOperationItem.update({
      where: { id: itemId },
      data: { jobId: job.id, status: job.status },
    });
  }

  async uploadProfile(contentBase64: string, targetAgentIds: string[]) {
    if (!targetAgentIds.length) throw new Error("Select at least one agent");
    const hash = createHash("sha256")
      .update(Buffer.from(contentBase64, "base64"))
      .digest("hex")
      .toUpperCase();
    const operation = await this.operation(
      "INSTALL_PROFILE",
      hash,
      targetAgentIds,
    );
    for (const item of operation.items) {
      const job = await this.agentControl.createJob({
        agentId: item.agentId,
        kind: SIGNING_PROFILE_INSTALL_JOB_KIND,
        payload: { contentBase64 },
        idempotencyKey: `signing:${operation.id}:${item.agentId}:install`,
        timeoutSeconds: 60,
        visibility: "SYSTEM",
      });
      await this.attachJob(item.id, job);
    }
    this.changed();
    return operation;
  }

  async downloadProfile(uuid: string, agentId: string) {
    const requestId = randomUUID();
    const job = await this.agentControl.createJob({
      agentId,
      kind: SIGNING_PROFILE_READ_JOB_KIND,
      payload: { uuid },
      idempotencyKey: `signing:download:${requestId}:${uuid}`,
      timeoutSeconds: 60,
      visibility: "SYSTEM",
    });
    const prisma = await getPrismaClient();
    try {
      const deadline = Date.now() + 55_000;
      while (Date.now() < deadline) {
        const current = await this.agentControl.getJob(job.id);
        if (!current) throw new Error("Profile download job was removed");
        if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(current.status)) {
          throw new Error(
            current.error || "Could not read provisioning profile",
          );
        }
        if (current.status === "SUCCEEDED") {
          const result = jsonObject(current.resultJson);
          if (typeof result.contentBase64 !== "string") {
            throw new Error("Agent returned no provisioning profile content");
          }
          return {
            uuid,
            filename: `${uuid}.mobileprovision`,
            contentBase64: result.contentBase64,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Timed out reading provisioning profile");
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async syncProfile(
    uuid: string,
    sourceAgentId: string,
    targetAgentIds: string[],
  ) {
    const targets = [...new Set(targetAgentIds)].filter(
      (id) => id !== sourceAgentId,
    );
    if (!targets.length) throw new Error("Select at least one target agent");
    const operation = await this.operation(
      "SYNC_PROFILE",
      uuid,
      [sourceAgentId, ...targets],
      sourceAgentId,
      targets,
    );
    const source = operation.items.find(
      (item) => item.agentId === sourceAgentId,
    )!;
    const job = await this.agentControl.createJob({
      agentId: sourceAgentId,
      kind: SIGNING_PROFILE_READ_JOB_KIND,
      payload: { uuid },
      idempotencyKey: `signing:${operation.id}:${sourceAgentId}:read`,
      timeoutSeconds: 60,
      visibility: "SYSTEM",
    });
    await this.attachJob(source.id, job);
    this.changed();
    return operation;
  }

  async deleteProfile(uuid: string, agentIds: string[]) {
    if (!agentIds.length) throw new Error("Select at least one agent");
    const operation = await this.operation("DELETE_PROFILE", uuid, agentIds);
    for (const item of operation.items) {
      const job = await this.agentControl.createJob({
        agentId: item.agentId,
        kind: SIGNING_PROFILE_DELETE_JOB_KIND,
        payload: { uuid },
        idempotencyKey: `signing:${operation.id}:${item.agentId}:delete`,
        timeoutSeconds: 60,
        visibility: "SYSTEM",
      });
      await this.attachJob(item.id, job);
    }
    this.changed();
    return operation;
  }

  async deleteExpiredProfiles(agentIds?: string[]) {
    const prisma = await getPrismaClient();
    const rows = await prisma.signingProfileAsset.findMany({
      where: {
        expired: true,
        missingAt: null,
        ...(agentIds?.length ? { agentId: { in: agentIds } } : {}),
      },
    });
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      grouped.set(row.uuid, [...(grouped.get(row.uuid) ?? []), row.agentId]);
    }
    const operations = [];
    for (const [uuid, targets] of grouped) {
      operations.push(await this.deleteProfile(uuid, targets));
    }
    return operations;
  }

  async importIdentity(input: {
    p12Base64: string;
    passphrase: string;
    targetAgentIds: string[];
  }) {
    if (!input.targetAgentIds.length)
      throw new Error("Select at least one agent");
    const bytes = Buffer.from(input.p12Base64, "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
      throw new Error("The .p12 file is empty or larger than 20 MiB");
    }
    const sha256 = createHash("sha256")
      .update(bytes)
      .digest("hex")
      .toUpperCase();
    const operation = await this.operation(
      "IMPORT_IDENTITY",
      sha256,
      input.targetAgentIds,
    );
    for (const item of operation.items) {
      const transferId = this.agentControl.createSigningSecretTransfer(
        item.agentId,
        { p12Base64: input.p12Base64, passphrase: input.passphrase },
      );
      try {
        const job = await this.agentControl.createJob({
          agentId: item.agentId,
          kind: SIGNING_IDENTITY_IMPORT_JOB_KIND,
          payload: { transferId, sha256 },
          idempotencyKey: `signing:${operation.id}:${item.agentId}:import`,
          timeoutSeconds: 120,
          visibility: "SYSTEM",
        });
        await this.attachJob(item.id, job);
      } catch (error) {
        this.agentControl.revokeSigningSecretTransfer(transferId);
        throw error;
      }
    }
    this.changed();
    return operation;
  }

  async deleteIdentity(sha1: string, agentIds: string[]) {
    if (!agentIds.length) throw new Error("Select at least one agent");
    const operation = await this.operation("DELETE_IDENTITY", sha1, agentIds);
    for (const item of operation.items) {
      const job = await this.agentControl.createJob({
        agentId: item.agentId,
        kind: SIGNING_IDENTITY_DELETE_JOB_KIND,
        payload: { sha1 },
        idempotencyKey: `signing:${operation.id}:${item.agentId}:delete`,
        timeoutSeconds: 60,
        visibility: "SYSTEM",
      });
      await this.attachJob(item.id, job);
    }
    this.changed();
    return operation;
  }

  private async appleClient() {
    return new AppleDeveloperClient(
      await storedAppleDeveloperCredentials(),
      this.fetcher,
    );
  }

  async portalInventory() {
    const client = await this.appleClient();
    const [profiles, certificates, bundleIds, devices] = await Promise.all([
      client.listProfiles(),
      client.listCertificates(),
      client.listBundleIds(),
      client.listDevices(),
    ]);
    return { profiles, certificates, bundleIds, devices };
  }

  async createPortalProfile(input: {
    name: string;
    profileType: string;
    bundleIdId: string;
    certificateIds: string[];
    deviceIds?: string[];
  }) {
    const result = await (await this.appleClient()).createProfile(input);
    this.changed();
    return result.data;
  }

  async deletePortalProfile(id: string) {
    await (await this.appleClient()).deleteProfile(id);
    this.changed();
    return true;
  }

  async revokePortalCertificate(id: string) {
    await (await this.appleClient()).revokeCertificate(id);
    this.changed();
    return true;
  }
}
