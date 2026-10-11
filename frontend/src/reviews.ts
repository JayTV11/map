/** "Reviewed" marks and short notes on events, kept in THIS browser only (localStorage).
 *
 *  Keyed by the group key (same source, destination and signature), so a mark survives a page reload
 *  and applies to the repeats of that same activity. They are personal and are not shared with other
 *  analysts; shared notes would need the server (and a way to know who is who). */

export interface Review {
  reviewed: boolean;
  note: string;
  /** When last changed (ms). The oldest are dropped past MAX_ENTRIES. */
  at: number;
}

export const MAX_ENTRIES = 500;
export const MAX_NOTE = 500;
const KEY = "sightline:reviews";

type Store = Pick<Storage, "getItem" | "setItem">;

export function parseReviews(raw: unknown): Map<string, Review> {
  const out = new Map<string, Review>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const note = typeof r.note === "string" ? r.note.slice(0, MAX_NOTE) : "";
    const reviewed = r.reviewed === true;
    if (!reviewed && note === "") continue;
    out.set(k.slice(0, 300), { reviewed, note, at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0 });
    if (out.size >= MAX_ENTRIES) break;
  }
  return out;
}

export class ReviewStore {
  private map = new Map<string, Review>();
  private listeners: ((key: string) => void)[] = [];
  /** Calls `fn` with the key that changed. */
  subscribe(fn: (key: string) => void): void { this.listeners.push(fn); }

  constructor(private storage: Store | null, private now: () => number = Date.now) {
    try {
      this.map = parseReviews(JSON.parse(storage?.getItem(KEY) ?? "null"));
    } catch { /* blocked or corrupted: start empty */ }
  }

  get(key: string): Review | undefined { return this.map.get(key); }
  isReviewed(key: string): boolean { return this.map.get(key)?.reviewed === true; }
  hasNote(key: string): boolean { return (this.map.get(key)?.note ?? "") !== ""; }
  get size(): number { return this.map.size; }
  /** Everything marked or noted, as [group key, review]. */
  entries(): [string, Review][] { return [...this.map.entries()]; }

  set(key: string, patch: { reviewed?: boolean; note?: string }): void {
    const cur = this.map.get(key);
    const next: Review = {
      reviewed: patch.reviewed ?? cur?.reviewed ?? false,
      note: (patch.note ?? cur?.note ?? "").slice(0, MAX_NOTE),
      at: this.now(),
    };
    if (!next.reviewed && next.note === "") this.map.delete(key);
    else {
      this.map.delete(key); // re-insert: Map order then tracks recency
      this.map.set(key, next);
    }
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
    this.persist();
    for (const fn of this.listeners) fn(key);
  }

  private persist(): void {
    try { this.storage?.setItem(KEY, JSON.stringify(Object.fromEntries(this.map))); } catch { /* quota or blocked: marks last until reload */ }
  }
}
