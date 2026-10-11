import { EventGroup } from "./aggregator";
import { sourceCountry } from "./countries";
import { LogRow, MAX_ENTRIES } from "./eventLog";
import { GROUP_MODES, GroupMode, LogItem, SORT_MODES, SortMode, groupItems, sortItems } from "./logOrder";
import { ReviewStore } from "./reviews";
import { severityRank } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: countries, targets and signatures come from the network
  return e;
}

export interface LogViewHooks {
  /** Arrow keys moved to this row. The caller may pin it if an event is already pinned (so the detail follows). */
  onStep(el: HTMLElement, group: EventGroup): void;
  onExpand(el: HTMLElement, group: EventGroup): void;
  /** The view settings changed (sort, grouping, hide reviewed): for the URL and anything else that mirrors them. */
  onSettings(): void;
}

const PENDING_CAP = 300;

/** Owns the event log list: where rows go, how they are sorted and grouped, pausing, keyboard stepping
 *  and the "reviewed" dimming/hiding. Rows are built by eventLog.ts; this only places them.
 *
 *  Wall mode always shows the plain newest-first list: a wall must not be left paused, sorted
 *  differently or hiding rows because an analyst changed a setting on the same page. */
export class LogView {
  sort: SortMode = "newest";
  group: GroupMode = "none";
  hideReviewed = false;
  paused = false;

  private items = new Map<number, { group: EventGroup; row: LogRow }>();
  private shown = new Set<number>();
  private pending: number[] = [];
  private tools = el("div", "log-tools");
  private sortSel = el("select", "log-sel");
  private groupSel = el("select", "log-sel");
  private pauseBtn = el("button", "log-pause");
  private hideBox = document.createElement("input");
  private reorderTimer = 0;
  private lastReorder = 0;
  private kioskNow = false;

