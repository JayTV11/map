import "./style.css";
import "./aggregate.css";
import "./map-theme.css";
import "./wall.css";
import "./assets.css";
import "./ingest.css";
import "./filters.css";
import "./anomaly.css";
import "./popout.css";
import "./logtools.css";
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
import { viewMode, WindowSync } from "./windowSync";
import { CaseStore, ExportContext } from "./cases";
import { CampaignPanel } from "./campaignPanel";
import { queryForItemId } from "./campaigns";
import { CasePanel } from "./casePanel";
import { ContainmentStore, STATUS_LABEL, STATUS_SHORT } from "./containment";
import { openDossier } from "./dossier";
import { PivotField } from "./pivot";
import { severityLabel } from "./types";
import { openSummary } from "./summaryModal";
import { SignatureNotes } from "./signatureNotes";
import { SourceHistoryStore } from "./sourceHistory";
import { EventGate } from "./gate";
import { ViewFilters } from "./viewFilters";
import { mountDayNight } from "./daynight";
import { WallClock, mountLogo } from "./wallExtras";
import { ThreatMonitor } from "./threat";
import { TrendStats, TrendPanel } from "./trend";
import { SpotlightController, SpotlightView } from "./spotlight";
import { Tour } from "./tour";
import { wireMapPick } from "./mapPick";
import { EventHistory, Replayer } from "./replay";
import { Alerter, AlertGate } from "./alerts";
import { AnalystTools } from "./analystTools";
import { PanelLayout } from "./panelLayout";
import { LogView } from "./logView";
import { ReviewStore } from "./reviews";
import { ViewsPanel } from "./viewsPanel";
import { ViewState, ViewStore, buildShareUrl, paramsToView, viewToParams } from "./views";
import { isGroupMode, isSortMode } from "./logOrder";

