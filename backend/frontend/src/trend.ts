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

  constructor(private spanMin = 60) {}

  record(e: TrafficEvent, now: number): void {
    const m = Math.floor(now / MIN_MS);
    let b = this.minutes.get(m);
    if (!b) {
      b = {};
      this.minutes.set(m, b);
      for (const k of this.minutes.keys()) if (k <= m - this.spanMin) this.minutes.delete(k);
    }
    b[e.severity] = (b[e.severity] ?? 0) + 1;
  }

  /** One point per minute, oldest first, ending with the current (partial) minute. */
  series(now: number): TrendPoint[] {
    const m = Math.floor(now / MIN_MS);
    const out: TrendPoint[] = [];
    for (let i = this.spanMin - 1; i >= 0; i--) {
      const counts = this.minutes.get(m - i) ?? {};
      let total = 0;
      for (const n of Object.values(counts)) total += n;
      out.push({ t: (m - i) * MIN_MS, total, counts });
    }
    return out;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Sidebar panel: a small stacked-bar chart of TrendStats. Inserts itself above `anchor`. */
export class TrendPanel {
  private svg = document.createElementNS(SVG_NS, "svg");
  private peak = document.createElement("span");
  private timer: number;

  constructor(private stats: TrendStats, spanMin: number, anchor: HTMLElement | null) {
    const section = document.createElement("div");
    section.className = "panel-section";
    section.id = "trend-section";

    const head = document.createElement("div");
    head.className = "talkers-head";
    const h2 = document.createElement("h2");
    h2.textContent = "Events per minute";
    const win = document.createElement("span");
    win.className = "talkers-window";
    win.textContent = `last ${spanMin} min`;
    head.append(h2, win);

    this.svg.setAttribute("viewBox", `0 0 ${spanMin * 4} 60`);
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.svg.setAttribute("class", "trend-svg");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", "Events per minute over the last hour, by severity");

    this.peak.className = "trend-peak";
    section.append(head, this.svg, this.peak);
    if (anchor) anchor.before(section);
    else document.body.append(section);

    this.render();
    this.timer = window.setInterval(() => this.render(), 5000);
  }

  dispose(): void { window.clearInterval(this.timer); }

  render(now = Date.now()): void {
    const pts = this.stats.series(now);
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
