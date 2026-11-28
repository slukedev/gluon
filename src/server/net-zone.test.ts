import { describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ homeNetworks: [] as string[] }));
vi.mock("./settings", () => ({ getSetting: (k: string) => (k === "homeNetworks" ? saved.homeNetworks : "") }));
const dockerApi = vi.hoisted(() => ({ down: false, containers: [] as unknown[], networks: [] as unknown[] }));
vi.mock("./docker/client", () => ({
  docker: () => ({
    listNetworks: async () => {
      if (dockerApi.down) throw new Error("connect ENOENT /var/run/docker.sock");
      return dockerApi.networks;
    },
    listContainers: async () => {
      if (dockerApi.down) throw new Error("connect ENOENT /var/run/docker.sock");
      return dockerApi.containers;
    },
  }),
}));
const { clientInfo, homeRangeProblem, isHomeIp, noteDockerNetworks, PEER_HEADER, refreshDockerNetworks, resetZoneCache } = await import("./net-zone");

const h = (o: Record<string, string>) => new Headers(o);

const NETWORKS = [
  { Driver: "bridge", IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] } },
  { Driver: "bridge", IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } },
  // A macvlan network hands out addresses on the real LAN, so it says nothing about who's a container.
  { Driver: "macvlan", IPAM: { Config: [{ Subnet: "192.168.1.0/24", Gateway: "192.168.1.1" }] } },
];
const on = (ip: string) => ({ NetworkSettings: { Networks: { proxy: { IPAddress: ip } } } });
const CONTAINERS = [
  { Names: ["/caddy"], Ports: [], ...on("172.18.0.5") },
  { Names: ["/edge"], Ports: [{ PrivatePort: 443, PublicPort: 443 }], ...on("172.18.0.7") },
  { Names: ["/jellyfin"], Ports: [{ PrivatePort: 8096, PublicPort: 8096 }], ...on("172.18.0.9") },
  { Names: ["/cloudflared"], Ports: [], ...on("172.17.0.2") },
];
// What Docker answers when asked again in the background.
dockerApi.networks = NETWORKS;
dockerApi.containers = CONTAINERS;
const knownDocker = () => {
  dockerApi.containers = CONTAINERS;
  noteDockerNetworks(NETWORKS, CONTAINERS);
};
knownDocker();

describe("clientInfo through Cloudflare", () => {
  it("a tunnel visit whose chain ends at loopback is away, never home", () => {
    const info = clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "127.0.0.1", "cf-ray": "8a1b-LHR", "cf-connecting-ip": "198.51.100.20" }));
    expect(info).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("reads the visitor from the chain when Caddy passes on a tunnel visit", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "198.51.100.20, 127.0.0.1", "cf-ray": "x" }))).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("someone at home without Cloudflare in the way stays home", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
  });
});

