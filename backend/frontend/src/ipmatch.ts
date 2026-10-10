/** IPv4 / IPv6 address and CIDR matching, shared by the search bar (kql.ts)
 *  and the known-good mute list (knownGood.ts). Pure functions, no DOM.
 *
 *  Addresses are held as BigInt so one code path handles both families.
 *  An IPv4-mapped IPv6 address (::ffff:10.0.0.5) is treated as the IPv4
 *  address it carries, since that is how dual-stack sockets often log it. */

export interface Ip {
  v: 4 | 6;
  n: bigint;
}

export interface IpNet extends Ip {
  /** Prefix length: 0-32 for IPv4, 0-128 for IPv6. */
  prefix: number;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":") || s.includes(":::")) return null;

  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): string[] | null => {
    if (h === "") return [];
    const g = h.split(":");
    return g.every((x) => /^[0-9a-fA-F]{1,4}$/.test(x)) ? g : null;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g, 16));
  return n;
}

export function parseIp(raw: string): Ip | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes(":")) {
    const n = parseV6(s);
    if (n === null) return null;
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn }; // IPv4-mapped
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

/** "10.0.0.5", "10.0.0.0/24", "2001:db8::/32". A bare address is a single-host network. */
export function parseNet(raw: string): IpNet | null {
  const s = raw.trim();
  const slash = s.indexOf("/");
  const addr = parseIp(slash >= 0 ? s.slice(0, slash) : s);
  if (!addr) return null;
  const max = addr.v === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > max) return null;
  }
  return { ...addr, prefix };
}

export function inNet(ip: Ip, net: IpNet): boolean {
  if (ip.v !== net.v) return false;
  const shift = BigInt((net.v === 4 ? 32 : 128) - net.prefix);
  return ip.n >> shift === net.n >> shift;
}

// Event addresses repeat constantly; parse each distinct one once.
const cache = new Map<string, Ip | null>();
const MAX_CACHE = 5_000;

export function parseIpCached(raw: string): Ip | null {
  let hit = cache.get(raw);
  if (hit === undefined) {
    if (cache.size >= MAX_CACHE) cache.clear();
    hit = parseIp(raw);
    cache.set(raw, hit);
  }
  return hit;
}

/** True if `ip` (as text) lies in `net`. Unparseable addresses never match. */
export function ipInNet(ip: string | null | undefined, net: IpNet): boolean {
  if (!ip) return false;
  const parsed = parseIpCached(ip);
  return parsed !== null && inNet(parsed, net);
}
