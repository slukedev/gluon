import { describe, expect, it } from "vitest";
import { anchorAt, indexOfSeq, reanchor } from "./logAnchor";

const rows = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => ({ seq: from + i * step }));
const spans = (heights: number[]) => {
  let at = 0;
  return heights.map((h) => ({ start: at, end: (at += h) }));
};

describe("log anchoring", () => {
  it("finds rows by sequence when filtering left gaps", () => {
    const r = rows(10, 40, 3);
    expect(indexOfSeq(r, 10)).toBe(0);
    expect(indexOfSeq(r, 40)).toBe(10);
    expect(indexOfSeq(r, 11)).toBe(-1);
    expect(indexOfSeq([], 1)).toBe(-1);
  });

  it("anchors on the row that is cut by the top of the view, not the one above it", () => {
    const r = rows(0, 4);
    const s = spans([20, 20, 20, 20, 20]);
    expect(anchorAt(r, s, 39)).toEqual({ seq: 1, index: 1, start: 20 });
    expect(anchorAt(r, s, 40)).toEqual({ seq: 2, index: 2, start: 40 });
    expect(anchorAt(r, s, 10_000)).toEqual({ seq: 4, index: 4, start: 80 });
    expect(anchorAt([], [], 0)).toBeNull();
  });

  it("scrolls up by exactly the height of the trimmed rows, wrapped ones included", () => {
    const before = rows(100, 199);
    const heights = before.map((r) => (r.seq % 7 === 0 ? 60 : 20));
    const prev = anchorAt(before, spans(heights), 1000)!;
    const after = before.slice(30).concat(rows(200, 229));
    const moved = reanchor(prev, after, spans(after.map((r) => (r.seq % 7 === 0 ? 60 : 20))))!;
    const trimmed = heights.slice(0, 30).reduce((a, b) => a + b, 0);
    expect(moved).toEqual({ scrollBy: -trimmed, shift: -30 });
  });

  it("leaves the view alone when only lines below arrived, or the anchor row is gone", () => {
    const before = rows(0, 49);
    const prev = anchorAt(before, spans(before.map(() => 20)), 300)!;
    const grown = rows(0, 80);
    expect(reanchor(prev, grown, spans(grown.map(() => 20)))).toBeNull();
    const past = rows(60, 120);
    expect(reanchor(prev, past, spans(past.map(() => 20)))).toBeNull();
    expect(reanchor(null, grown, spans(grown.map(() => 20)))).toBeNull();
  });
});
