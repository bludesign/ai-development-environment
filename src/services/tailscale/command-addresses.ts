import "server-only";

import {
  parseTailscaleServeRoute,
  type TailscaleServeRoute,
} from "@ai-development-environment/agent-contract/tailscale";

import { getPrismaClient } from "@/data/prisma-client";
import {
  tailscaleListenerAddresses,
  type TailscaleAddress,
} from "@/lib/tailscale-addresses";

function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addresses(value: string) {
  return parseArray(value).filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function parseRoute(value: unknown): TailscaleServeRoute[] {
  try {
    return [parseTailscaleServeRoute(value)];
  } catch {
    return [];
  }
}

export async function loadCommandTailscaleAddressesByAgent(agentIds: string[]) {
  const byAgent = new Map<string, Map<number, TailscaleAddress[]>>();
  if (!agentIds.length) return byAgent;

  const prisma = await getPrismaClient();
  const states = await prisma.tailscaleAgentState.findMany({
    where: { agentId: { in: [...new Set(agentIds)] } },
    select: {
      agentId: true,
      dnsHostname: true,
      ipv4Json: true,
      ipv6Json: true,
      routesJson: true,
    },
  });
  for (const state of states) {
    const identity = {
      dnsHostname: state.dnsHostname,
      ipv4: addresses(state.ipv4Json),
      ipv6: addresses(state.ipv6Json),
    };
    const byPort = new Map<number, Map<string, TailscaleAddress>>();
    for (const route of parseArray(state.routesJson).flatMap(parseRoute)) {
      const links = byPort.get(route.destination.port) ?? new Map();
      for (const { kind, url } of tailscaleListenerAddresses(route, identity)) {
        links.set(url, { kind, url });
      }
      byPort.set(route.destination.port, links);
    }
    byAgent.set(
      state.agentId,
      new Map([...byPort].map(([port, links]) => [port, [...links.values()]])),
    );
  }
  return byAgent;
}

export async function loadCommandTailscaleAddresses(
  agentId: string | null,
  port: number | null,
) {
  if (!agentId || port == null) return [];
  const byAgent = await loadCommandTailscaleAddressesByAgent([agentId]);
  return byAgent.get(agentId)?.get(port) ?? [];
}
