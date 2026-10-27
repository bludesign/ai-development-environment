export type McpConnection = {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
  firstAuthorizedAt: string;
  authorizationCount: number;
};

export type McpConnectionsResponse = {
  enabled: boolean;
  clients: McpConnection[];
};
