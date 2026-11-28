import "server-only";
import net from "node:net";
import fs from "node:fs";
import { getSetting } from "./settings";

export type Zone = "home" | "away";

/**
 * Set by `docker/gluon-server.cjs` (the production entry point) on every request: the TCP peer's
 * address. Any copy a client sends is removed before Next sees the request.
 */
export const PEER_HEADER = "x-gluon-peer";

const BUILTIN: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"], // CGNAT / Tailscale
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

/** Addresses that can only be one of our own hops (loopback, Docker bridges, the LAN). */
const PRIVATE = (() => {
  const list = new net.BlockList();
  for (const [addr, prefix, type] of BUILTIN) list.addSubnet(addr, prefix, type);
  return list;
})();

/**
 * Cloudflare's edge (https://www.cloudflare.com/ips/, same list the Caddyfile trusts). When a name is
 * proxied, the hop right before Caddy is one of these, never the visitor.
 */
const CDN = (() => {
  const list = new net.BlockList();
  const v4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
  const v6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
  for (const c of v4) list.addSubnet(c.split("/")[0]!, Number(c.split("/")[1]), "ipv4");
  for (const c of v6) list.addSubnet(c.split("/")[0]!, Number(c.split("/")[1]), "ipv6");
  return list;
})();

let cache: { at: number; list: net.BlockList; prefixes: string[] } | null = null;

/** The server's own global IPv6 prefixes (/64). Devices at home share them. */
export function localIpv6Prefixes(): string[] {
  const out = new Set<string>();
  let text = "";
  try {
    text = fs.readFileSync("/proc/1/net/if_inet6", "utf8");
  } catch {
    try {
      text = fs.readFileSync("/proc/net/if_inet6", "utf8");
    } catch {
      return [];
    }
  }
  for (const line of text.trim().split("\n")) {
    const [hex, , , scope, , ifname] = line.trim().split(/\s+/);
    if (!hex || scope !== "00" || !ifname || ifname.startsWith("docker") || ifname.startsWith("br-") || ifname.startsWith("veth")) continue;
    const groups = hex.match(/.{4}/g);
    if (!groups) continue;
    out.add(`${groups.slice(0, 4).join(":")}::`);
  }
  return [...out];
}

function blockList(): net.BlockList {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const list = new net.BlockList();
  for (const [addr, prefix, type] of BUILTIN) list.addSubnet(addr, prefix, type);
  const prefixes = localIpv6Prefixes();
  for (const p of prefixes) {
    try {
      list.addSubnet(p, 64, "ipv6");
    } catch {
      /* ignore malformed */
    }
  }
  for (const cidr of getSetting("homeNetworks")) {
    // Saved before the check was strict enough: never let one make the internet home.
    if (homeRangeProblem(cidr)) continue;
    const [addr, bits] = cidr.split("/");
    const type = net.isIPv6(addr ?? "") ? "ipv6" : net.isIPv4(addr ?? "") ? "ipv4" : null;
    if (!addr || !type) continue;
    try {
      list.addSubnet(addr, Number(bits ?? (type === "ipv4" ? 32 : 128)), type);
    } catch {
      /* ignore */
    }
  }
  cache = { at: Date.now(), list, prefixes };
  return list;
}

const MAPPED_V4 = (() => {
  const l = new net.BlockList();
  l.addSubnet("::ffff:0:0", 96, "ipv6");
  return l;
})();

/**
 * Why a range someone typed can't be a home network, or null. Anything wider than a /8 (IPv4) or /32
 * (IPv6) would make much of the internet "home", and so would an IPv6 range reaching into
 * ::ffff:0:0/96, where every IPv4 address also lives.
 */
export function homeRangeProblem(cidr: string): string | null {
  const [addr = "", bits, ...rest] = cidr.trim().split("/");
  const type = family(addr);
  const max = type === "ipv4" ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!type || rest.length || !(prefix >= 0 && prefix <= max)) return "Use an address range like 192.168.50.0/24";
  const tooWide = "That range is too wide: it would treat much of the internet as home.";
  if (type === "ipv4") return prefix < 8 ? tooWide : null;
  if (prefix < 32) return tooWide;
  const list = new net.BlockList();
  list.addSubnet(addr, prefix, "ipv6");
  if (prefix <= 96 ? list.check("::ffff:0:0", "ipv6") : MAPPED_V4.check(addr, "ipv6") && prefix - 96 < 8) return tooWide;
  return null;
}

export function resetZoneCache() {
  cache = null;
}

