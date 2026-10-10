/** The analyst's sidebar layout: which panels are folded, how tall each is, and in what order.
 *  Pure data and list logic (no DOM) so it can be tested; panelLayout.ts does the DOM work. */

export interface LayoutState {
  /** Panel ids, top to bottom. */
  order: string[];
  collapsed: Record<string, boolean>;
  /** Panel heights in px, for panels the analyst has resized. */
  heights: Record<string, number>;
}

export const MIN_HEIGHT = 56;
export const MAX_HEIGHT = 1400;

export const emptyLayout = (): LayoutState => ({ order: [], collapsed: {}, heights: {} });

export function clampHeight(px: number): number {
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px)));
}

/** Reads a saved layout defensively: anything malformed is dropped rather than trusted. */
export function parseLayout(raw: unknown): LayoutState {
  const out = emptyLayout();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.order)) out.order = r.order.filter((x): x is string => typeof x === "string").slice(0, 100);
  if (r.collapsed && typeof r.collapsed === "object") {
    for (const [k, v] of Object.entries(r.collapsed as Record<string, unknown>)) if (typeof v === "boolean") out.collapsed[k] = v;
  }
  if (r.heights && typeof r.heights === "object") {
    for (const [k, v] of Object.entries(r.heights as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out.heights[k] = clampHeight(v);
    }
  }
  return out;
}

/** Puts `current` (the panels that exist now, in their default order) into the saved order.
 *  Panels the saved order has never seen (added in a newer version) keep their default position. */
export function mergeOrder(current: string[], saved: string[]): string[] {
  const exists = new Set(current);
  const seen = new Set<string>();
  const known = saved.filter((id) => exists.has(id) && !seen.has(id) && seen.add(id));
  const result = [...known];
  current.forEach((id, i) => {
    if (!seen.has(id)) result.splice(Math.min(i, result.length), 0, id);
  });
  return result;
}

/** Moves `id` one step up (-1) or down (+1) past the next panel that is actually showing. */
export function moveStep(order: string[], id: string, dir: -1 | 1, isShown: (id: string) => boolean): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  let j = from + dir;
  while (j >= 0 && j < order.length && !isShown(order[j])) j += dir;
  if (j < 0 || j >= order.length) return order;
  const next = order.filter((x) => x !== id);
  next.splice(j, 0, id);
  return next;
}

export function isDefaultLayout(state: LayoutState, defaultOrder: string[], defaultCollapsed: (id: string) => boolean): boolean {
  if (Object.keys(state.heights).length > 0) return false;
  if (state.order.length > 0 && state.order.join("|") !== defaultOrder.join("|")) return false;
  return defaultOrder.every((id) => (state.collapsed[id] ?? defaultCollapsed(id)) === defaultCollapsed(id));
}
