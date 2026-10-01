import "./style.css";
import "./aggregate.css";
import "./map-theme.css";
import { renderWorldMap } from "./map";
import { ArcEngine } from "./arcs";
import { connectTrafficSocket } from "./wsClient";
import { appendLogEntry, LogRow } from "./eventLog";
import { wireControls } from "./controls";
import { wireMapZoom } from "./mapZoom";
import { FocusController } from "./focus";
import { DetailPanel } from "./detailPanel";
import { Aggregator } from "./aggregator";
import { TalkerStats, TalkersPanel } from "./talkers";
import { Severity } from "./types";

renderWorldMap(document.getElementById("map-bg")!);

const wrap = document.getElementById("map-wrap")!;
const mapViewport = document.getElementById("map-viewport")!;
const canvas = document.getElementById("fx") as HTMLCanvasElement;
const engine = new ArcEngine(canvas, wrap);
wireControls(engine);
wireMapZoom(mapViewport, wrap);

const focus = new FocusController(
  engine,
  new DetailPanel(),
  document.getElementById("focus-banner")!,
  document.getElementById("focus-dot")!,
  document.getElementById("focus-text")!,
  document.getElementById("focus-clear")!,
);

// Repeats of the same src -> dst + signature collapse into one group: one
// log row, and a few weighted arcs instead of one arc per event. Tunables
// (quiet window, per-group arc interval, global arc budget) live in
// DEFAULT_OPTIONS in aggregator.ts.
const aggregator = new Aggregator();

const TALKER_WINDOW_SEC = 300;
const talkerStats = new TalkerStats(TALKER_WINDOW_SEC);
new TalkersPanel(talkerStats, TALKER_WINDOW_SEC, document.getElementById("log-section"));

const logList = document.getElementById("log-list")!;
const logRows = new Map<number, LogRow>(); // group id -> its row, while the row is still in the DOM
const statEps = document.getElementById("stat-eps")!;
const statActive = document.getElementById("stat-active")!;
const statTotal = document.getElementById("stat-total")!;
const sevCountEls: Partial<Record<Severity, HTMLElement>> = {
  critical: document.getElementById("count-critical")!,
  major: document.getElementById("count-major")!,
  high: document.getElementById("count-high")!,
};

let total = 0;
let eventsThisWindow = 0;
let windowStart = performance.now();
const sevCounts: Partial<Record<Severity, number>> = { critical: 0, major: 0, high: 0 };

engine.onActiveCountChange = (n) => { statActive.textContent = String(n); };

connectTrafficSocket((event) => {
  if (event.is_replay) {
    engine.spawn(event); // renders identically, but stays out of the log/counters/stats
    return;
  }

  const now = Date.now();
  talkerStats.record(event, now);

  const { group, isNew, arc } = aggregator.ingest(event, now);
  if (arc) engine.spawn(arc.event, arc.weight);

  if (isNew) {
    logRows.set(group.id, appendLogEntry(logList, group, (el) => focus.toggle(group, el)));
  } else {
    logRows.get(group.id)?.update(group);
    focus.refresh(group);
  }

  // Stats count every event, not every group -- they show real volume.
  total += 1;
  eventsThisWindow += 1;
  statTotal.textContent = String(total);

  const el = sevCountEls[event.severity];
  if (el) {
    sevCounts[event.severity] = (sevCounts[event.severity] ?? 0) + 1;
    el.textContent = String(sevCounts[event.severity]);
  }
});

// Draws arcs the aggregator held back (a burst that ended, or the global
// budget ran out) and forgets log rows the 60-entry cap already removed.
let ticks = 0;
setInterval(() => {
  for (const arc of aggregator.tick(Date.now())) engine.spawn(arc.event, arc.weight);
  if (++ticks % 20 === 0) {
    for (const [id, row] of logRows) if (!row.el.isConnected) logRows.delete(id);
  }
}, 250);

setInterval(() => {
  const now = performance.now();
  const eps = eventsThisWindow / ((now - windowStart) / 1000);
  statEps.textContent = eps.toFixed(1);
  eventsThisWindow = 0;
  windowStart = now;
}, 500);
