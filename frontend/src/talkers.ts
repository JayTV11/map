import { TrafficEvent } from "./types";

export type TalkerDim = "src" | "sig" | "dst";

interface Bucket {
  src: Map<string, number>;
  sig: Map<string, number>;
  dst: Map<string, number>;
}

export interface Talker {
  name: string;
  count: number;
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

  constructor(private windowSec = 300) {}

  record(e: TrafficEvent, nowMs: number): void {
    const sec = Math.floor(nowMs / 1000);
    let b = this.buckets.get(sec);
    if (!b) {
      b = { src: new Map(), sig: new Map(), dst: new Map() };
      this.buckets.set(sec, b);
      this.evict(sec);
    }
    bump(b.src, e.src_ip ?? `${e.src_lat},${e.src_lon}`);
    bump(b.dst, e.dst_ip ?? `${e.dst_lat},${e.dst_lon}`);
    bump(b.sig, e.signature ?? NO_SIGNATURE);
  }

  top(dim: TalkerDim, n: number, nowMs: number): Talker[] {
    const nowSec = Math.floor(nowMs / 1000);
    this.evict(nowSec);
    const totals = new Map<string, number>();
    for (const b of this.buckets.values()) {
      for (const [name, count] of b[dim]) totals.set(name, (totals.get(name) ?? 0) + count);
    }
    return [...totals]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, n);
  }

  private evict(nowSec: number): void {
    const oldest = nowSec - this.windowSec;
    for (const sec of this.buckets.keys()) if (sec <= oldest) this.buckets.delete(sec);
  }
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

const TABS: { dim: TalkerDim; label: string }[] = [
  { dim: "src", label: "Sources" },
  { dim: "sig", label: "Signatures" },
  { dim: "dst", label: "Targets" },
];
const ROWS = 6;

/** Sidebar panel showing TalkerStats. Builds its own DOM (no index.html
 *  change needed) and inserts itself above `anchor`. */
export class TalkersPanel {
  private tab: TalkerDim = "src";
  private list = document.createElement("div");
  private tabButtons = new Map<TalkerDim, HTMLButtonElement>();
  private timer: number;

  constructor(private stats: TalkerStats, windowSec: number, anchor: HTMLElement | null) {
    const section = document.createElement("div");
    section.className = "panel-section";
    section.id = "talkers-section";

    const head = document.createElement("div");
    head.className = "talkers-head";
    const h2 = document.createElement("h2");
    h2.textContent = "Top Talkers";
    const win = document.createElement("span");
    win.className = "talkers-window";
    win.textContent = `last ${Math.round(windowSec / 60)} min`;
    head.append(h2, win);

    const tabs = document.createElement("div");
    tabs.className = "talkers-tabs";
    for (const { dim, label } of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "talkers-tab";
      btn.textContent = label;
      btn.addEventListener("click", () => { this.tab = dim; this.render(); });
      this.tabButtons.set(dim, btn);
      tabs.append(btn);
    }

    section.append(head, tabs, this.list);
    if (anchor) anchor.before(section);
    else document.body.append(section);

    this.render();
    this.timer = window.setInterval(() => this.render(), 2000);
  }

  dispose(): void { window.clearInterval(this.timer); }

  render(): void {
    for (const [dim, btn] of this.tabButtons) btn.classList.toggle("active", dim === this.tab);

    const rows = this.stats.top(this.tab, ROWS, Date.now());
    this.list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "talkers-empty";
      empty.textContent = "No traffic yet";
      this.list.append(empty);
      return;
    }

    const max = rows[0].count;
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "talker-row";
      row.title = `${r.name} \u2014 ${r.count}`;
      const bar = document.createElement("div");
      bar.className = "talker-bar";
      bar.style.width = `${Math.max(4, (r.count / max) * 100)}%`;
      const name = document.createElement("span");
      name.className = "talker-name";
      name.textContent = r.name;
      const count = document.createElement("span");
      count.className = "talker-count";
      count.textContent = r.count.toLocaleString();
      row.append(bar, name, count);
      this.list.append(row);
    }
  }
}
