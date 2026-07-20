import { isIP } from "node:net";

export type ClientIp = {
  address: string;
  source: "CLOUDFLARE" | "FORWARDED" | "REAL_IP";
};

function normalize(value: string | null): string | null {
  if (!value) return null;
  let address = value.trim();
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    if (end > 0) address = address.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(":"));
  }
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  return isIP(address) ? address.toLowerCase() : null;
}

export function resolveClientIp(headers: Headers): ClientIp | null {
  const cloudflare = normalize(headers.get("cf-connecting-ip"));
  if (cloudflare) return { address: cloudflare, source: "CLOUDFLARE" };
  const forwarded = headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => normalize(entry))
    .find((entry): entry is string => Boolean(entry));
  if (forwarded) return { address: forwarded, source: "FORWARDED" };
  const real = normalize(headers.get("x-real-ip"));
  return real ? { address: real, source: "REAL_IP" } : null;
}
