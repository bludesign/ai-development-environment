// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { SigningAssetsService } from "./signing-assets.service";

function agentControl(overrides: Record<string, unknown> = {}) {
  return {
    registerCompletionHandler: vi.fn(),
    createJob: vi.fn(),
    createSigningSecretTransfer: vi.fn(),
    revokeSigningSecretTransfer: vi.fn(),
    ...overrides,
  };
}

describe("SigningAssetsService profile devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("matches profile UDIDs to enrolled devices without changing profile order", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "device-1",
        udid: "A".repeat(40),
        displayName: "Test iPhone",
        product: "iPhone17,1",
        osVersion: "26.0",
        status: "REGISTERED",
      },
    ]);
    getPrismaClient.mockResolvedValue({ iosDevice: { findMany } });
    const service = new SigningAssetsService(agentControl() as never);

    const devices = await service.profileDevices([
      "a".repeat(40),
      "B".repeat(40),
      "A".repeat(40),
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { udid: { in: ["A".repeat(40), "B".repeat(40)] } },
      select: {
        id: true,
        udid: true,
        displayName: true,
        product: true,
        osVersion: true,
        status: true,
      },
    });
    expect(devices).toEqual([
      {
        udid: "a".repeat(40),
        deviceId: "device-1",
        displayName: "Test iPhone",
        product: "iPhone17,1",
        osVersion: "26.0",
        status: "REGISTERED",
      },
      {
        udid: "B".repeat(40),
        deviceId: null,
        displayName: null,
        product: null,
        osVersion: null,
        status: null,
      },
    ]);
  });
});

describe("SigningAssetsService identity operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("rejects identity imports for offline agents before creating transfers", async () => {
    getPrismaClient.mockResolvedValue({
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            name: "Offline Mac",
            capabilitiesJson: JSON.stringify(["ios.signing.identity.import"]),
            lastSeenAt: new Date(0),
            disconnectedAt: null,
          },
        ]),
      },
    });
    const control = agentControl();
    const service = new SigningAssetsService(control as never);

    await expect(
      service.importIdentity({
        p12Base64: Buffer.from("p12").toString("base64"),
        passphrase: "secret",
        targetAgentIds: ["agent-1"],
      }),
    ).rejects.toThrow("Identity imports require online supported agents");
    expect(control.createSigningSecretTransfer).not.toHaveBeenCalled();
    expect(control.createJob).not.toHaveBeenCalled();
  });

  test("deletes an identity only from agents that hold its private key", async () => {
    const operationCreate = vi.fn().mockImplementation(({ data }) => ({
      id: data.id,
      ...data,
      items: data.items.create.map(
        (item: { id: string; agentId: string; status: string }) => ({
          ...item,
          agent: { id: item.agentId, name: item.agentId },
        }),
      ),
    }));
    getPrismaClient.mockResolvedValue({
      signingCertificateAsset: {
        findMany: vi.fn().mockResolvedValue([{ agentId: "agent-key" }]),
      },
      signingOperation: { create: operationCreate },
      signingOperationItem: { update: vi.fn().mockResolvedValue({}) },
    });
    const createJob = vi.fn().mockResolvedValue({
      id: "job-1",
      status: "QUEUED",
    });
    const service = new SigningAssetsService(
      agentControl({ createJob }) as never,
    );

    await service.deleteIdentity("a".repeat(40), [
      "agent-key",
      "agent-certificate-only",
    ]);

    expect(operationCreate.mock.calls[0]?.[0].data.items.create).toEqual([
      expect.objectContaining({ agentId: "agent-key" }),
    ]);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-key",
        payload: { sha1: "A".repeat(40) },
      }),
    );
  });

  test("exposes the private-key installation subset for each certificate", async () => {
    const certificate = {
      sha1: "A".repeat(40),
      sha256: null,
      name: "Apple Development",
      teamId: "TEAM123456",
      certificateType: "DEVELOPMENT",
      notBefore: null,
      expiresAt: null,
      expired: false,
      missingAt: null,
    };
    getPrismaClient.mockResolvedValue({
      signingCertificateAsset: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...certificate,
            hasPrivateKey: true,
            agent: { id: "agent-key", name: "Key Mac" },
          },
          {
            ...certificate,
            hasPrivateKey: false,
            agent: { id: "agent-certificate", name: "Certificate Mac" },
          },
        ]),
      },
    });
    const service = new SigningAssetsService(agentControl() as never);

    const [result] = await service.certificates();

    expect(result?.installedAgents).toHaveLength(2);
    expect(result?.privateKeyAgents).toEqual([
      { id: "agent-key", name: "Key Mac" },
    ]);
  });
});
