export interface Anchor {
  seq: number;
  index: number;
  start: number;
}

type Rows = readonly { seq: number }[];
type Spans = readonly { start: number; end: number }[];

/** Rows stay in arrival order, so their sequence numbers only grow. */
export function indexOfSeq(rows: Rows, seq: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = rows[mid]!.seq;
    if (at === seq) return mid;
    if (at < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The row at the top of the view: the first one that ends below the scroll offset. */
export function anchorAt(rows: Rows, spans: Spans, scrollTop: number): Anchor | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.end > scrollTop) hi = mid;
    else lo = mid + 1;
  }
  const index = Math.min(lo, spans.length - 1);
  const row = rows[index];
  return row && spans[index] ? { seq: row.seq, index, start: spans[index].start } : null;
}

/** After rows above the anchor were dropped or added, how far to scroll and how far row indexes moved. */
export function reanchor(prev: Anchor | null, rows: Rows, spans: Spans): { scrollBy: number; shift: number } | null {
  if (!prev) return null;
  const index = indexOfSeq(rows, prev.seq);
  const start = index >= 0 ? spans[index]?.start : undefined;
  if (start === undefined || index === prev.index) return null;
  return { scrollBy: start - prev.start, shift: index - prev.index };
}
