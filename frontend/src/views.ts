import { GroupMode, SortMode, isGroupMode, isSortMode } from "./logOrder";
import { LayoutState, parseLayout } from "./layoutState";

/** A "view": what an analyst is looking at, as data. It backs the role presets, the saved views and the
 *  share links. Pure logic, no DOM. */

export interface ViewState {
  /** The typed search. */
  q: string;
  /** Switched-on built-in chip ids. */
  chips: string[];
  /** Mute known-good sources. */
  mute: boolean;
  sort: SortMode;
  group: GroupMode;
  hideReviewed: boolean;
}

export const defaultView = (): ViewState => ({ q: "", chips: [], mute: true, sort: "newest", group: "none", hideReviewed: false });

const MAX_Q = 300;

export function parseViewState(raw: unknown): ViewState {
  const out = defaultView();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.q === "string") out.q = r.q.slice(0, MAX_Q);
  if (Array.isArray(r.chips)) out.chips = r.chips.filter((x): x is string => typeof x === "string" && x.length < 80).slice(0, 20);
  if (typeof r.mute === "boolean") out.mute = r.mute;
  if (isSortMode(r.sort)) out.sort = r.sort;
  if (isGroupMode(r.group)) out.group = r.group;
  if (typeof r.hideReviewed === "boolean") out.hideReviewed = r.hideReviewed;
  return out;
}

/** The URL query parameters for a view. Only what differs from the default is written, so links stay short. */
export function viewToParams(v: ViewState): Record<string, string> {
  const p: Record<string, string> = {};
  if (v.q.trim()) p.q = v.q.trim();
  if (v.chips.length > 0) p.chips = v.chips.join(",");
  if (!v.mute) p.mute = "0";
  if (v.sort !== "newest") p.sort = v.sort;
  if (v.group !== "none") p.group = v.group;
  if (v.hideReviewed) p.hide = "reviewed";
  return p;
}

export function paramsToView(params: URLSearchParams): ViewState {
  return parseViewState({
    q: params.get("q") ?? "",
    chips: (params.get("chips") ?? "").split(",").filter(Boolean),
    mute: params.get("mute") !== "0",
    sort: params.get("sort") ?? "newest",
    group: params.get("group") ?? "none",
    hideReviewed: params.get("hide") === "reviewed",
  });
}

/** A link that opens Sightline showing `v`. Wall-mode and other unrelated parameters are not carried over. */
export function buildShareUrl(base: string, v: ViewState): string {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  for (const [k, val] of Object.entries(viewToParams(v))) url.searchParams.set(k, val);
  return url.toString();
}

// ---- role presets ----------------------------------------------------------------------------

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  view: ViewState;
}

export const PRESETS: Preset[] = [
  {
    id: "triage",
    name: "Triage",
    blurb: "Worst first, reviewed items out of the way.",
    view: { ...defaultView(), sort: "severity", hideReviewed: true },
  },
  {
    id: "hunter",
    name: "Threat hunter",
    blurb: "Only what is uncommon here, most unusual first.",
    view: { ...defaultView(), q: "anomaly_score >= 40", sort: "unusual" },
  },
  {
    id: "overview",
    name: "Manager overview",
    blurb: "Key systems only, grouped by target.",
    view: { ...defaultView(), chips: ["key"], sort: "severity", group: "target" },
  },
];

// ---- saved views -----------------------------------------------------------------------------

export interface SavedView {
  name: string;
  view: ViewState;
  /** Panel folding/order/sizes, when the analyst chose to keep them. */
  layout?: LayoutState;
}

export const MAX_VIEWS = 20;
export const MAX_NAME = 40;
const KEY = "sightline:views";
type Store = Pick<Storage, "getItem" | "setItem">;

export function parseSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_NAME) : "";
    if (!name || out.some((v) => v.name === name)) continue;
    const sv: SavedView = { name, view: parseViewState(r.view) };
    if (r.layout) sv.layout = parseLayout(r.layout);
    out.push(sv);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

export class ViewStore {
  private views: SavedView[] = [];

  constructor(private storage: Store | null) {
    try { this.views = parseSavedViews(JSON.parse(storage?.getItem(KEY) ?? "null")); } catch { /* start empty */ }
  }

  list(): SavedView[] { return [...this.views]; }

  /** Saves (or replaces, by name). False when the name is empty or the limit is reached. */
  save(name: string, view: ViewState, layout?: LayoutState): boolean {
    const n = name.trim().slice(0, MAX_NAME);
    if (!n) return false;
    const rest = this.views.filter((v) => v.name !== n);
    if (rest.length >= MAX_VIEWS) return false;
    rest.unshift(layout ? { name: n, view, layout } : { name: n, view });
    this.views = rest;
    this.persist();
    return true;
  }

  remove(name: string): void {
    this.views = this.views.filter((v) => v.name !== name);
    this.persist();
  }

  exportJson(): string {
    return JSON.stringify({ sightlineViews: 1, views: this.views }, null, 2);
  }

  /** Adds views from an exported file. Returns how many were added; malformed files add none. */
  importJson(text: string): number {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return 0; }
    const list = parseSavedViews((parsed as { views?: unknown } | null)?.views);
    let added = 0;
    for (const v of list) {
      if (this.views.length >= MAX_VIEWS && !this.views.some((x) => x.name === v.name)) break;
      this.views = [v, ...this.views.filter((x) => x.name !== v.name)];
      added += 1;
    }
    if (added > 0) this.persist();
    return added;
  }

  private persist(): void {
    try { this.storage?.setItem(KEY, JSON.stringify(this.views)); } catch { /* blocked: views last until reload */ }
  }
}
