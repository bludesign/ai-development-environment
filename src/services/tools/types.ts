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

export type ToolCatalogItem = {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
};

export type ToolCatalogGroup = {
  id: string;
  name: string;
  source: "BUILTIN" | "EXTERNAL";
  transport: ExternalMcpTransport | null;
  url: string | null;
  error: string | null;
  tools: ToolCatalogItem[];
};
