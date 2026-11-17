import type { TailscaleServeRoute } from "@ai-development-environment/agent-contract/tailscale";

export type TailscaleAddress = {
  kind: "DNS" | "IPv4" | "IPv6";
  url: string;
};

type Listener = Pick<
  TailscaleServeRoute,
  "protocol" | "listenPort" | "mountPath"
>;

export function tailscaleListenerAddresses(
  route: Listener,
  identity: { dnsHostname: string | null; ipv4: string[]; ipv6: string[] },
): Array<TailscaleAddress & { address: string }> {
  const scheme =
    route.protocol === "HTTP"
      ? "http"
      : route.protocol === "TCP"
        ? "tcp"
        : "https";
  const defaultPort =
    (scheme === "http" && route.listenPort === 80) ||
    (scheme === "https" && route.listenPort === 443);
  const path =
    route.protocol === "HTTP" || route.protocol === "HTTPS"
      ? route.mountPath
      : "";
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
      url: `${scheme}://${host}${defaultPort ? "" : `:${route.listenPort}`}${path}`,
    };
  });
}
