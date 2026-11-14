// Which directly-connected peers may set X-Forwarded-For (Fastify `trustProxy`, evaluated by proxy-addr).
// Default: loopback + private ranges only (host Nginx reaches the container via the Docker bridge, Caddy via the
// compose network). A public peer talking to the app directly gets its socket address as req.ip, so it cannot
// spoof its way past the per-IP login/join rate limits.

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

/**
 * TRUST_PROXY env:
 *   unset/empty      → DEFAULT_TRUSTED_PROXIES
 *   "false" / "off"  → never trust X-Forwarded-For
 *   "true"           → trust every peer (only if the app is unreachable except through a proxy)
 *   "<n>"            → trust n hops
 *   "a,b/cidr,..."   → explicit list of addresses / CIDRs (proxy-addr syntax)
 */
export type TrustProxy = boolean | string[] | ((addr: string, hop: number) => boolean);

export function trustProxyFromEnv(raw: string | undefined = process.env.TRUST_PROXY): TrustProxy {
  const v = (raw ?? '').trim();
  if (!v) return [...DEFAULT_TRUSTED_PROXIES];
  if (/^(false|off|no|none)$/i.test(v)) return false;
  if (/^(true|all)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) { const hops = Number(v); return (_addr: string, hop: number) => hop < hops; }
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}
