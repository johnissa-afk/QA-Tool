/** Conservative guard against accidentally scanning a local service. */
const privateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || privateIpv4(host)
    || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

/** Validates an HTTP(S) target before browser or link-check network traffic starts. */
export function assertSafeScanTarget(rawUrl: string, allowPrivateNetwork = false): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Scan targets must use http:// or https://.");
  if (!allowPrivateNetwork && isPrivateNetworkHost(url.hostname)) {
    throw new Error(`Refusing private-network target ${url.hostname}. Use --allow-private-network only for an intentional local or internal scan.`);
  }
  return url;
}
