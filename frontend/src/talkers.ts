import { sourceCountry } from "./countries";
import { isKeyAsset, severityLevels, TrafficEvent } from "./types";

export type TalkerDim = "src" | "cty" | "sig" | "dst";

interface Bucket {
  src: Map<string, number>;
  cty: Map<string, number>;
  /** Running sums of source lat/lon per country, for the centre of its traffic (the wall tour zooms there). */
  ctyGeo: Map<string, { lat: number; lon: number; n: number }>;
  sig: Map<string, number>;
  dst: Map<string, number>;
  sev: Map<string, number>;
  keyHits: number;
}

/** Event counts by severity level id (every configured level, plus "unknown"), and the overall total. */
export type SeverityTotals = Record<string, number> & { total: number };

export interface Talker {
  name: string;
  count: number;
}

export interface CountryTalker extends Talker {
  /** Average source position of this country's traffic in the window. */
  lat: number;
  lon: number;
}

const NO_SIGNATURE = "(no signature)";

/** Rolling counts of who is sending, what is firing, and who is being
 *  hit, over the last `windowSec` seconds. Counts EVERY event, including
 *  ones the arc throttle folded away -- the stats reflect real volume,
 *  not what happened to get drawn.
 *
 *  Stored as one small map per second so memory stays bounded by the
 *  number of distinct values, not the number of events. */
export class TalkerStats {
  private buckets = new Map<number, Bucket>();
  /** When counting began (ms), so the panel can say when a long window is only partly filled. */
  readonly since: number;

  /** `windowSec` is the default window (what the wall headline reads); `maxWindowSec` is how much is kept, so
   *  the panel can offer longer ones. */
  constructor(private windowSec = 300, private maxWindowSec = windowSec, now: number = Date.now()) {
    this.since = now;
  }

  /** The buckets inside the last `windowSec` seconds. */
  private *within(nowSec: number, windowSec: number): Iterable<Bucket> {
    const oldest = nowSec - Math.min(windowSec, this.maxWindowSec);
    for (const [sec, b] of this.buckets) if (sec > oldest) yield b;
  }

  record(e: TrafficEvent, nowMs: number): void {
    const sec = Math.floor(nowMs / 1000);
    let b = this.buckets.get(sec);
    if (!b) {
      b = { src: new Map(), cty: new Map(), ctyGeo: new Map(), sig: new Map(), dst: new Map(), sev: new Map(), keyHits: 0 };
      this.buckets.set(sec, b);
      this.evict(sec);
    }
    // A known system is counted by NAME, so 40 addresses that all belong to the
    // Payment API show up as one "Payment API" row instead of 40 IPs.
    bump(b.src, e.src_asset?.name ?? e.src_ip ?? `${e.src_lat},${e.src_lon}`);
    bump(b.dst, e.dst_asset?.name ?? e.dst_ip ?? `${e.dst_lat},${e.dst_lon}`);
    if (isKeyAsset(e.dst_asset)) b.keyHits += 1;
    const country = sourceCountry(e);
    if (country) {
      bump(b.cty, country);
      const g = b.ctyGeo.get(country) ?? { lat: 0, lon: 0, n: 0 };
      g.lat += e.src_lat; g.lon += e.src_lon; g.n += 1;
      b.ctyGeo.set(country, g);
    }
    bump(b.sig, e.signature ?? NO_SIGNATURE);
    bump(b.sev, e.severity);
  }

  /** Total events with a known source country over the window (the denominator for "% of traffic"). */
  countryTotal(nowMs: number, windowSec = this.windowSec): number {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    let n = 0;
    for (const b of this.within(nowSec, windowSec)) for (const c of b.cty.values()) n += c;
    return n;
  }

  /** Top source countries with the centre of each one's traffic. */
  topCountries(n: number, nowMs: number, windowSec = this.windowSec): CountryTalker[] {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    const sums = new Map<string, { lat: number; lon: number; n: number }>();
    for (const b of this.within(nowSec, windowSec)) {
      for (const [name, g] of b.ctyGeo) {
        const s = sums.get(name) ?? { lat: 0, lon: 0, n: 0 };
        s.lat += g.lat; s.lon += g.lon; s.n += g.n;
        sums.set(name, s);
      }
    }
    return [...sums]
      .map(([name, s]) => ({ name, count: s.n, lat: s.lat / s.n, lon: s.lon / s.n }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, n);
  }

  top(dim: TalkerDim, n: number, nowMs: number, windowSec = this.windowSec): Talker[] {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    const totals = new Map<string, number>();
    for (const b of this.within(nowSec, windowSec)) {
      for (const [name, count] of b[dim]) totals.set(name, (totals.get(name) ?? 0) + count);
    }
    return [...totals]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, n);
  }

  /** Event counts by severity over the window -- the wall-mode headline. */
  severityTotals(nowMs: number, windowSec = this.windowSec): SeverityTotals {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    const t: SeverityTotals = { unknown: 0, total: 0 };
    for (const lv of severityLevels()) t[lv.id] = 0;
    for (const b of this.within(nowSec, windowSec)) {
      for (const [sev, n] of b.sev) {
        t[sev] = (t[sev] ?? 0) + n;
        t.total += n;
      }
    }
    return t;
  }

  /** Events aimed at high- or critical-priority systems over the window. */
  keyAssetHits(nowMs: number, windowSec = this.windowSec): number {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    let n = 0;
    for (const b of this.within(nowSec, windowSec)) n += b.keyHits;
    return n;
  }

