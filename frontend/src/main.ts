import "./style.css";
import "./aggregate.css";
import "./map-theme.css";
import "./wall.css";
import "./assets.css";
import "./ingest.css";
import "./filters.css";
import { renderWorldMap } from "./map";
import { ArcEngine } from "./arcs";
import { connectTrafficSocket } from "./wsClient";
import { appendLogEntry, LogRow } from "./eventLog";
import { wireControls } from "./controls";
import { wireMapZoom } from "./mapZoom";
import { FocusController } from "./focus";
import { DetailPanel } from "./detailPanel";
import { Aggregator, EventGroup } from "./aggregator";
import { TalkerStats, TalkersPanel } from "./talkers";
import { StatusMonitor } from "./status";
import { Kiosk } from "./kiosk";
import { Headline } from "./headline";
import { loadConfig } from "./config";
import { SeverityUi } from "./severityUi";
import { openIngestDialog } from "./ingestDialog";
import { KnownGoodList } from "./knownGood";
import { EventGate } from "./gate";
import { ViewFilters } from "./viewFilters";

async function start(): Promise<void> {
  // The severity scale and the home site come from the backend, so everything
  // below (filter, legend, headline, colours) reflects YOUR data's scale.
  const cfg = await loadConfig();

  renderWorldMap(document.getElementById("map-bg")!, [{ label: cfg.home.label, lat: cfg.home.lat, lon: cfg.home.lon }]);

  const wrap = document.getElementById("map-wrap")!;
  const mapViewport = document.getElementById("map-viewport")!;
  const canvas = document.getElementById("fx") as HTMLCanvasElement;
  const engine = new ArcEngine(canvas, wrap);
  const severityUi = new SeverityUi(engine);
  wireControls(engine, (file) => void openIngestDialog(file, { onLoaded: () => void monitor.refresh() }));
  const zoom = wireMapZoom(mapViewport, wrap);

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

  // Says out loud whether the map is showing live, simulated, or no data. A
  // dead feed must never look like a quiet network (see status.ts).
  const monitor = new StatusMonitor(document.getElementById("topbar")!, wrap);

  new Headline(talkerStats, TALKER_WINDOW_SEC, wrap, () => monitor.hasAssets); // big counts; only visible in wall mode

  // Press K (or open with ?kiosk=1) for wall-display mode. If someone zooms or
  // pins an event and walks away, it returns to the world view on its own.
  new Kiosk({ onIdle: () => { zoom.reset(); focus.clear(); } });

  const logList = document.getElementById("log-list")!;
  const logRows = new Map<number, LogRow>(); // group id -> its row, while the row is still in the DOM
  const logGroups = new Map<number, EventGroup>();

  // Two ways to hide events: the known-good mute list (ON by default) and the
  // search bar. Hidden events are counted and the badge on the map says how
  // many, so nothing is hidden silently. Loaded BEFORE the live socket opens
  // so the replayed backlog is muted too.
  const knownGood = new KnownGoodList();
  const gate = new EventGate(knownGood);
  await knownGood.refresh();
  knownGood.startPolling();
  const extraFields = new Set<string>(); // unmapped column names seen so far, to catch typos in the search bar
  const viewFilters = new ViewFilters(gate, knownGood, wrap, (name) => extraFields.has(name.toLowerCase()), document.getElementById("detail-section"));
  // Re-check what's already on screen when the mute switch, the search or the list changes.
  const recheckLog = (): void => {
    for (const [id, row] of logRows) {
      const g = logGroups.get(id);
      if (g) row.el.hidden = !gate.passes(g.event);
    }
    viewFilters.refresh();
  };
  gate.onChange = recheckLog;
  knownGood.onChange = () => gate.listChanged();
  const statEps = document.getElementById("stat-eps")!;
  const statActive = document.getElementById("stat-active")!;
  const statTotal = document.getElementById("stat-total")!;

  let total = 0;
  let eventsThisWindow = 0;
  let windowStart = performance.now();

  engine.onActiveCountChange = (n) => { statActive.textContent = String(n); };

  connectTrafficSocket((event) => {
    monitor.noteEvent(event); // before the gate: a feed of only-muted traffic is still a live feed
    if (extraFields.size < 500) for (const k of Object.keys(event.extra ?? {})) extraFields.add(k.toLowerCase());

    const verdict = gate.verdict(event);
    if (verdict !== "pass") {
      if (!event.is_replay) gate.count(verdict);
      return;
    }
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
      logGroups.set(group.id, group);
    } else {
      logRows.get(group.id)?.update(group);
      focus.refresh(group);
    }

    // Stats count every event, not every group -- they show real volume.
    total += 1;
    eventsThisWindow += 1;
    statTotal.textContent = String(total);
    severityUi.record(event.severity);
  }, (connected) => monitor.setWsConnected(connected));

  // Draws arcs the aggregator held back (a burst that ended, or the global
  // budget ran out) and forgets log rows the 60-entry cap already removed.
  let ticks = 0;
  setInterval(() => {
    for (const arc of aggregator.tick(Date.now())) if (gate.passes(arc.event)) engine.spawn(arc.event, arc.weight);
    if (++ticks % 20 === 0) {
      for (const [id, row] of logRows) {
        if (!row.el.isConnected) { logRows.delete(id); logGroups.delete(id); }
      }
    }
  }, 250);

  setInterval(() => {
    const now = performance.now();
    const eps = eventsThisWindow / ((now - windowStart) / 1000);
    statEps.textContent = eps.toFixed(1);
    eventsThisWindow = 0;
    windowStart = now;
  }, 500);
}

void start();
