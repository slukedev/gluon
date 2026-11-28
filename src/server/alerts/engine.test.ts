import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../jobs", () => ({ onStart: vi.fn(), every: vi.fn() }));
vi.mock("../findings", () => ({ getFinding: vi.fn() }));
vi.mock("../audit", () => ({ audit: vi.fn() }));

const { registerCheck, runAllChecks } = await import("./engine");

afterEach(() => vi.useRealTimers());

describe("runAllChecks", () => {
  it("moves past a check that never settles, and the next pass can start", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const after = vi.fn();
    registerCheck("hangs", 60_000, () => new Promise(() => undefined));
    registerCheck("throws sync", 60_000, () => {
      throw new Error("boom");
    });
    registerCheck("after", 60_000, after);

    const first = runAllChecks();
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    expect(after).toHaveBeenCalledTimes(1);

    const second = runAllChecks();
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    expect(after).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
