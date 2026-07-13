import type { LuthEvent } from "@/lib/mock/types";

export interface PositionedEvent {
  event: LuthEvent;
  /** 0-indexed column within its overlap cluster. */
  col: number;
  /** Total columns in this event's overlap cluster (its width = 100/cols%). */
  cols: number;
}

function overlaps(a: LuthEvent, b: LuthEvent): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}

/**
 * Lays out same-day timed events into side-by-side columns wherever two or
 * more overlap in time — the week view's visual answer to "these conflict".
 * Non-overlapping events always get the full column width (cols=1).
 *
 * Algorithm: group events into connected overlap clusters (event A and B are
 * in the same cluster if they overlap directly, or transitively through a
 * chain of overlapping events), then within each cluster greedily assign the
 * lowest free column index. The cluster's column count becomes every member
 * event's `cols`, so a two-event conflict renders as a clean 50/50 split.
 */
export function layoutDayEvents(events: LuthEvent[]): PositionedEvent[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Union-find to group transitively-overlapping events into clusters.
  const parent = new Map<string, string>();
  function find(id: string): string {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const e of sorted) parent.set(e.id, e.id);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (overlaps(sorted[i], sorted[j])) union(sorted[i].id, sorted[j].id);
    }
  }

  const clusters = new Map<string, LuthEvent[]>();
  for (const e of sorted) {
    const root = find(e.id);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(e);
    else clusters.set(root, [e]);
  }

  const result: PositionedEvent[] = [];
  for (const clusterEvents of clusters.values()) {
    // Greedy column assignment within the cluster: place each event in the
    // first column whose most recent event has already ended.
    const columnEnds: number[] = []; // last event end-time (ms) per column
    const assigned = new Map<string, number>();
    for (const e of clusterEvents) {
      const start = Date.parse(e.start);
      let col = columnEnds.findIndex((end) => end <= start);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(Date.parse(e.end));
      } else {
        columnEnds[col] = Date.parse(e.end);
      }
      assigned.set(e.id, col);
    }
    const cols = columnEnds.length;
    for (const e of clusterEvents) {
      result.push({ event: e, col: assigned.get(e.id)!, cols });
    }
  }

  return result;
}
