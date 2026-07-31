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
 * local endpoint is returned anyway, and the session retries against it until
 * the control plane comes back.
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

/**
 * The first endpoint other than the active one that answers for this agent, or
 * `undefined` when none does.
 *
 * Failing over tears the session down, which cancels every job it supervises,
 * so the watchdog needs to know the difference between "this address stopped
 * working" and "the control plane is down". Only the first is worth acting on:
 * with nothing else answering there is nowhere better to go, and the running
 * session should be left to reconnect on its own.
 */
export async function findHealthyAlternate(
  config: AgentConfig,
  active: AgentEndpoint,
  signal: AbortSignal,
  probe: EndpointProbe = probeEndpoint,
): Promise<AgentEndpoint | undefined> {
  for (const endpoint of agentEndpoints(config)) {
    if (signal.aborted) break;
    // Compared by address rather than by kind: an agent that lists the same
    // URL twice has no alternate to move to, whatever the entries are called.
    if (endpoint.server === active.server) continue;
    if (await probe(endpoint, config)) return endpoint;
  }
  return undefined;
}
