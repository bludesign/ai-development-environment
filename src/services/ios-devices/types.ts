export const IOS_DEVICE_STATUSES = [
  "PENDING",
  "REGISTERING",
  "REGISTERED",
  "REGISTRATION_FAILED",
  "REJECTED",
] as const;

export type IosDeviceStatus = (typeof IOS_DEVICE_STATUSES)[number];

export type IosDeviceSettingsView = {
  organizationName: string;
  profileIdentifier: string;
  signerConfigured: boolean;
  signerFingerprint: string | null;
  signerCreatedAt: string | null;
  signerExpiresAt: string | null;
  appStoreConnectConfigured: boolean;
  appStoreConnectIssuerId: string | null;
  appStoreConnectKeyId: string | null;
  appStoreConnectPrivateKeyConfigured: boolean;
  appStoreConnectPrivateKeyFingerprint: string | null;
  appStoreConnectVerifiedAt: string | null;
  appStoreConnectLastTestedAt: string | null;
  appStoreConnectVerificationError: string | null;
  updatedAt: string;
};

export type AppStoreConnectSettingsInput = {
  issuerId: string;
  keyId: string;
  privateKey?: string | null;
};

export type IosFirmwareVersion = {
  version: string;
  buildId: string;
  fileSize: number;
  url: string;
  releaseDate: string;
  signed: boolean;
};

export type IosDeviceFirmware = {
  name: string;
  identifier: string;
  firmwares: IosFirmwareVersion[];
};
