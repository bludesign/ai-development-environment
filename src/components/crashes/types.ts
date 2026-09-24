export type CrashReportStatus =
  | "PENDING"
  | "WAITING_FOR_AGENT"
  | "SYMBOLICATING"
  | "SYMBOLICATED"
  | "PARTIALLY_SYMBOLICATED"
  | "MISSING_DSYMS"
  | "FAILED";

export const CRASH_REPORT_STATUSES: CrashReportStatus[] = [
  "PENDING",
  "WAITING_FOR_AGENT",
  "SYMBOLICATING",
  "SYMBOLICATED",
  "PARTIALLY_SYMBOLICATED",
  "MISSING_DSYMS",
  "FAILED",
];

export type DsymUploadStatus =
  "UPLOADING" | "PENDING_TRANSFER" | "PROCESSING" | "READY" | "FAILED";

export type CrashFrame = {
  index: number;
  imageName: string | null;
  imageUuid: string | null;
  address: string | null;
  imageOffset: string | null;
  symbol: string | null;
  symbolOffset: number | null;
  sourceFile: string | null;
  sourceLine: number | null;
  inlined: boolean;
  isAppFrame: boolean;
  symbolicated: boolean;
};

export type CrashThread = {
  index: number;
  name: string | null;
  queue: string | null;
  crashed: boolean;
  frames: CrashFrame[];
};

export type CrashSummary = {
  id: string;
  format: "IPS" | "CRASH" | "METRICKIT";
  source: "UPLOAD" | "API";
  status: CrashReportStatus;
  statusMessage: string | null;
  filename: string;
  appName: string | null;
  bundleId: string | null;
  appVersion: string | null;
  buildVersion: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  exceptionType: string | null;
  signal: string | null;
  signatureTitle: string;
  crashedAt: string | null;
  createdAt: string;
  topAppFrame: CrashFrame | null;
};

export type DsymSlice = {
  id: string;
  uuid: string;
  arch: string;
  textVmAddr: string;
};

export type DsymUpload = {
  id: string;
  filename: string;
  status: DsymUploadStatus;
  error: string | null;
  source: "UPLOAD" | "API" | "BUILD";
  uploadedBy: string | null;
  buildId: string | null;
  linkedBuildId: string | null;
  url: string | null;
  projectName: string | null;
  sizeBytes: number;
  uploadOffset: number;
  attempts: number;
  dsymCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DsymSummary = {
  id: string;
  bundleName: string;
  binaryName: string;
  bundleIdentifier: string | null;
  shortVersion: string | null;
  bundleVersion: string | null;
  dwarfSizeBytes: number;
  createdAt: string;
  crashCount: number;
  slices: DsymSlice[];
  upload: DsymUpload;
};

export type CrashBinaryImage = {
  id: string;
  uuid: string | null;
  name: string;
  arch: string | null;
  loadAddress: string | null;
  path: string | null;
  isApp: boolean;
  frameCount: number;
  dsym: { id: string; bundleName: string } | null;
};

export type CrashDetail = CrashSummary & {
  sizeBytes: number;
  incidentId: string | null;
  arch: string | null;
  exceptionCodes: string | null;
  exceptionSubtype: string | null;
  exceptionReason: string | null;
  terminationReason: string | null;
  applicationSpecificInformation: string[];
  crashedThread: number | null;
  updatedAt: string;
  symbolicatedAt: string | null;
  signature: string;
  uploadedBy: string | null;
  apiKeyName: string | null;
  clientIp: string | null;
  attempts: number;
  threads: CrashThread[];
  lastExceptionBacktrace: CrashFrame[] | null;
  binaryImages: CrashBinaryImage[];
  missingImages: CrashBinaryImage[];
  attachedDsyms: DsymSummary[];
  similarCrashCount: number;
  similarCrashes: CrashSummary[];
  symbolicatedText: string;
  originalDownloadUrl: string;
  symbolicatedDownloadUrl: string;
};

export type DsymDetail = DsymSummary & {
  dwarfSha256: string;
  downloadUrl: string;
  siblingDsyms: DsymSummary[];
  crashes: {
    nodes: CrashSummary[];
    nextCursor: string | null;
    totalCount: number;
  };
};

export type CrashSymbolicationAgent = {
  id: string;
  name: string;
  hostname: string;
  online: boolean;
};

export type CrashSettings = {
  collectionEnabled: boolean;
  symbolicationAgentId: string | null;
  retentionDays: number;
  dsymRetentionDays: number | null;
};
