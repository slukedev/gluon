// Production entry point: stamps the real TCP peer on every request, then starts Next's standalone
// server (./server.js) unchanged.
//
// Gluon decides "at home" vs "away" from the visitor's address, and that decision gates admin
// sign-in. X-Forwarded-For is only meaningful when it was written by our own proxy (Caddy, on a
// Docker network): anyone else can type whatever they like into it. So for every request:
//   - any `x-gluon-peer` the client sent is dropped, and the socket's remote address is written in;
//   - if the peer is not a private address (loopback, Docker bridge, LAN, Tailscale), every
//     forwarding header is dropped too, so Next falls back to the socket for XFF/proto/host.
// The zone logic itself (reading the right end of the XFF chain) lives in src/server/net-zone.ts.
//
// It also sizes libuv's thread pool and bounds shutdown; see below.
"use strict";
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");

// File I/O, DNS lookups, zlib, crypto, argon2 and sharp all share libuv's pool (4 threads by default).
// Thumbnails alone can fill four, and then every stat and readFile waits behind them. libuv reads this
// when the pool is first used, which is after this point.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(64, Math.max(8, os.availableParallelism() * 2)));
}

const PEER = "x-gluon-peer";
const FORWARDING = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip"];

const privateHops = new net.BlockList();
for (const [addr, prefix, type] of [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
]) {
  privateHops.addSubnet(addr, prefix, type);
}

function bare(addr) {
  if (!addr) return "";
  let a = String(addr);
  if (a.toLowerCase().startsWith("::ffff:") && net.isIPv4(a.slice(7))) a = a.slice(7);
  const pct = a.indexOf("%");
  if (pct > 0) a = a.slice(0, pct);
  return a;
}

function isPrivate(a) {
  const type = net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null;
  return !!type && privateHops.check(a, type);
}

function stamp(req) {
  const headers = req.headers; // Node caches this object; Next reads the same one.
  delete headers[PEER];
  const peer = bare(req.socket && req.socket.remoteAddress);
  if (!peer || !isPrivate(peer)) {
    for (const h of FORWARDING) delete headers[h];
  }
  if (peer) headers[PEER] = peer;
}

const servers = new Set();
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function gluonStampedEmit(event, req, ...rest) {
  if (event === "listening") servers.add(this);
  if ((event === "request" || event === "upgrade" || event === "checkContinue" || event === "checkExpectation") && req && req.headers) {
    try {
      stamp(req);
    } catch {
      // Never let stamping take the server down; net-zone treats a missing stamp as "away".
      try {
        delete req.headers[PEER];
      } catch {}
    }
  }
  return emit.call(this, event, req, ...rest);
};

// Next stops accepting on SIGTERM and exits once open requests finish, but live views (event streams,
// logs, terminals) never finish on their own. After a short drain, close what is left so the exit
// happens inside Docker's default 10s stop timeout instead of ending in SIGKILL.
const DRAIN_MS = Number(process.env.GLUON_DRAIN_MS) || 5000;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    setTimeout(() => {
      for (const s of servers) s.closeAllConnections();
    }, DRAIN_MS).unref();
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), DRAIN_MS + 3000).unref();
  });
}

process.env.GLUON_PEER_HEADER = "1";
require("./server.js");