/**
 * Containers' own addresses. Apps run in containers on Docker's bridge networks, which sit inside the
 * private ranges above, so without this every container (including one an app store image
 * compromised) would count as home. Each network's gateway is this machine itself and stays home;
 * macvlan and ipvlan networks hand out addresses on the real LAN and are left alone.
 *
 * Of those containers, only proxies may say who they forward for: Gluon's own Caddy container, or
 * one publishing host port 80 or 443. Any other container could write a home address into the
 * header itself.
 */
interface DockerNets {
  at: number;
  list: net.BlockList;
  gateways: Set<string>;
  proxies: Set<string>;
  /** Kept when Docker stops answering, so the proxy Gluon was set up with keeps working. */
  caddy: Set<string>;
}
type DG = typeof globalThis & { __gluonZoneDockerNets?: DockerNets; __gluonZoneDockerBusy?: boolean; __gluonZoneDockerTried?: number };
const dg = globalThis as DG;

const CADDY_NAME = process.env.GLUON_CADDY_CONTAINER ?? process.env.TEND_CADDY_CONTAINER ?? "caddy";
const FRESH_MS = 60_000;
/** An unknown container may be a proxy that just started: ask again soon, but never per request. */
const RETRY_MS = 10_000;

export interface DockerNetworkInfo {
  Driver?: string;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null } | null;
}

export interface DockerContainerInfo {
  Names?: string[];
  Ports?: Array<{ PublicPort?: number }>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }> | null } | null;
}

function addressesOf(c: DockerContainerInfo): string[] {
  return Object.values(c.NetworkSettings?.Networks ?? {}).flatMap((n) => [parseAddr(n.IPAddress), parseAddr(n.GlobalIPv6Address)].filter((a): a is string => !!a));
}

