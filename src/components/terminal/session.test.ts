import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posts: { url: string; body: unknown }[] = [];
let emit: ((e: unknown) => void) | null = null;

vi.mock("@/lib/client/api", () => ({
  ApiError: class extends Error {},
  api: { post: (url: string, body: unknown) => (posts.push({ url, body }), Promise.resolve()) },
  streamPost: (_url: string, _body: unknown, on: (e: unknown) => void) => {
    emit = on;
    return new Promise(() => {});
  },
}));

const { LiveSession } = await import("./session");

const noop = { onOut: () => {}, onExit: () => {}, onError: () => {} };
const flush = () => new Promise((r) => setImmediate(r));

describe("LiveSession resize", () => {
  beforeEach(() => {
    posts.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  it("sends only the size a drag settles on", async () => {
    const s = new LiveSession({ target: "host", mode: "shell", rows: 24, cols: 80 }, noop);
    emit!({ type: "open", id: "s1", shell: "/bin/bash" });
    for (let cols = 81; cols <= 120; cols++) s.resize(30, cols);
    await flush();
    expect(posts).toEqual([]);
    vi.advanceTimersByTime(100);
    await flush();
    expect(posts).toEqual([{ url: "/api/terminal/sessions/s1", body: { resize: { rows: 30, cols: 120 } } }]);
  });

  it("holds a size given before the shell opens and drops a pending one once closed", async () => {
    const s = new LiveSession({ target: "host", mode: "shell", rows: 24, cols: 80 }, noop);
    s.resize(40, 100);
    emit!({ type: "open", id: "s2", shell: "/bin/sh" });
    vi.advanceTimersByTime(100);
    await flush();
    expect(posts.map((p) => p.body)).toEqual([{ resize: { rows: 40, cols: 100 } }]);

    s.resize(50, 90);
    s.close();
    vi.advanceTimersByTime(100);
    await flush();
    expect(posts).toHaveLength(1);
  });
});
