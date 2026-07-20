export type IosDeviceStatus =
  "PENDING" | "REGISTERING" | "REGISTERED" | "REGISTRATION_FAILED" | "REJECTED";

export type IosDeviceEnrollment = {
  id: string;
  status: "ISSUED" | "DOWNLOADED" | "COMPLETED" | "EXPIRED" | "FAILED";
  displayName: string;
  expiresAt: string;
  downloadedAt: string | null;
  consumedAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IosDeviceIpObservation = {
  id: string;
  ipAddress: string;
  source: "PROFILE_DOWNLOAD" | "PROFILE_RESPONSE";
  headerSource: "CLOUDFLARE" | "FORWARDED" | "REAL_IP";
  observedAt: string;
};

export type IosDeviceRecord = {
  id: string;
  udid: string;
  maskedUdid: string;
  displayName: string;
  product: string | null;
  osVersion: string | null;
  platform: string;
  status: IosDeviceStatus;
  appleDeviceId: string | null;
  appleStatus: string | null;
  registrationError: string | null;
  registeredAt: string | null;
  lastSeenAt: string | null;
  lastIpAddress: string | null;
  createdAt: string;
  updatedAt: string;
  enrollments: IosDeviceEnrollment[];
  ipObservations: IosDeviceIpObservation[];
};

export type IosDeviceSummary = Pick<
  IosDeviceRecord,
  | "id"
  | "maskedUdid"
  | "displayName"
  | "product"
  | "osVersion"
  | "platform"
  | "status"
  | "appleStatus"
  | "registeredAt"
  | "lastSeenAt"
  | "lastIpAddress"
  | "createdAt"
  | "updatedAt"
>;

export const IOS_DEVICE_LIST_FIELDS = `
  id maskedUdid displayName product osVersion platform status appleStatus
  registeredAt lastSeenAt lastIpAddress createdAt updatedAt
`;

export type IosDeviceSettings = {
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

export const IOS_DEVICE_FIELDS = `
  id udid maskedUdid displayName product osVersion platform status
  appleDeviceId appleStatus registrationError registeredAt lastSeenAt
  lastIpAddress createdAt updatedAt
  enrollments {
    id status displayName expiresAt downloadedAt consumedAt failureCode createdAt updatedAt
  }
  ipObservations { id ipAddress source headerSource observedAt }
`;

export const IOS_DEVICE_SETTINGS_FIELDS = `
  organizationName profileIdentifier signerConfigured signerFingerprint
  signerCreatedAt signerExpiresAt appStoreConnectConfigured
  appStoreConnectIssuerId appStoreConnectKeyId
  appStoreConnectPrivateKeyConfigured appStoreConnectPrivateKeyFingerprint
  appStoreConnectVerifiedAt appStoreConnectLastTestedAt
  appStoreConnectVerificationError updatedAt
`;