export function noteDockerNetworks(networks: DockerNetworkInfo[], containers: DockerContainerInfo[] = []) {
  const list = new net.BlockList();
  const gateways = new Set<string>();
  for (const n of networks) {
    if (n.Driver !== "bridge" && n.Driver !== "overlay") continue;
    for (const cfg of n.IPAM?.Config ?? []) {
      const [addr, bits] = String(cfg.Subnet ?? "").split("/");
      const type = family(addr ?? "");
      if (!addr || !type || !bits) continue;
      try {
        list.addSubnet(addr, Number(bits), type);
      } catch {
        continue;
      }
      const gw = parseAddr(cfg.Gateway);
      if (gw) gateways.add(gw);
      // Docker's default when a network doesn't say: the first address.
      else if (type === "ipv4") {
        const o = addr.split(".").map(Number);
        gateways.add(`${o[0]}.${o[1]}.${o[2]}.${(o[3] ?? 0) + 1}`);
      }
    }
  }
  const proxies = new Set<string>();
  const caddy = new Set<string>();
  for (const c of containers) {
    const isCaddy = (c.Names ?? []).some((n) => n.replace(/^\//, "") === CADDY_NAME);
    const edge = (c.Ports ?? []).some((p) => p.PublicPort === 80 || p.PublicPort === 443);
    if (!isCaddy && !edge) continue;
    for (const a of addressesOf(c)) {
      proxies.add(a);
      if (isCaddy) caddy.add(a);
    }
  }
  dg.__gluonZoneDockerNets = { at: Date.now(), list, gateways, proxies, caddy };
}

/** In the background, never on a request's path; the answer is used from then on. */
export async function refreshDockerNetworks(): Promise<void> {
  if (dg.__gluonZoneDockerBusy) return;
  dg.__gluonZoneDockerBusy = true;
  dg.__gluonZoneDockerTried = Date.now();
  try {
    const { docker } = await import("./docker/client");
    const d = docker();
    const [networks, containers] = await Promise.all([d.listNetworks(), d.listContainers()]);
    noteDockerNetworks(networks as DockerNetworkInfo[], containers as DockerContainerInfo[]);
  } catch {
    // Docker unreachable: keep the networks known before, and trust only the Caddy seen last.
    const d = dg.__gluonZoneDockerNets;
    if (d) dg.__gluonZoneDockerNets = { ...d, proxies: new Set(d.caddy) };
  } finally {
    dg.__gluonZoneDockerBusy = false;
  }
}

function dockerNets(): DockerNets | undefined {
  const d = dg.__gluonZoneDockerNets;
  if (!d || Date.now() - d.at > FRESH_MS) refreshSoon();
  return d;
}

function refreshSoon() {
  if (Date.now() - (dg.__gluonZoneDockerTried ?? 0) >= RETRY_MS) void refreshDockerNetworks();
}

function isContainer(a: string): boolean {
  const d = dockerNets();
  if (!d || d.gateways.has(a)) return false;
  return d.list.check(a, family(a)!);
}

/**
 * Whether a private peer may say who it forwards for: this machine itself, another machine on the
 * LAN, or a proxy container. Without anything from Docker yet, only this machine may.
 */
function forwarderTrusted(peer: string): boolean {
  if (LOOPBACK.check(peer, family(peer)!)) return true;
  const d = dockerNets();
  if (!d) return false;
  if (d.gateways.has(peer)) return true;
  if (!d.list.check(peer, family(peer)!)) return true;
  if (d.proxies.has(peer)) return true;
  refreshSoon();
  return false;
}

const LOOPBACK = (() => {
  const l = new net.BlockList();
  l.addSubnet("127.0.0.0", 8, "ipv4");
  l.addAddress("::1", "ipv6");
  return l;
})();

const family = (a: string) => (net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null);

/** "1.2.3.4", "1.2.3.4:5678", "[::1]:80", "::ffff:1.2.3.4" → a bare, valid address, or null. */
export function parseAddr(raw: string | null | undefined): string | null {
  let a = (raw ?? "").trim();
  if (!a || a.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracket) a = bracket[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  if (a.toLowerCase().startsWith("::ffff:") && net.isIPv4(a.slice(7))) a = a.slice(7);
  // IPv4-mapped in hex form (what the URL parser produces): ::ffff:7f00:1 → 127.0.0.1
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const zoneIdx = a.indexOf("%");
  if (zoneIdx > 0) a = a.slice(0, zoneIdx);
  return family(a) ? a : null;
}

export function isHomeIp(ip: string): boolean {
  const addr = parseAddr(ip);
  const type = addr ? family(addr) : null;
  if (!addr || !type) return false;
  return blockList().check(addr, type);
}

const isPrivate = (a: string) => PRIVATE.check(a, family(a)!);
const isCdn = (a: string) => CDN.check(a, family(a)!);

/**
 * Each proxy appends on the right, so only the right end is trustworthy: walk past our own private
 * hops, then at most one Cloudflare edge hop, and the next entry is the visitor. Anything the visitor
 * wrote sits further left and is never read; a malformed entry at that position means the chain was
 * forged.
 */
function fromChain(xff: string): string | null | "invalid" {
  const chain = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chain.length) return null;
  let i = chain.length - 1;
  const at = (k: number) => parseAddr(chain[k]);
  while (i > 0) {
    const a = at(i);
    if (!a) return "invalid";
    if (!isPrivate(a)) break;
    i--;
  }
  if (i > 0) {
    const a = at(i);
    if (a && isCdn(a)) i--;
  }
  return at(i) ?? "invalid";
}

/**
 * In production `docker/gluon-server.cjs` stamps the TCP peer and drops forwarding headers that
 * didn't come from a private hop. A peer outside the home network is the client, full stop, and so is
 * a container that isn't a proxy (see forwarderTrusted). Other private peers may say who they forward
 * for. Without the peer stamp in production, fail closed: away.
 */
export function clientInfo(headers: Headers): { ip: string; zone: Zone } {
  const stamped = parseAddr(headers.get(PEER_HEADER));
  if (!stamped && (process.env.GLUON_PEER_HEADER ?? process.env.TEND_PEER_HEADER) === "1") return { ip: "unknown", zone: "away" };

  let ip: string | null;
  if (stamped && ((!isPrivate(stamped) && !isHomeIp(stamped)) || !forwarderTrusted(stamped))) {
    ip = stamped;
  } else {
    // Next itself fills X-Forwarded-For with the socket address when no proxy sent one.
    const fromXff = fromChain(headers.get("x-forwarded-for") ?? "");
    if (fromXff === "invalid") return { ip: "unknown", zone: "away" };
    ip = fromXff ?? stamped;
  }
  if (!ip) {
    // Development without a peer stamp and no forwarding header at all: a direct local connection,
    // unless it claims the public hostname (which only Caddy serves).
    const host = (headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    const viaPublicName = !!host && host === getSetting("publicHost").toLowerCase();
    return { ip: "unknown", zone: viaPublicName ? "away" : "home" };
  }
  const home = isHomeIp(ip) && !isContainer(parseAddr(ip) ?? ip);
  // A visit that crossed Cloudflare's network came from the internet, whatever the chain says. Through
  // a Cloudflare Tunnel the last hop is cloudflared on this machine, so a chain that lost the visitor's
  // address would otherwise end at loopback and read as home. These headers can only make a request
  // count as away, so trusting them grants nothing.
  if (home && (headers.has("cf-ray") || headers.has("cf-connecting-ip"))) return { ip: parseAddr(headers.get("cf-connecting-ip")) ?? ip, zone: "away" };
  return { ip, zone: home ? "home" : "away" };
}

/** `X-Forwarded-Proto` only survives from private hops (Caddy); Next fills it from the socket otherwise. */
export function isHttpsRequest(headers: Headers): boolean {
  return (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() === "https";
}