  private evict(nowSec: number): void {
    const oldest = nowSec - this.maxWindowSec;
    for (const sec of this.buckets.keys()) if (sec <= oldest) this.buckets.delete(sec);
  }
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

const TABS: { dim: TalkerDim; label: string }[] = [
  { dim: "src", label: "Sources" },
  { dim: "cty", label: "Countries" },
  { dim: "sig", label: "Signatures" },
  { dim: "dst", label: "Targets" },
];
const ROWS = 6;
/** Windows the panel offers (seconds). */
export const TALKER_WINDOWS: { sec: number; label: string }[] = [
  { sec: 60, label: "1 min" }, { sec: 300, label: "5 min" }, { sec: 900, label: "15 min" }, { sec: 3600, label: "1 hour" },
];
export const WINDOW_PREF = "sightline:windows";

/** The analyst's chosen windows, remembered in this browser. */
export function loadWindowPref(): { talkers?: number; trend?: number } {
  try { const v = JSON.parse(localStorage.getItem(WINDOW_PREF) ?? "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function saveWindowPref(patch: { talkers?: number; trend?: number }): void {
  try { localStorage.setItem(WINDOW_PREF, JSON.stringify({ ...loadWindowPref(), ...patch })); } catch { /* private mode: lasts until reload */ }
}

/** "page open 12 min": shown when the chosen window is longer than this screen has been counting. */
export function partialNote(sinceMs: number, nowMs: number, windowMs: number): string {
  const open = nowMs - sinceMs;
  if (open >= windowMs) return "";
  const min = Math.max(1, Math.round(open / 60_000));
  return `Counting for ${min >= 90 ? `${Math.round(min / 60)} h` : `${min} min`} so far`;
}
const ROTATE_MS = 12_000;

/** Sidebar panel showing TalkerStats. Builds its own DOM (no index.html
 *  change needed) and inserts itself above `anchor`. */
export class TalkersPanel {
  private tab: TalkerDim = "src";
  private list = document.createElement("div");
  private tabButtons = new Map<TalkerDim, HTMLButtonElement>();
  private timer: number;
  private rotateTimer: number;
  private lastManual = 0;
  private windowSec: number;
  private note = document.createElement("div");

  constructor(private stats: TalkerStats, windowSec: number, anchor: HTMLElement | null) {
    const saved = loadWindowPref().talkers;
    this.windowSec = TALKER_WINDOWS.some((w) => w.sec === saved) ? (saved as number) : windowSec;
    const section = document.createElement("div");
    section.className = "panel-section";
    section.id = "talkers-section";

    const head = document.createElement("div");
    head.className = "talkers-head";
    const h2 = document.createElement("h2");
    h2.textContent = "Top Talkers";
    const win = document.createElement("select");
    win.className = "win-select";
    win.setAttribute("aria-label", "Time window for top talkers");
    for (const w of TALKER_WINDOWS) {
      const o = document.createElement("option");
      o.value = String(w.sec);
      o.textContent = `last ${w.label}`;
      win.append(o);
    }
    win.value = String(this.windowSec);
    win.addEventListener("change", () => { this.windowSec = Number(win.value); saveWindowPref({ talkers: this.windowSec }); this.render(); });
    this.note.className = "win-note";
    head.append(h2, win);

    const tabs = document.createElement("div");
    tabs.className = "talkers-tabs";
    for (const { dim, label } of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "talkers-tab";
      btn.textContent = label;
      btn.addEventListener("click", () => { this.tab = dim; this.lastManual = Date.now(); this.render(); });
      this.tabButtons.set(dim, btn);
      tabs.append(btn);
    }

    section.append(head, tabs, this.list, this.note);
    if (anchor) anchor.before(section);
    else document.body.append(section);

    this.render();
    this.timer = window.setInterval(() => this.render(), 2000);
    // In wall mode nobody clicks the tabs, so they take turns: sources, countries, signatures, targets.
    // A manual click pauses the rotation for a minute.
    this.rotateTimer = window.setInterval(() => this.rotate(), ROTATE_MS);
  }

  /** Moves to the next tab; only does anything in wall mode and not right after a manual click. */
  rotate(now = Date.now()): void {
    if (!document.body.classList.contains("kiosk") || now - this.lastManual < 60_000) return;
    const i = TABS.findIndex((t) => t.dim === this.tab);
    this.tab = TABS[(i + 1) % TABS.length].dim;
    this.render();
  }

  dispose(): void { window.clearInterval(this.timer); window.clearInterval(this.rotateTimer); }

  render(): void {
    for (const [dim, btn] of this.tabButtons) btn.classList.toggle("active", dim === this.tab);

    const now = Date.now();
    this.note.textContent = partialNote(this.stats.since, now, this.windowSec * 1000);
    const rows = this.stats.top(this.tab, ROWS, now, this.windowSec);
    this.list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "talkers-empty";
      empty.textContent = "No traffic yet";
      this.list.append(empty);
      return;
    }

    const max = rows[0].count;
    // Countries read better as a share of traffic than as a raw count.
    const total = this.tab === "cty" ? this.stats.countryTotal(now, this.windowSec) : 0;
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "talker-row";
      row.title = `${r.name} \u2014 ${r.count.toLocaleString()}`;
      const bar = document.createElement("div");
      bar.className = "talker-bar";
      bar.style.width = `${Math.max(4, (r.count / max) * 100)}%`;
      const name = document.createElement("span");
      name.className = "talker-name";
      name.textContent = r.name;
      const count = document.createElement("span");
      count.className = "talker-count";
      count.textContent = total > 0 ? `${Math.max(1, Math.round((r.count / total) * 100))}%` : r.count.toLocaleString();
      row.append(bar, name, count);
      this.list.append(row);
    }
  }
}