async function start(): Promise<void> {
  const mode = viewMode(location.search);
  if (mode !== "full") document.body.classList.add(`view-${mode}`);
  // The severity scale and the home site come from the backend, so everything
  // below (filter, legend, headline, colours) reflects YOUR data's scale.
  const cfg = await loadConfig();

  renderWorldMap(document.getElementById("map-bg")!, [{ label: cfg.home.label, lat: cfg.home.lat, lon: cfg.home.lon }]);
  mountDayNight(document.getElementById("map-bg")!);

  const wrap = document.getElementById("map-wrap")!;
  const mapViewport = document.getElementById("map-viewport")!;
  const canvas = document.getElementById("fx") as HTMLCanvasElement;
  const engine = new ArcEngine(canvas, wrap, mapViewport);
  const severityUi = new SeverityUi(engine);
  wireControls(engine, (file) => void openIngestDialog(file, { onLoaded: () => void monitor.refresh() }));
  const zoom = wireMapZoom(mapViewport, wrap);

  const detail = new DetailPanel();
  const focus = new FocusController(
    engine,
    detail,
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
  const trendStats = new TrendStats(60);
  new TrendPanel(trendStats, 60, document.getElementById("log-section"));

  // Says out loud whether the map is showing live, simulated, or no data. A
  // dead feed must never look like a quiet network (see status.ts).
  const monitor = new StatusMonitor(document.getElementById("topbar")!, wrap);

  const threat = new ThreatMonitor(cfg.threat_level ?? {});
  new Headline(talkerStats, TALKER_WINDOW_SEC, wrap, () => monitor.hasAssets, threat); // big counts; only visible in wall mode
  mountLogo(document.getElementById("topbar")!);
  new WallClock(wrap);

  const spotlight = new SpotlightController(() => monitor.hasAssets);
  new SpotlightView(spotlight, wrap);

  // Press K (or open with ?kiosk=1) for wall-display mode. If someone zooms or
  // pins an event and walks away, it returns to the world view on its own.
  // In wall mode a slow tour of the map starts after 30 s of nobody touching it.
  let tour: Tour | null = null;
  const kiosk = new Kiosk({ onIdle: () => { if (!tour?.isRunning) zoom.reset(); focus.clear(); } });
  tour = new Tour({
    active: () => kiosk.isActive && new URLSearchParams(location.search).get("tour") !== "0",
    idleMs: () => kiosk.idleMs,
    home: () => ({ name: cfg.home.label, lat: cfg.home.lat, lon: cfg.home.lon }),
    topCountries: () => talkerStats.topCountries(3, Date.now()).map((c) => ({ name: c.name, lat: c.lat, lon: c.lon })),
    focus: zoom.focusOn,
    reset: zoom.reset,
  });

  const history = new EventHistory();
  const replayer = new Replayer();
  const alerter = new Alerter(new AlertGate(() => monitor.hasAssets));

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
  const tools = new AnalystTools({
    history,
    replayer,
    onReplayEvent: (e) => { if (gate.passes(e)) engine.spawn(e); },
    alerter,
    anchor: document.getElementById("detail-section"),
    mapWrap: wrap,
  });
  const extraFields = new Set<string>(); // unmapped column names seen so far, to catch typos in the search bar
  const viewFilters = new ViewFilters(gate, knownGood, wrap, (name) => extraFields.has(name.toLowerCase()), document.getElementById("detail-section"));
  // Event log: ordering, pause, keyboard stepping, reviewed marks (logView.ts), and the Views panel.
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const reviews = new ReviewStore(storage);
  detail.reviews = reviews;
  detail.knownGood = knownGood;
  detail.onPivot = (field, value, and) => viewFilters.pivot(field, value, and);
  detail.links = cfg.links ?? [];
  const sourceHistory = new SourceHistoryStore();
  sourceHistory.onChange = () => detail.refresh();
  detail.history = sourceHistory;
  const sigNotes = new SignatureNotes();
  sigNotes.onChange = () => detail.refresh();
  detail.notes = sigNotes;
  void sigNotes.refresh();
  sigNotes.startPolling();

  // Incident response: shared response status per source, case timelines, campaigns, and the source dossier.
  const containment = new ContainmentStore();
  const caseStore = new CaseStore(storage);
  await containment.refresh();
  containment.startPolling();
  detail.containment = containment;
  detail.cases = caseStore;
  const statusMark = (ip: string | null): { short: string; label: string } | null => {
    const c = containment.get(ip);
    return c ? { short: STATUS_SHORT[c.status], label: STATUS_LABEL[c.status] } : null;
  };
  const exportContext = (): ExportContext => ({
    label: severityLabel,
    note: (k) => reviews.get(k)?.note ?? "",
    status: (ip) => { const c = containment.get(ip); return c ? { label: STATUS_LABEL[c.status], by: c.by, at: c.at, note: c.note } : null; },
  });
  const dossierDeps = {
    containment, cases: caseStore,
    onPivot: (f: PivotField, v: string, a: boolean) => viewFilters.pivot(f, v, a),
    onChange: () => { campaignPanel.redraw(); detail.refresh(); },
  };
  detail.onDossier = (ip) => openDossier(ip, dossierDeps);
  const campaignPanel = new CampaignPanel({ containment, cases: caseStore, search: (q) => viewFilters.search(q), dossier: (ip) => openDossier(ip, dossierDeps) });
  const casePanel = new CasePanel(caseStore, exportContext, (id) => { const q = queryForItemId(id); if (q) viewFilters.search(q); });
  const LOG_PREFS = "sightline:log-prefs";
  const currentView = (): ViewState => ({
    ...viewFilters.getView(),
    sort: logView.sort,
    group: logView.group,
    hideReviewed: logView.hideReviewed,
  });
  // Keep the address bar describing what is on screen, so a copied URL (or a bookmark) reopens it.
  const MANAGED = ["q", "chips", "mute", "sort", "group", "hide"];
  const syncUrl = (): void => {
    try {
      const url = new URL(location.href);
      for (const k of MANAGED) url.searchParams.delete(k);
      for (const [k, v] of Object.entries(viewToParams(currentView()))) url.searchParams.set(k, v);
      window.history.replaceState(null, "", url);
    } catch { /* read-only location: everything still works, it just is not bookmarkable */ }
  };
  const logView: LogView = new LogView(logList, document.getElementById("log-section")!, reviews, {
    onStep: (rowEl, group) => { if (focus.hasSelection) focus.select(group, rowEl); },
    onExpand: (rowEl, group) => focus.open(group, rowEl),
    onSettings: () => {
      try { storage?.setItem(LOG_PREFS, JSON.stringify({ sort: logView.sort, group: logView.group, hideReviewed: logView.hideReviewed })); } catch { /* ignore */ }
      syncUrl();
    },
  });
  {
    // A link's settings win; otherwise the analyst's own last choice.
    const params = new URLSearchParams(location.search);
    let prefs: { sort?: unknown; group?: unknown; hideReviewed?: unknown } = {};
    try { prefs = JSON.parse(storage?.getItem(LOG_PREFS) ?? "{}") ?? {}; } catch { /* ignore */ }
    const fromUrl = paramsToView(params);
    logView.setSettings({
      sort: params.has("sort") ? fromUrl.sort : isSortMode(prefs.sort) ? prefs.sort : "newest",
      group: params.has("group") ? fromUrl.group : isGroupMode(prefs.group) ? prefs.group : "none",
      hideReviewed: params.has("hide") ? fromUrl.hideReviewed : prefs.hideReviewed === true,
    });
  }
  detail.nav = {
    position: () => logView.position(focus.selectedElement),
    step: (dir) => {
      const next = logView.neighbor(focus.selectedElement, dir);
      const g = logView.groupOf(next);
      if (next && g) { focus.select(g, next); next.scrollIntoView({ block: "nearest" }); }
    },
    nextUnreviewed: () => {
      const next = logView.nextUnreviewed(focus.selectedElement);
      const g = logView.groupOf(next);
      if (next && g) { focus.select(g, next); next.scrollIntoView({ block: "nearest" }); }
    },
  };
  let layout: PanelLayout | null = null;
  const savedViews = new ViewStore(storage);
  new ViewsPanel({
    store: savedViews,
    getView: currentView,
    applyView: (v) => {
      viewFilters.setView(v);
      logView.setSettings({ sort: v.sort, group: v.group, hideReviewed: v.hideReviewed });
      syncUrl();
    },
    getLayout: () => layout!.getState(),
    applyLayout: (l) => layout?.applyState(l),
    openWindow: (m) => {
      const url = new URL(buildShareUrl(location.href, currentView()));
      url.searchParams.set("view", m);
      window.open(url.toString(), m === "console" ? "sightline-console" : "sightline-map", m === "console" ? "popup,width=560,height=940" : "");
    },
    mode,
    openSummary: () => openSummary({ reviews, onPivot: (f, v, a) => viewFilters.pivot(f, v, a) }),
  }).mount(document.getElementById("log-section"));
  campaignPanel.mount(document.getElementById("views-section"));
  casePanel.mount(document.getElementById("views-section"));
  campaignPanel.start();
  // A status set by anyone: relabel the log rows, the details and the campaigns.
  containment.onChange = () => {
    for (const [id, row] of logRows) { const g = logGroups.get(id); if (g) row.update(g); }
    detail.refresh();
    campaignPanel.redraw();
  };
  // "J" jumps into the log for keyboard stepping (not while typing, and not on the wall).
  window.addEventListener("keydown", (ev) => {
    if ((ev.key !== "j" && ev.key !== "J" && ev.key !== "p" && ev.key !== "P") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    if (document.body.classList.contains("kiosk") || detail.isExpanded) return;
    ev.preventDefault();
    if (ev.key === "j" || ev.key === "J") logView.focusFirst();
    else logView.setPaused(!logView.paused);
  });

  // Re-check what's already on screen when the mute switch, the search or the list changes.
  const recheckLog = (): void => {
    for (const [id, row] of logRows) {
      const g = logGroups.get(id);
      if (g) row.el.hidden = !gate.passes(g.event);
    }
    logView.recheckHidden();
    viewFilters.refresh();
    syncUrl();
  };
  layout = new PanelLayout(document.getElementById("sidebar")!); // fold / resize / reorder the right-hand panels; every panel exists by now
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
      if (!tools.replaying) engine.spawn(event); // renders identically, but stays out of the log/counters/stats
      return;
    }

    const now = Date.now();
    talkerStats.record(event, now);

    history.add(event, now);
    threat.record(event, now);
    trendStats.record(event, now);
    spotlight.offer(event, now);
    alerter.offer(event, now);

    const { group, isNew, arc } = aggregator.ingest(event, now);
    if (arc && !tools.replaying) engine.spawn(arc.event, arc.weight);

    if (isNew) {
      const row = appendLogEntry(group, (el) => focus.toggle(group, el), (el) => focus.open(group, el), (g) => ({ reviewed: reviews.isReviewed(g.key), note: reviews.hasNote(g.key), status: statusMark(g.event.src_ip) }));
      logRows.set(group.id, row);
      logGroups.set(group.id, group);
      logView.add(group, row);
    } else {
      logRows.get(group.id)?.update(group);
      logView.touched();
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
    for (const arc of aggregator.tick(Date.now())) if (!tools.replaying && gate.passes(arc.event)) engine.spawn(arc.event, arc.weight);
    if (++ticks % 20 === 0) {
      for (const id of [...logRows.keys()]) {
        if (!logView.has(id)) { logRows.delete(id); logGroups.delete(id); }
      }
    }
  }, 250);

  // Two windows (the map on one screen, the log on another) follow each other's pinned alert.
  const sync = new WindowSync((m) => {
    if (m.type === "unpin") { focus.clear(true); return; }
    const g = aggregator.find(m.event);
    if (!g) return; // this window has not seen that activity (or it has aged out)
    focus.select(g, logRows.get(g.id)?.el ?? document.createElement("div"), true);
    logRows.get(g.id)?.el.scrollIntoView({ block: "nearest" });
  });
  if (sync.available) {
    focus.onChange = (g) => sync.post(g ? { type: "pin", event: g.event } : { type: "unpin" });
  }

  // Click an arc or an endpoint on the map to pin it, same as clicking its log row.
  wireMapPick(wrap, mapViewport, canvas, (x, y) => {
    const ev = engine.eventAt(x, y);
    if (!ev) return;
    const g = aggregator.find(ev);
    if (!g) return;
    const row = logRows.get(g.id);
    focus.toggle(g, row?.el ?? document.createElement("div"));
    row?.el.scrollIntoView({ block: "nearest" });
  });

  setInterval(() => {
    const now = Date.now();
    spotlight.tick(now);
    tour?.tick(now);
  }, 1000);

  setInterval(() => {
    const now = performance.now();
    const eps = eventsThisWindow / ((now - windowStart) / 1000);
    statEps.textContent = eps.toFixed(1);
    eventsThisWindow = 0;
    windowStart = now;
  }, 500);
}

void start();
