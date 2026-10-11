/** How the event log is ordered and grouped. Pure list logic (no DOM) so it can be tested; logView.ts does the DOM work. */

export type SortMode = "newest" | "severity" | "unusual" | "repeats";
export type GroupMode = "none" | "country" | "target" | "signature";

export const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "severity", label: "Most severe" },
  { id: "unusual", label: "Most unusual" },
  { id: "repeats", label: "Most repeated" },
];

export const GROUP_MODES: { id: GroupMode; label: string }[] = [
  { id: "none", label: "No grouping" },
  { id: "country", label: "By source country" },
  { id: "target", label: "By target" },
  { id: "signature", label: "By signature" },
];

export const isSortMode = (x: unknown): x is SortMode => SORT_MODES.some((m) => m.id === x);
export const isGroupMode = (x: unknown): x is GroupMode => GROUP_MODES.some((m) => m.id === x);

/** What the ordering needs to know about one log row. */
export interface LogItem {
  /** Group id: rises with each new row, so a higher id is a newer row. */
  id: number;
  /** Higher = more severe (see severityRank). */
  rank: number;
  /** 0-100 unusualness; 0 when there is none. */
  anomaly: number;
  count: number;
  country: string;
  target: string;
  signature: string;
}

const newestFirst = (a: LogItem, b: LogItem): number => b.id - a.id;

/** Sorted copy. Ties always fall back to newest first, so the order is stable and predictable. */
export function sortItems(items: readonly LogItem[], mode: SortMode): LogItem[] {
  const by: Record<SortMode, (a: LogItem, b: LogItem) => number> = {
    newest: newestFirst,
    severity: (a, b) => b.rank - a.rank || b.anomaly - a.anomaly || newestFirst(a, b),
    unusual: (a, b) => b.anomaly - a.anomaly || b.rank - a.rank || newestFirst(a, b),
    repeats: (a, b) => b.count - a.count || b.rank - a.rank || newestFirst(a, b),
  };
  return [...items].sort(by[mode]);
}

export interface LogSection {
  /** null = no heading (ungrouped). */
  label: string | null;
  items: LogItem[];
}

function labelOf(item: LogItem, mode: GroupMode): string {
  if (mode === "country") return item.country;
  if (mode === "target") return item.target;
  return item.signature;
}

/** Splits an already-sorted list into sections. Sections come in the order of their best row,
 *  and rows keep their sorted order inside, so the worst thing is still at the top. */
export function groupItems(sorted: readonly LogItem[], mode: GroupMode): LogSection[] {
  if (mode === "none") return [{ label: null, items: [...sorted] }];
  const sections = new Map<string, LogItem[]>();
  for (const it of sorted) {
    const label = labelOf(it, mode) || "Unknown";
    const list = sections.get(label);
    if (list) list.push(it);
    else sections.set(label, [it]);
  }
  return [...sections].map(([label, items]) => ({ label, items }));
}
