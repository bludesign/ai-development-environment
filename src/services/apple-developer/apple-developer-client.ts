import { importPKCS8, SignJWT } from "jose";

import { getPrismaClient } from "@/data/prisma-client";

const API_ROOT = "https://api.appstoreconnect.apple.com";

export type AppleDeveloperCredentials = {
  issuerId: string;
  keyId: string;
  privateKey: string;
};

type AppleError = {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
};

type JsonApiDocument<T> = {
  data: T;
  links?: { next?: string | null };
  errors?: AppleError[];
};

export class AppleDeveloperRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: AppleError[],
  ) {
    super(message);
    this.name = "AppleDeveloperRequestError";
  }
}

export async function storedAppleDeveloperCredentials(): Promise<AppleDeveloperCredentials> {
  const prisma = await getPrismaClient();
  const settings = await prisma.iosDeviceSettings.findUnique({
    where: { id: "default" },
    select: {
      appStoreConnectIssuerId: true,
      appStoreConnectKeyId: true,
      appStoreConnectPrivateKey: true,
    },
  });
  if (
    !settings?.appStoreConnectIssuerId ||
    !settings.appStoreConnectKeyId ||
    !settings.appStoreConnectPrivateKey
  ) {
    throw new Error("App Store Connect API credentials are not configured");
  }
  return {
    issuerId: settings.appStoreConnectIssuerId,
    keyId: settings.appStoreConnectKeyId,
    privateKey: settings.appStoreConnectPrivateKey,
  };
}

export class AppleDeveloperClient {
  constructor(
    private readonly credentials: AppleDeveloperCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await importPKCS8(this.credentials.privateKey, "ES256");
    } catch {
      throw new Error(
        "The App Store Connect key must be an ES256 PKCS#8 private key",
      );
    }
    return new SignJWT({})
      .setProtectedHeader({
        alg: "ES256",
        kid: this.credentials.keyId,
        typ: "JWT",
      })
      .setIssuer(this.credentials.issuerId)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
  }

  async request<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${API_ROOT}${pathOrUrl}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(20_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new Error("Apple Developer API timed out; retry the operation");
      }
      throw new Error("Could not connect to the Apple Developer API");
    }
    if (response.status === 204) return undefined as T;
    const body = (await response.json().catch(() => ({}))) as {
      errors?: AppleError[];
    } & T;
    if (!response.ok) {
      const detail = body.errors
        ?.map((error) => error.detail || error.title || error.code)
        .filter(Boolean)
        .join("; ");
      const permission = response.status === 401 || response.status === 403;
      throw new AppleDeveloperRequestError(
        permission
          ? "Apple rejected the API key or it lacks Certificates, Identifiers & Profiles permission"
          : detail || `Apple Developer API returned HTTP ${response.status}`,
        response.status,
        body.errors ?? [],
      );
    }
    return body;
  }

  async list<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let next: string | null = path;
    while (next) {
      const document: JsonApiDocument<T[]> = await this.request(next);
      values.push(...document.data);
      next = document.links?.next ?? null;
    }
    return values;
  }

  listProfiles() {
    return this.list<AppleProfileResource>(
      "/v1/profiles?limit=200&include=bundleId,certificates,devices",
    );
  }

  listCertificates() {
    return this.list<AppleCertificateResource>("/v1/certificates?limit=200");
  }

  listBundleIds() {
    return this.list<AppleBundleIdResource>("/v1/bundleIds?limit=200");
  }

  listDevices() {
    return this.list<AppleDeviceResource>("/v1/devices?limit=200");
  }

  async createProfile(input: {
    name: string;
    profileType: string;
    bundleIdId: string;
    certificateIds: string[];
    deviceIds?: string[];
  }) {
    const relationships: Record<string, unknown> = {
      bundleId: { data: { type: "bundleIds", id: input.bundleIdId } },
      certificates: {
        data: input.certificateIds.map((id) => ({ type: "certificates", id })),
      },
    };
    if (input.deviceIds?.length) {
      relationships.devices = {
        data: input.deviceIds.map((id) => ({ type: "devices", id })),
      };
    }
    return this.request<JsonApiDocument<AppleProfileResource>>("/v1/profiles", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "profiles",
          attributes: {
            name: input.name,
            profileType: input.profileType,
          },
          relationships,
        },
      }),
    });
  }

  deleteProfile(id: string) {
    return this.request<void>(`/v1/profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  revokeCertificate(id: string) {
    return this.request<void>(`/v1/certificates/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}

export type AppleProfileResource = {
  type: "profiles";
  id: string;
  attributes: {
    name?: string;
    profileState?: string;
    profileType?: string;
    profileContent?: string;
    uuid?: string;
    platform?: string;
    createdDate?: string;
    expirationDate?: string;
  };
  relationships?: Record<string, { data?: unknown }>;
};

export type AppleCertificateResource = {
  type: "certificates";
  id: string;
  attributes: {
    name?: string;
    displayName?: string;
    certificateType?: string;
    serialNumber?: string;
    platform?: string;
    expirationDate?: string;
    certificateContent?: string;
  };
};

export type AppleBundleIdResource = {
  type: "bundleIds";
  id: string;
  attributes: { name?: string; identifier?: string; platform?: string };
};

export type AppleDeviceResource = {
  type: "devices";
  id: string;
  attributes: {
    name?: string;
    udid?: string;
    platform?: string;
    status?: string;
  };
};
