import type {
  ExternalMcpServerView,
  ToolCatalogGroup,
  ToolCallAuditView,
} from "@/services/tools/types";

export type { ExternalMcpServerView, ToolCatalogGroup, ToolCallAuditView };

export type ExternalMcpHeaderDraft = {
  id?: string;
  name: string;
  value: string;
  valueConfigured: boolean;
};

export type ExternalMcpServerDraft = {
  name: string;
  url: string;
  transport: "STREAMABLE_HTTP" | "SSE";
  toolNamePrefix: string;
  headers: ExternalMcpHeaderDraft[];
};