  constructor(
    private list: HTMLElement,
    section: HTMLElement,
    private reviews: ReviewStore,
    private hooks: LogViewHooks,
  ) {
    this.buildTools(section);
    reviews.subscribe((key) => this.reviewChanged(key));
    list.addEventListener("keydown", (ev) => this.onKey(ev));

    this.kioskNow = document.body.classList.contains("kiosk");
    new MutationObserver(() => {
      const k = document.body.classList.contains("kiosk");
      if (k === this.kioskNow) return;
      this.kioskNow = k;
      this.flushPending();
      this.reorder();
      this.recheckHidden();
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  // ---- settings ------------------------------------------------------------------------
  setSettings(s: { sort?: SortMode; group?: GroupMode; hideReviewed?: boolean }): void {
    if (s.sort !== undefined) this.sort = s.sort;
    if (s.group !== undefined) this.group = s.group;
    if (s.hideReviewed !== undefined) this.hideReviewed = s.hideReviewed;
    this.syncTools();
    this.reorder();
    this.recheckHidden();
  }

  private get effSort(): SortMode { return this.kioskNow ? "newest" : this.sort; }
  private get effGroup(): GroupMode { return this.kioskNow ? "none" : this.group; }
  private get effHideReviewed(): boolean { return !this.kioskNow && this.hideReviewed; }
  private get effPaused(): boolean { return !this.kioskNow && this.paused; }

  private buildTools(section: HTMLElement): void {
    for (const m of SORT_MODES) this.sortSel.append(new Option(m.label, m.id));
    for (const m of GROUP_MODES) this.groupSel.append(new Option(m.label, m.id));
    this.sortSel.setAttribute("aria-label", "Sort the event log");
    this.groupSel.setAttribute("aria-label", "Group the event log");
    this.pauseBtn.type = "button";
    this.pauseBtn.addEventListener("click", () => this.setPaused(!this.paused));
    const hideLabel = el("label", "log-hide");
    this.hideBox.type = "checkbox";
    hideLabel.append(this.hideBox, el("span", undefined, "Hide reviewed"));
    this.tools.append(this.sortSel, this.groupSel, this.pauseBtn, hideLabel);
    this.sortSel.addEventListener("change", () => { this.setSettings({ sort: this.sortSel.value as SortMode }); this.hooks.onSettings(); });
    this.groupSel.addEventListener("change", () => { this.setSettings({ group: this.groupSel.value as GroupMode }); this.hooks.onSettings(); });
    this.hideBox.addEventListener("change", () => { this.setSettings({ hideReviewed: this.hideBox.checked }); this.hooks.onSettings(); });
    this.list.before(this.tools);
    this.syncTools();
    void section;
  }

  private syncTools(): void {
    this.sortSel.value = this.sort;
    this.groupSel.value = this.group;
    this.hideBox.checked = this.hideReviewed;
    const n = this.pending.length;
    this.pauseBtn.textContent = this.paused ? `▶ Resume${n > 0 ? ` (${n} new)` : ""}` : "⏸ Pause";
    this.pauseBtn.classList.toggle("on", this.paused);
    this.pauseBtn.title = this.paused
      ? "New events are held back so the list stays still. Click to catch up."
      : "Hold new events back so the list stops moving while you read (P)";
  }

  setPaused(on: boolean): void {
    this.paused = on;
    if (!on) this.flushPending();
    this.syncTools();
  }

  // ---- rows ----------------------------------------------------------------------------
  add(group: EventGroup, row: LogRow): void {
    this.items.set(group.id, { group, row });
    if (this.effPaused) {
      this.pending.push(group.id);
      while (this.pending.length > PENDING_CAP) this.items.delete(this.pending.shift()!);
      this.syncTools();
      return;
    }
    this.insert(group.id);
  }

  private insert(id: number): void {
    const it = this.items.get(id);
    if (!it) return;
    this.shown.add(id);
    this.applyRowHidden(it.group, it.row.el);
    if (this.effSort === "newest" && this.effGroup === "none") this.list.insertBefore(it.row.el, this.list.firstChild);
    window.setTimeout(() => it.row.el.classList.add("settled"), 400);
    this.trim();
    if (!(this.effSort === "newest" && this.effGroup === "none")) this.reorder();
  }

  private flushPending(): void {
    const ids = this.pending.splice(0);
    for (const id of ids) {
      const it = this.items.get(id);
      if (!it) continue;
      this.shown.add(id);
      this.applyRowHidden(it.group, it.row.el);
      window.setTimeout(() => it.row.el.classList.add("settled"), 400);
    }
    this.trim();
    this.reorder();
    this.syncTools();
  }

  private trim(): void {
    while (this.shown.size > MAX_ENTRIES) {
      const oldest = Math.min(...this.shown);
      this.shown.delete(oldest);
      this.items.get(oldest)?.row.el.remove();
      this.items.delete(oldest);
    }
  }

  /** True while the row's id is known here (shown or waiting). Used to tell "pruned" from "not placed yet". */
  has(id: number): boolean { return this.items.has(id); }

  /** A group got another event: its count and (maybe) score changed, so its place in a sorted list may too. */
  touched(): void {
    if (this.effPaused || (this.effSort === "newest" && this.effGroup === "none")) return;
    this.scheduleReorder();
  }

  private scheduleReorder(): void {
    if (this.reorderTimer) return;
    const wait = Math.max(0, 1000 - (performance.now() - this.lastReorder)); // at most once a second: no jitter while reading
    this.reorderTimer = window.setTimeout(() => { this.reorderTimer = 0; this.reorder(); }, wait);
  }

  /** Puts the rows in the order the settings ask for. Cheap (at most 60 rows) and a no-op when nothing moved. */
  reorder(): void {
    this.lastReorder = performance.now();
    const items: LogItem[] = [];
    for (const id of this.shown) {
      const it = this.items.get(id);
      if (!it) continue;
      const e = it.group.event;
      items.push({
        id,
        rank: severityRank(it.group.severity),
        anomaly: e.anomaly?.score ?? 0,
        count: it.group.count,
        country: sourceCountry(e) ?? "Unknown",
        target: e.dst_asset?.name ?? e.dst_ip ?? "Unknown",
        signature: e.signature ?? "(no signature)",
      });
    }
    const sections = groupItems(sortItems(items, this.effSort), this.effGroup);
    const wanted: HTMLElement[] = [];
    for (const sec of sections) {
      if (sec.label !== null) wanted.push(this.header(sec.label, sec.items.length));
      for (const it of sec.items) wanted.push(this.items.get(it.id)!.row.el);
    }
    const keyOf = (c: Element): string => (c.classList.contains("log-group-head") ? `h:${c.textContent}` : `r:${(c as HTMLElement).dataset.gid}`);
    const current = Array.from(this.list.children);
    if (current.length === wanted.length && current.every((c, i) => keyOf(c) === keyOf(wanted[i]))) return;

    const active = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement : null;
    this.list.replaceChildren(...wanted);
    active?.focus({ preventScroll: true }); // moving a row would otherwise drop the keyboard position
    this.recheckHidden();
  }

  private header(label: string, n: number): HTMLElement {
    const h = el("div", "log-group-head");
    h.setAttribute("role", "presentation");
    h.append(el("span", "lg-name", label), el("span", "lg-n", String(n)));
    h.title = label;
    return h;
  }

  // ---- hiding --------------------------------------------------------------------------
  private applyRowHidden(group: EventGroup, rowEl: HTMLElement): void {
    rowEl.classList.toggle("rv-hide", this.effHideReviewed && this.reviews.isReviewed(group.key));
  }

  /** Re-applies "hide reviewed" to every row, and drops group headings left with nothing under them. */
  recheckHidden(): void {
    for (const id of this.shown) {
      const it = this.items.get(id);
      if (it) this.applyRowHidden(it.group, it.row.el);
    }
    let head: HTMLElement | null = null;
    let any = false;
    const close = (): void => { if (head) head.hidden = !any; };
    for (const c of Array.from(this.list.children) as HTMLElement[]) {
      if (c.classList.contains("log-group-head")) { close(); head = c; any = false; }
      else if (!this.isHidden(c)) any = true;
    }
    close();
  }

  private isHidden(row: HTMLElement): boolean { return row.hidden || row.classList.contains("rv-hide"); }

  private reviewChanged(key: string): void {
    for (const it of this.items.values()) {
      if (it.group.key === key) it.row.update(it.group);
    }
    // A row just reviewed while "hide reviewed" is on would vanish under the analyst's cursor mid-step:
    // the next recheck (any setting change or new event batch) hides it, so stepping stays predictable.
    window.setTimeout(() => this.recheckHidden(), 250);
  }

  // ---- stepping ------------------------------------------------------------------------
  /** The rows an analyst can currently see, in display order. */
  visibleRows(): HTMLElement[] {
    return (Array.from(this.list.querySelectorAll<HTMLElement>(".log-entry"))).filter((r) => !this.isHidden(r));
  }

  groupOf(rowEl: HTMLElement | null): EventGroup | null {
    const id = Number(rowEl?.dataset.gid);
    return Number.isFinite(id) ? this.items.get(id)?.group ?? null : null;
  }

  position(rowEl: HTMLElement | null): { index: number; total: number } | null {
    if (!rowEl || !rowEl.isConnected) return null;
    const rows = this.visibleRows();
    const i = rows.indexOf(rowEl);
    return i < 0 ? null : { index: i + 1, total: rows.length };
  }

  /** The row `dir` steps from `rowEl` (+1 = further down the list). */
  neighbor(rowEl: HTMLElement | null, dir: -1 | 1): HTMLElement | null {
    const rows = this.visibleRows();
    if (rows.length === 0) return null;
    const i = rowEl ? rows.indexOf(rowEl) : -1;
    if (i < 0) return dir === 1 ? rows[0] : rows[rows.length - 1];
    return rows[i + dir] ?? null;
  }

  /** The next row down that is not reviewed yet (wraps to the top). */
  nextUnreviewed(from: HTMLElement | null): HTMLElement | null {
    const rows = this.visibleRows();
    const start = from ? rows.indexOf(from) : -1;
    for (let n = 1; n <= rows.length; n++) {
      const r = rows[(start + n + rows.length) % rows.length];
      if (r === from) continue;
      const g = this.groupOf(r);
      if (g && !this.reviews.isReviewed(g.key)) return r;
    }
    return null;
  }

  focusFirst(): void { this.visibleRows()[0]?.focus(); }

  private onKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const row = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>(".log-entry") ?? null;
    if (!row || ev.target !== row) return; // not while a button inside the row has focus
    const rows = this.visibleRows();
    const go = (target: HTMLElement | undefined): void => {
      if (!target) return;
      ev.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "nearest" });
      const g = this.groupOf(target);
      if (g) this.hooks.onStep(target, g);
    };
    const i = rows.indexOf(row);
    const g = this.groupOf(row);
    switch (ev.key) {
      case "ArrowDown": go(rows[i + 1]); break;
      case "ArrowUp": go(rows[i - 1]); break;
      case "Home": go(rows[0]); break;
      case "End": go(rows[rows.length - 1]); break;
      case "e": case "E": if (g) { ev.preventDefault(); this.hooks.onExpand(row, g); } break;
      case "r": case "R": if (g) { ev.preventDefault(); this.reviews.set(g.key, { reviewed: !this.reviews.isReviewed(g.key) }); } break;
    }
  }
}
