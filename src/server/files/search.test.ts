import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { User } from "../auth/users";

let release: (e: Error) => void = () => {};
let hold = new Promise<never>((_, reject) => (release = reject));
vi.mock("./paths", () => ({ authorize: () => hold, LEGACY_TRASH_DIR: ".tend-trash", TRASH_DIR: ".gluon-trash" }));
vi.mock("./places", () => ({ places: async () => ({ places: [] }) }));

const { searchStream } = await import("./search");

const ana = { id: "ana", role: "member" } as User;
const bo = { id: "bo", role: "member" } as User;

/** The first event a search stream sends, and the controller that ends it. */
async function open(user: User) {
  const ctrl = new AbortController();
  const res = searchStream({ signal: ctrl.signal } as NextRequest, user, ["/srv"], { q: "x" });
  const reader = res.body!.getReader();
  const first = Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    new Promise<string>((r) => setTimeout(() => r("(still running)"), 50)),
  ]);
  return { first: await first, ctrl };
}

describe("file search streams", () => {
  it("lets one person run four at a time, refuses a fifth with a readable error, and frees a slot when one ends", async () => {
    const running = [await open(ana), await open(ana), await open(ana), await open(ana)];
    expect(running.map((r) => r.first)).toEqual(Array(4).fill("(still running)"));

    const fifth = await open(ana);
    expect(fifth.first).toMatch(/^event: error\ndata: .*searches are still running/);
    // Someone else's searches don't count against Ana.
    expect((await open(bo)).first).toBe("(still running)");

    release(new Error("done"));
    hold = new Promise<never>((_, reject) => (release = reject));
    await new Promise((r) => setTimeout(r, 10));
    expect((await open(ana)).first).toBe("(still running)");
    release(new Error("done"));
  });
});
