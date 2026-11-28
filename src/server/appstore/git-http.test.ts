import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../docker/client", () => ({ docker: () => ({ listNetworks: async () => [] }) }));
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("./db", () => ({ getStoreRow: () => null }));
vi.mock("./repo", () => ({ GIT_ENV: {}, REPO_NAME: "store.git", STORE_DIR: "/nonexistent" }));

const { cgiBody } = await import("./git-http");

/** A pack of `chunks` 64 KiB pieces that counts how many have been produced. */
function pack(chunks: number) {
  let made = 0;
  const out = new Readable({
    highWaterMark: 64 * 1024,
    read() {
      made++;
      this.push(made <= chunks ? Buffer.alloc(64 * 1024, made % 256) : null);
    },
  });
  return { out, made: () => made };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("git pack streaming", () => {
  it("reads the pack only as fast as the client takes it", async () => {
    const src = pack(2000);
    const reader = cgiBody(Buffer.from("PACK"), src.out, () => {}).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("PACK");
    await reader.read();
    await settle();
    // 2000 chunks are 125 MiB; a reader that stopped after one should leave nearly all of it unread.
    expect(src.made()).toBeLessThan(40);
    await reader.cancel();
  });

  it("sends everything, in order, when the client keeps reading", async () => {
    const src = pack(5);
    const body = Buffer.from(await new Response(cgiBody(Buffer.from("hd"), src.out, () => {})).arrayBuffer());
    expect(body.length).toBe(2 + 5 * 64 * 1024);
    expect([body[0], body[1], body[2], body[2 + 64 * 1024], body.at(-1)]).toEqual([0x68, 0x64, 1, 2, 5]);
  });

  it("stops git when the client goes away, and not when it finishes", async () => {
    const gone = vi.fn();
    const reader = cgiBody(Buffer.alloc(0), pack(100).out, gone).getReader();
    await reader.read();
    await reader.cancel();
    await settle();
    expect(gone).toHaveBeenCalledOnce();

    const done = vi.fn();
    await new Response(cgiBody(Buffer.alloc(0), pack(3).out, done)).arrayBuffer();
    expect(done).not.toHaveBeenCalled();
  });
});
