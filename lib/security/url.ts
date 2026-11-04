import { BlockList, isIP } from "node:net";
import { AppError } from "@/lib/errors";

/**
 * URL and address policy for every server-side request to customer websites.
 * Blocks loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 * CGNAT, multicast, documentation/benchmark ranges and IPv6 equivalents.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ["2001:db8::", 32], ["100::", 64], ["2001::", 23],
] as const) blocked.addSubnet(net, prefix, "ipv6");

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i, /^metadata$/i];

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped / NAT64 forms: evaluate the embedded IPv4 address.
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
      return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP: treat as unsafe in this context
}

export type TargetPolicy = { allowPrivate: boolean };

/** Validates a URL for an outbound request. Throws AppError("UNSAFE_URL") with a readable reason. */
export function assertSafeTarget(input: string | URL, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError("UNSAFE_URL", "The URL is not valid.");
  }
  if (url.protocol !== "https:" && !(policy.allowPrivate && url.protocol === "http:")) {
    throw new AppError("UNSAFE_URL", "Only HTTPS URLs are allowed.");
  }
  if (url.username || url.password) throw new AppError("UNSAFE_URL", "URLs must not contain embedded credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new AppError("UNSAFE_URL", "The URL has no host.");
  if (!policy.allowPrivate) {
    if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) throw new AppError("UNSAFE_URL", "Internal hostnames are not allowed.");
    if (isIP(host) && isPrivateAddress(host)) throw new AppError("UNSAFE_URL", "Private or reserved IP addresses are not allowed.");
    if (url.port && url.port !== "443" && url.port !== "80") throw new AppError("UNSAFE_URL", "Non-standard ports are not allowed.");
  }
  return url;
}

/**
 * Normalizes a website base URL entered by a user: https required (unless dev private
 * targets are enabled), no credentials, query or fragment; no trailing slash.
 */
export function normalizeWebsiteUrl(input: string, policy: TargetPolicy): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = assertSafeTarget(withScheme, policy);
  if (url.search || url.hash) throw new AppError("UNSAFE_URL", "Enter the site address without query strings or fragments.");
  url.hostname = url.hostname.toLowerCase();
  return url.toString().replace(/\/+$/, "");
}

export function isDevelopmentTarget(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return BLOCKED_HOSTNAMES.some((re) => re.test(host)) || (isIP(host) !== 0 && isPrivateAddress(host));
  } catch {
    return false;
  }
}
