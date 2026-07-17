import "server-only";

import { networkInterfaces } from "node:os";

type ServerNetworkAddress = {
  address: string;
  family: string;
  internal: boolean;
};

type ServerNetworkInterfaces = Record<
  string,
  readonly (ServerNetworkAddress | undefined)[] | undefined
>;

const DEFAULT_NEXT_SERVER_PORT = 3000;

export function buildEnrollmentServerOrigins(
  interfaces: ServerNetworkInterfaces,
  port: number,
): string[] {
  const origins = new Set<string>();

  for (const addresses of Object.values(interfaces)) {
    for (const network of addresses ?? []) {
      if (!network || network.internal) continue;

      if (network.family === "IPv4") {
        origins.add(`http://${network.address}:${port}`);
      } else if (
        network.family === "IPv6" &&
        !network.address.toLowerCase().startsWith("fe80:")
      ) {
        origins.add(`http://[${network.address}]:${port}`);
      }
    }
  }

  return [...origins];
}

export function getEnrollmentServerOrigins(): string[] {
  const configuredPort = Number(process.env.PORT ?? DEFAULT_NEXT_SERVER_PORT);
  const port =
    Number.isInteger(configuredPort) &&
    configuredPort > 0 &&
    configuredPort <= 65_535
      ? configuredPort
      : DEFAULT_NEXT_SERVER_PORT;

  return buildEnrollmentServerOrigins(networkInterfaces(), port);
}
