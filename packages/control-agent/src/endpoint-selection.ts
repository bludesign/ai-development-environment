import {
  agentEndpoints,
  type AgentConfig,
  type AgentEndpoint,
} from "./config.js";
import { AgentGraphQLClient } from "./graphql-client.js";

const PROBE_TIMEOUT_MS = 5_000;

export type EndpointProbe = (
  endpoint: AgentEndpoint,
  config: AgentConfig,
) => Promise<boolean>;

/**
 * A reachable address is not enough: the credential has to belong to the agent
 * on the other end, otherwise a different control plane answering on the same
 * address would silently take the agent over.
 */
export const probeEndpoint: EndpointProbe = async (endpoint, config) => {
  try {
    const response = await new AgentGraphQLClient(
      endpoint.server,
      config.credential,
      PROBE_TIMEOUT_MS,
      config.headers,
    ).self();
    return response.agentSelf?.id === config.agentId;
  } catch {
    return false;
  }
};

/**
 * Picks the first endpoint that answers for this agent. When none does the
 * local endpoint is returned anyway — the session retries on its own, and the
 * heartbeat watchdog asks for a fresh selection once it gives up on it.
 */
export async function selectAgentEndpoint(
  config: AgentConfig,
  signal: AbortSignal,
  probe: EndpointProbe = probeEndpoint,
): Promise<AgentEndpoint> {
  const endpoints = agentEndpoints(config);
  if (endpoints.length === 1) return endpoints[0];
  for (const endpoint of endpoints) {
    if (signal.aborted) break;
    if (await probe(endpoint, config)) return endpoint;
  }
  return endpoints[0];
}