describe("clientInfo and forged forwarding headers", () => {
  it("a peer on the internet is the client, whatever it says it forwards for", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "203.0.113.7", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "203.0.113.7", zone: "away" });
  });

  it("behind our proxy, only the right end of the chain counts", () => {
    // The visitor typed a home address themselves; Caddy appended who really connected.
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30, 203.0.113.7" }))).toEqual({ ip: "203.0.113.7", zone: "away" });
  });

  it("steps past one Cloudflare edge hop to the visitor, and no further", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "10.0.0.9, 198.51.100.20, 162.158.1.1" }))).toEqual({ ip: "198.51.100.20", zone: "away" });
  });

  it("a garbled entry where the visitor should be reads as unknown and away", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "198.51.100.20, not-an-address" }))).toEqual({ ip: "unknown", zone: "away" });
  });

  it("without the peer stamp in production, nobody is home", () => {
    process.env.GLUON_PEER_HEADER = "1";
    try {
      expect(clientInfo(h({ "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "unknown", zone: "away" });
    } finally {
      delete process.env.GLUON_PEER_HEADER;
    }
  });
});

describe("clientInfo and containers on this machine", () => {
  it("a container calling Gluon directly is away", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.9", "x-forwarded-for": "172.18.0.9" }))).toEqual({ ip: "172.18.0.9", zone: "away" });
  });

  it("an app container that writes a home address into the header is judged by its own address", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.9", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "172.18.0.9", zone: "away" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.9", "x-forwarded-for": "127.0.0.1" }))).toEqual({ ip: "172.18.0.9", zone: "away" });
    // Publishing some other port doesn't make it a proxy; neither does forwarding for Cloudflare.
    expect(clientInfo(h({ [PEER_HEADER]: "172.17.0.2", "x-forwarded-for": "192.168.1.30", "cf-connecting-ip": "192.168.1.30" }))).toEqual({ ip: "172.17.0.2", zone: "away" });
  });

  it("a container going through Caddy is away too", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "172.17.0.4" }))).toEqual({ ip: "172.17.0.4", zone: "away" });
  });

  it("Caddy, or a container publishing port 443, passing on someone at home keeps them home, as does this machine via a network's gateway", () => {
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.7", "x-forwarded-for": "192.168.1.31" }))).toEqual({ ip: "192.168.1.31", zone: "home" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "172.18.0.1" }))).toEqual({ ip: "172.18.0.1", zone: "home" });
    expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.1", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
  });

  it("when Docker stops answering, keeps trusting the Caddy it knew and nothing else", async () => {
    dockerApi.down = true;
    try {
      await refreshDockerNetworks();
      await vi.waitFor(() => expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.7", "x-forwarded-for": "192.168.1.31" }))).toEqual({ ip: "172.18.0.7", zone: "away" }));
      expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" });
      expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.9", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "172.18.0.9", zone: "away" });
    } finally {
      dockerApi.down = false;
      knownDocker();
    }
  });

  it("believes no forwarding header from a private peer before Docker has ever answered, except this machine's", async () => {
    dockerApi.down = true;
    const g = globalThis as { __gluonZoneDockerNets?: unknown };
    const before = g.__gluonZoneDockerNets;
    delete g.__gluonZoneDockerNets;
    try {
      expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "203.0.113.7" })).ip).toBe("172.18.0.5");
      expect(clientInfo(h({ [PEER_HEADER]: "127.0.0.1", "x-forwarded-for": "203.0.113.7" }))).toEqual({ ip: "203.0.113.7", zone: "away" });
    } finally {
      g.__gluonZoneDockerNets = before;
      dockerApi.down = false;
      knownDocker();
    }
  });

  it("picks up a proxy from Docker in the background", async () => {
    dockerApi.containers = [{ Names: ["/traefik"], Ports: [{ PublicPort: 80 }], ...on("172.18.0.20") }];
    try {
      expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.20", "x-forwarded-for": "192.168.1.30" })).zone).toBe("away");
      await refreshDockerNetworks();
      await vi.waitFor(() => expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.20", "x-forwarded-for": "192.168.1.30" }))).toEqual({ ip: "192.168.1.30", zone: "home" }));
      expect(clientInfo(h({ [PEER_HEADER]: "172.18.0.5", "x-forwarded-for": "192.168.1.30" })).ip).toBe("172.18.0.5");
    } finally {
      knownDocker();
    }
  });
});

describe("home network ranges", () => {
  it.each(["192.168.50.0/24", "10.0.0.0/8", "203.0.113.9", "2001:db8:1::/48", "fd00::/32", "::ffff:192.168.1.0/120"])("accepts %s", (cidr) => {
    expect(homeRangeProblem(cidr)).toBeNull();
  });

  it.each(["0.0.0.0/0", "100.0.0.0/7", "::/0", "2000::/3", "::/32", "::ffff:0:0/96", "::ffff:0:0/100", "::ffff:808:0/103"])("refuses %s as too wide", (cidr) => {
    expect(homeRangeProblem(cidr)).toMatch(/too wide/);
  });

  it.each(["", "home", "192.168.1.0/33", "192.168.1.0/", "192.168.1.0/2x", "10.0.0.0/8/9", "::1/129"])("refuses %j as malformed", (cidr) => {
    expect(homeRangeProblem(cidr)).toMatch(/address range/);
  });

  it("ignores a too-wide range saved before the check, so the internet never counts as home", () => {
    saved.homeNetworks = ["::/32", "198.51.100.0/24"];
    resetZoneCache();
    try {
      expect(isHomeIp("8.8.8.8")).toBe(false);
      expect(isHomeIp("198.51.100.20")).toBe(true);
    } finally {
      saved.homeNetworks = [];
      resetZoneCache();
    }
  });
});
