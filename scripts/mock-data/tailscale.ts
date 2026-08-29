import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { minutesAgo } from "./time";

const webRoute = {
  protocol: "HTTPS",
  listenPort: 443,
  mountPath: "/dashboard",
  destination: { protocol: "HTTP", port: 3000, path: "" },
  funnel: false,
  appCapabilities: ["acme.example/dashboard"],
  proxyProtocol: "NONE",
};

const tcpRoute = {
  protocol: "TCP",
  listenPort: 5432,
  mountPath: "/",
  destination: { protocol: "TCP", port: 5432, path: "" },
  funnel: false,
  appCapabilities: [],
  proxyProtocol: "V2",
};

export async function seedTailscale(prisma: PrismaClient): Promise<void> {
  const identities = [
    [
      ids.agents.studio,
      "studio.acme-tailnet.ts.net",
      "100.91.0.12",
      "fd7a:115c:a1e0::12",
      [webRoute],
    ],
    [
      ids.agents.build,
      "build.acme-tailnet.ts.net",
      "100.91.0.24",
      "fd7a:115c:a1e0::24",
      [webRoute, tcpRoute],
    ],
    [
      ids.agents.ci,
      "ci.acme-tailnet.ts.net",
      "100.91.0.31",
      "fd7a:115c:a1e0::31",
      [],
    ],
  ] as const;
  for (const [agentId, dnsHostname, ipv4, ipv6, routes] of identities) {
    await prisma.tailscaleAgentState.create({
      data: {
        agentId,
        dnsHostname,
        ipv4Json: JSON.stringify([ipv4]),
        ipv6Json: JSON.stringify([ipv6]),
        backendState: agentId === ids.agents.ci ? "Stopped" : "Running",
        routesJson: JSON.stringify(routes),
        lastInspectedAt: minutesAgo(agentId === ids.agents.studio ? 2 : 5),
        lastError:
          agentId === ids.agents.ci
            ? "Upgrade the control agent to manage Tailscale Serve"
            : null,
      },
    });
  }

  await prisma.tailscaleServeTemplate.create({
    data: {
      id: ids.tailscaleTemplates.dashboard,
      name: "Developer dashboard",
      protocol: webRoute.protocol,
      listenPort: webRoute.listenPort,
      mountPath: webRoute.mountPath,
      destinationProtocol: webRoute.destination.protocol,
      destinationPort: webRoute.destination.port,
      destinationPath: webRoute.destination.path,
      funnel: webRoute.funnel,
      appCapabilitiesJson: JSON.stringify(webRoute.appCapabilities),
      proxyProtocol: webRoute.proxyProtocol,
      fingerprint: "mock-tailscale-dashboard-fingerprint",
      revision: 3,
      origin: "USER",
      assignments: {
        create: [
          {
            agentId: ids.agents.studio,
            desiredEnabled: true,
            observedEnabled: true,
            observedFingerprint: "mock-tailscale-dashboard-fingerprint",
            revision: 3,
            status: "SUCCEEDED",
            lastObservedAt: minutesAgo(2),
          },
          {
            agentId: ids.agents.build,
            desiredEnabled: true,
            observedEnabled: true,
            observedFingerprint: "mock-tailscale-dashboard-fingerprint",
            revision: 3,
            status: "SUCCEEDED",
            lastObservedAt: minutesAgo(5),
          },
          {
            agentId: ids.agents.ci,
            desiredEnabled: false,
            observedEnabled: false,
            revision: 3,
            status: "UNSUPPORTED",
            lastError: "This agent does not advertise Tailscale Serve support",
            lastObservedAt: minutesAgo(5),
          },
        ],
      },
    },
  });

  await prisma.tailscaleServeTemplate.create({
    data: {
      id: ids.tailscaleTemplates.postgres,
      name: "Imported TCP 5432",
      protocol: tcpRoute.protocol,
      listenPort: tcpRoute.listenPort,
      mountPath: tcpRoute.mountPath,
      destinationProtocol: tcpRoute.destination.protocol,
      destinationPort: tcpRoute.destination.port,
      destinationPath: tcpRoute.destination.path,
      funnel: false,
      appCapabilitiesJson: "[]",
      proxyProtocol: tcpRoute.proxyProtocol,
      fingerprint: "mock-tailscale-postgres-fingerprint",
      origin: "IMPORTED",
      assignments: {
        create: {
          agentId: ids.agents.build,
          desiredEnabled: true,
          observedEnabled: true,
          observedFingerprint: "mock-tailscale-postgres-fingerprint",
          status: "SUCCEEDED",
          lastObservedAt: minutesAgo(5),
        },
      },
    },
  });

  // TailscaleServePage inspects the fleet when it appears. Every Playwright project shares
  // one mock database, so four independent page loads would otherwise enqueue jobs while the
  // Polling screenshots are being captured. The route pins randomUUID to this request id and
  // reuses the completed operation instead.
  await prisma.tailscaleServeOperation.create({
    data: {
      id: ids.tailscaleOperations.capturedInspection,
      kind: "INSPECT",
      status: "PARTIAL_FAILED",
      requestId: ids.tailscaleOperations.capturedInspection,
      createdAt: minutesAgo(2),
      finishedAt: minutesAgo(2),
      agents: {
        create: [
          { agentId: ids.agents.studio, status: "SUCCEEDED" },
          { agentId: ids.agents.build, status: "SUCCEEDED" },
          {
            agentId: ids.agents.ci,
            status: "UNSUPPORTED",
            error: "This agent does not advertise Tailscale Serve support",
          },
        ],
      },
    },
  });
}
