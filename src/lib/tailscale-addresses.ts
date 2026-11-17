import type { TailscaleServeRoute } from "@ai-development-environment/agent-contract/tailscale";

export type TailscaleAddress = {
  kind: "DNS" | "IPv4" | "IPv6";
  protocol: TailscaleServeRoute["protocol"];
  endpoint: string;
  url: string | null;
};

type Listener = Pick<
  TailscaleServeRoute,
  "protocol" | "listenPort" | "mountPath"
>;

export function tailscaleListenerAddresses(
  route: Listener,
  identity: { dnsHostname: string | null; ipv4: string[]; ipv6: string[] },
): Array<TailscaleAddress & { address: string }> {
  const { protocol, listenPort, mountPath } = route;
  const isWeb = protocol === "HTTP" || protocol === "HTTPS";
  const defaultPort =
    (protocol === "HTTP" && listenPort === 80) ||
    (protocol === "HTTPS" && listenPort === 443);
  const addresses: Array<{ kind: TailscaleAddress["kind"]; address: string }> =
    [
      ...(identity.dnsHostname
        ? [{ kind: "DNS" as const, address: identity.dnsHostname }]
        : []),
      ...identity.ipv4.map((address) => ({ kind: "IPv4" as const, address })),
      ...identity.ipv6.map((address) => ({ kind: "IPv6" as const, address })),
    ];
  return addresses.map(({ kind, address }) => {
    const host = address.includes(":") ? `[${address}]` : address;
    return {
      kind,
      address,
      protocol,
      endpoint: `${host}:${listenPort}`,
      url: isWeb
        ? `${protocol.toLowerCase()}://${host}${defaultPort ? "" : `:${listenPort}`}${mountPath}`
        : null,
    };
  });
}
