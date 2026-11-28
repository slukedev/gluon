import { describe, expect, it } from "vitest";
import { Demuxer } from "./docker-logs";

const frame = (stream: 1 | 2, payload: Buffer) => {
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
};

const feed = (d: Demuxer, bytes: Buffer, step: number) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += step) out += d.push(bytes.subarray(i, i + step));
  return out;
};

describe("Demuxer", () => {
  it("joins frames split across chunks at any byte", () => {
    const bytes = Buffer.concat([frame(1, Buffer.from("started ✔\n")), frame(2, Buffer.from("warn: 温度 high\n"))]);
    for (const step of [1, 3, 7, 64]) expect(feed(new Demuxer(false), bytes, step)).toBe("started ✔\nwarn: 温度 high\n");
  });

  it("finishes a character Docker split between two frames of the same stream", () => {
    const text = Buffer.from("ünï");
    const bytes = Buffer.concat([frame(1, text.subarray(0, 1)), frame(2, Buffer.from("e\n")), frame(1, text.subarray(1))]);
    expect(new Demuxer(false).push(bytes)).toBe("e\nünï");
  });

  it("decodes a TTY stream whose chunks end inside a character", () => {
    expect(feed(new Demuxer(true), Buffer.from("Ünïcödé ✔ line\n"), 1)).toBe("Ünïcödé ✔ line\n");
  });

  it("passes a stream that isn't multiplexed after all through as text", () => {
    const d = new Demuxer(false);
    expect(d.push(Buffer.from("plain text that is long\n"))).toBe("plain text that is long\n");
    expect(d.push(Buffer.from([1, 0, 0, 0, 0, 0, 0, 1, 0x41]))).toBe("\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u0001A");
  });
});
