import { loadWindowPref, partialNote, saveWindowPref } from "./talkers";
import { severityColor, severityLabel, severityLevels, TrafficEvent } from "./types";

/** Events per minute over the last hour, split by severity.
 *
 *  This lives in the browser's memory, so it starts empty when the page opens
 *  and fills in as time passes (a wall that has been up for an hour shows the
 *  whole hour). It is a trend of what THIS screen has seen, not a query of
 *  Elastic history; a true 24-hour view would need a query to your SIEM. */

const MIN_MS = 60_000;

export interface TrendPoint {
  /** Minute start, ms since epoch. */
  t: number;
  total: number;
  counts: Record<string, number>;
}

export class TrendStats {
  private minutes = new Map<number, Record<string, number>>();
  /** When counting began (ms), so the panel can say when a long window is only partly filled. */
  readonly since: number;

  /** `spanMin` is the default span; `maxSpanMin` is how much is kept so the panel can offer longer ones. */
  constructor(private spanMin = 60, private maxSpanMin = spanMin, now: number = Date.now()) {
    this.since = now;
  }

  record(e: TrafficEvent, now: number): void {
    const m = Math.floor(now / MIN_MS);
    let b = this.minutes.get(m);
    if (!b) {
      b = {};
      this.minutes.set(m, b);
      for (const k of this.minutes.keys()) if (k <= m - this.maxSpanMin) this.minutes.delete(k);
    }
    b[e.severity] = (b[e.severity] ?? 0) + 1;
  }

  /** One point per minute, oldest first, ending with the current (partial) minute. */
  series(now: number, spanMin = this.spanMin): TrendPoint[] {
    const m = Math.floor(now / MIN_MS);
    const out: TrendPoint[] = [];
    for (let i = Math.min(spanMin, this.maxSpanMin) - 1; i >= 0; i--) {
      const counts = this.minutes.get(m - i) ?? {};
      let total = 0;
      for (const n of Object.values(counts)) total += n;
      out.push({ t: (m - i) * MIN_MS, total, counts });
    }
    return out;
  }
}

/** Spans the panel offers (minutes). Longer ones only fill as the page stays open. */
export const TREND_SPANS: { min: number; label: string }[] = [
  { min: 15, label: "15 min" }, { min: 60, label: "1 hour" }, { min: 180, label: "3 hours" }, { min: 360, label: "6 hours" },
];

const SVG_NS = "http://www.w3.org/2000/svg";

/** Sidebar panel: a small stacked-bar chart of TrendStats. Inserts itself above `anchor`. */
export class TrendPanel {
  private svg = document.createElementNS(SVG_NS, "svg");
  private peak = document.createElement("span");
  private note = document.createElement("span");
  private timer: number;
  private spanMin: number;

  constructor(private stats: TrendStats, spanMin: number, anchor: HTMLElement | null) {
    const saved = loadWindowPref().trend;
    this.spanMin = TREND_SPANS.some((s) => s.min === saved) ? (saved as number) : spanMin;
    const section = document.createElement("div");
    section.className = "panel-section";
    section.id = "trend-section";

    const head = document.createElement("div");
    head.className = "talkers-head";
    const h2 = document.createElement("h2");
    h2.textContent = "Events per minute";
    const win = document.createElement("select");
    win.className = "win-select";
    win.setAttribute("aria-label", "Time span for events per minute");
    for (const s of TREND_SPANS) {
      const o = document.createElement("option");
      o.value = String(s.min);
      o.textContent = `last ${s.label}`;
      win.append(o);
    }
    win.value = String(this.spanMin);
    win.addEventListener("change", () => { this.spanMin = Number(win.value); saveWindowPref({ trend: this.spanMin }); this.render(); });
    head.append(h2, win);

    this.svg.setAttribute("preserveAspectRatio", "none");
    this.svg.setAttribute("class", "trend-svg");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", "Events per minute, by severity");

    this.peak.className = "trend-peak";
    this.note.className = "win-note";
    section.append(head, this.svg, this.peak, this.note);
    if (anchor) anchor.before(section);
    else document.body.append(section);

    this.render();
    this.timer = window.setInterval(() => this.render(), 5000);
  }

  dispose(): void { window.clearInterval(this.timer); }

  render(now = Date.now()): void {
    const pts = this.stats.series(now, this.spanMin);
    // Keep the bars the same width whatever the span: the box grows with the number of minutes.
    this.svg.setAttribute("viewBox", `0 0 ${pts.length * 4} 60`);
    this.note.textContent = partialNote(this.stats.since, now, this.spanMin * 60_000);
    const max = Math.max(1, ...pts.map((p) => p.total));
    // Most severe at the bottom of each bar, so the worst reads as the base.
    const order = [...severityLevels().map((l) => l.id), "unknown"];
    const parts: SVGElement[] = [];
    const w = 4;
    pts.forEach((p, i) => {
      let y = 60;
      for (const id of order) {
        const n = p.counts[id] ?? 0;
        if (n === 0) continue;
        const h = (n / max) * 58;
        const r = document.createElementNS(SVG_NS, "rect");
        r.setAttribute("x", String(i * w + 0.4));
        r.setAttribute("y", (y - h).toFixed(2));
        r.setAttribute("width", String(w - 0.8));
        r.setAttribute("height", h.toFixed(2));
        r.setAttribute("fill", severityColor(id));
        const t = document.createElementNS(SVG_NS, "title");
        t.textContent = `${new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${severityLabel(id)}: ${n}`;
        r.append(t);
        parts.push(r);
        y -= h;
      }
    });
    this.svg.replaceChildren(...parts);
    const peak = Math.max(...pts.map((p) => p.total));
    this.peak.textContent = peak === 0 ? "Nothing yet — fills in as the page stays open" : `peak ${peak.toLocaleString()} / min`;
  }
}
