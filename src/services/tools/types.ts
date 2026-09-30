export type ExternalMcpTransport = "STREAMABLE_HTTP" | "SSE";

export type ExternalMcpServerHeaderView = {
  id: string;
  name: string;
  valueConfigured: boolean;
};

export type ExternalMcpServerView = {
  id: string;
  name: string;
  url: string;
  transport: ExternalMcpTransport;
  toolNamePrefix: string;
  headers: ExternalMcpServerHeaderView[];
  createdAt: string;
  updatedAt: string;
};

export type ExternalMcpServerInput = {
  name: string;
  url: string;
  transport: ExternalMcpTransport;
  toolNamePrefix?: string | null;
  headers: Array<{
    id?: string | null;
    name: string;
    value?: string | null;
  }>;
};

export type McpToolPresetInput = {
  name: string;
  description?: string | null;
  iconKey: string;
  enabledForPlans: boolean;
  enabledForSessions: boolean;
  toolNames?: string[] | null;
  tools?: McpToolReference[] | null;
};

/** Names are upstream names, without an external server's display prefix. */
export type McpToolReference = {
  source: "BUILTIN" | "EXTERNAL";
  name: string;
  serverId?: string | null;
  serverName?: string | null;
};

export type McpToolPresetView = {
  id: string;
  name: string;
  description: string;
  iconKey: string;
  enabledForPlans: boolean;
  enabledForSessions: boolean;
  toolNames: string[];
  tools: McpToolReference[];
  createdAt: string;
  updatedAt: string;
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ToolCatalogItem = {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: ToolAnnotations | null;
  reference?: McpToolReference;
  mcpName?: string;
  available?: boolean;
  availabilityReason?: string | null;
  taskSupport?: "optional" | "required" | "forbidden";
};

export type McpToolSnapshotEntry = ToolCatalogItem & {
  reference: McpToolReference;
  endpointHash?: string;
};

export type McpToolSnapshot = {
  schemaVersion: 1;
  tools: McpToolSnapshotEntry[];
};

export type McpToolDocumentExport = {
  filename: string;
  contentType: string;
  content: string;
};

export type McpToolPresetImportInput = {
  document: string;
  decisions?: Array<{
    index: number;
    action: "CREATE" | "REPLACE" | "SKIP";
    name?: string | null;
    targetId?: string | null;
  }> | null;
  serverMappings?: Array<{ serverKey: string; serverId: string }> | null;
};

export type McpToolPresetImportPreview = {
  token: string;
  canImport: boolean;
  errors: string[];
  entries: Array<{
    index: number;
    name: string;
    action: "CREATE" | "REPLACE" | "SKIP";
    targetId: string | null;
    toolCount: number;
    errors: string[];
    warnings: string[];
  }>;
  externalServers: Array<{
    key: string;
    name: string;
    transport: ExternalMcpTransport | null;
    selectedServerId: string | null;
    suggestedServerId: string | null;
    candidates: ExternalMcpServerView[];
  }>;
};

export type ToolCallAuditView = {
  id: string;
  correlationId: string;
  caller: string;
  source: string;
  groupId: string;
  toolName: string;
  argumentsSha256: string;
  resultStatus: string;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ToolCatalogGroup = {
  id: string;
  name: string;
  source: "BUILTIN" | "EXTERNAL";
  transport: ExternalMcpTransport | null;
  url: string | null;
  error: string | null;
  tools: ToolCatalogItem[];
  children: ToolCatalogGroup[];
};

/** Listing projection: tool schemas are fetched only when a runner opens. */
export type ToolCatalogSummaryGroup = Omit<
  ToolCatalogGroup,
  "tools" | "children"
> & {
  tools: Array<Omit<ToolCatalogItem, "inputSchema" | "outputSchema">>;
  children: ToolCatalogSummaryGroup[];
};
