import type {
  ExternalMcpServerView,
  ToolCatalogGroup,
} from "@/services/tools/types";

export type { ExternalMcpServerView, ToolCatalogGroup };

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
