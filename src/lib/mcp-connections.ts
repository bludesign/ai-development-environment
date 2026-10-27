export type McpConnectionAuthorization = {
  authorizedAt: string;
  scopes: string[];
};

export type McpConnection = {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
  firstAuthorizedAt: string;
  authorizationCount: number;
  authorizations: McpConnectionAuthorization[];
};

export type McpConnectionsResponse = {
  enabled: boolean;
  clients: McpConnection[];
};
