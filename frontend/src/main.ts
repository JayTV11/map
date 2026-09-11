import "./style.css";
import { renderWorldMap } from "./map";
import { ArcEngine } from "./arcs";
import { connectTrafficSocket } from "./wsClient";
import { appendLogEntry } from "./eventLog";
import { wireControls } from "./controls";
import { Severity } from "./types";

renderWorldMap(document.getElementById("map-bg")!);

const wrap = document.getElementById("map-wrap")!;
const canvas = document.getElementById("fx") as HTMLCanvasElement;
const engine = new ArcEngine(canvas, wrap);
wireControls(engine);

const logList = document.getElementById("log-list")!;
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
  engine.spawn(event);
  if (event.is_replay) return; // renders identically, but stays out of the log/counters

  appendLogEntry(logList, event);

  total += 1;
  eventsThisWindow += 1;
  statTotal.textContent = String(total);

  const el = sevCountEls[event.severity];
  if (el) {
    sevCounts[event.severity] = (sevCounts[event.severity] ?? 0) + 1;
    el.textContent = String(sevCounts[event.severity]);
  }
});

setInterval(() => {
  const now = performance.now();
  const eps = eventsThisWindow / ((now - windowStart) / 1000);
  statEps.textContent = eps.toFixed(1);
  eventsThisWindow = 0;
  windowStart = now;
}, 500);