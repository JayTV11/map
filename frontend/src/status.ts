import { TrafficEvent } from "./types";

/** Feed health, as the backend reports it (GET /api/status). */
export interface StatusPayload {
  server_time: string;
  poll_interval_seconds: number;
  elastic: {
    configured: boolean;
    last_poll_ok_at: string | null;
    last_event_at: string | null;
    error: string | null;
    error_since: string | null;
  };
  csv: { loaded: boolean; rows: number; filename: string | null; last_event_at: string | null };
  replay: { enabled: boolean; window_minutes: number };
}

export type FeedState =
  | "connecting" | "live" | "quiet" | "simulated" | "mixed"
  | "elastic-down" | "stalled" | "offline" | "no-feed";

export interface FeedView {
  state: FeedState;
  label: string;
  detail: string;
  tone: "ok" | "warn" | "bad" | "idle";
  /** Large on-screen banner text; null when the feed is live and healthy. */
  banner: string | null;
}

export interface FeedInputs {
  now: number;              // client clock, ms
  startedAt: number;
  wsConnected: boolean;
  wsEverConnected: boolean;
  status: StatusPayload | null;
  statusFetchedAt: number;  // client clock when `status` arrived
  statusFailures: number;   // consecutive failed /api/status fetches
  csvEventAt: number | null;
  elasticEventAt: number | null;
  replayAt: number | null;
}

const CSV_RECENT_MS = 30_000;
const ELASTIC_RECENT_MS = 120_000;
const QUIET_AFTER_MS = 90_000;
const REPLAY_RECENT_MS = 20_000;
const CONNECT_GRACE_MS = 5_000;
const STATUS_FAILURES_BEFORE_OFFLINE = 3;

export function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Decides what the status badge and banner say. Pure function of its
 *  inputs so every state can be tested.
 *
 *  The rule it enforces: whenever what's on screen is NOT live, healthy
 *  data, say so loudly. A dead feed, a CSV demo and replayed alerts all
 *  look like (or are indistinguishable from) a calm or busy real network. */
export function computeFeedView(i: FeedInputs): FeedView {
  const s = i.status;

  const serverUnreachable =
    i.statusFailures >= STATUS_FAILURES_BEFORE_OFFLINE ||
    (!i.wsConnected && (i.wsEverConnected || i.now - i.startedAt > CONNECT_GRACE_MS));
  if (serverUnreachable) {
    return {
      state: "offline", tone: "bad", label: "OFFLINE",
      detail: "Lost connection to the Traffic Map server \u2014 retrying",
      banner: "NO LIVE DATA \u2014 DISPLAY DISCONNECTED",
    };
  }
  if (!s || !i.wsConnected) {
    return { state: "connecting", tone: "idle", label: "CONNECTING", detail: "Contacting the Traffic Map server", banner: null };
  }

  // Server clock, extrapolated, so ages are right even if this machine's clock is off.
  const serverNow = Date.parse(s.server_time) + (i.now - i.statusFetchedAt);
  const age = (iso: string | null): number | null => (iso ? Math.max(0, serverNow - Date.parse(iso)) : null);

  const csvAge = Math.min(
    i.csvEventAt !== null ? i.now - i.csvEventAt : Infinity,
    age(s.csv.last_event_at) ?? Infinity,
  );
  const csvRecent = csvAge < CSV_RECENT_MS;
  const realAge = Math.min(
    i.elasticEventAt !== null ? i.now - i.elasticEventAt : Infinity,
    age(s.elastic.last_event_at) ?? Infinity,
  );
  const elasticRecent = realAge < ELASTIC_RECENT_MS;
  const replayRecent = i.replayAt !== null && i.now - i.replayAt < REPLAY_RECENT_MS;
  const simNote = csvRecent ? " \u00b7 simulated data is showing" : "";

  if (s.elastic.configured && s.elastic.error) {
    const since = s.elastic.error_since ? ` since ${clock(s.elastic.error_since)}` : "";
    return {
      state: "elastic-down", tone: "bad", label: "FEED ERROR",
      detail: `Elastic ${s.elastic.error}${since} \u2014 live alerts are NOT being shown${simNote}`,
      banner: `NO LIVE DATA \u2014 ELASTIC ${s.elastic.error.toUpperCase()}`,
    };
  }

  if (s.elastic.configured && s.elastic.last_poll_ok_at) {
    const pollAge = age(s.elastic.last_poll_ok_at) ?? 0;
    if (pollAge > (s.poll_interval_seconds * 3 + 10) * 1000) {
      return {
        state: "stalled", tone: "bad", label: "FEED STALLED",
        detail: `No successful Elastic poll for ${fmtAge(pollAge)}${simNote}`,
        banner: "NO LIVE DATA \u2014 FEED STALLED",
      };
    }
  }

  if (csvRecent && s.elastic.configured && elasticRecent) {
    return {
      state: "mixed", tone: "warn", label: "MIXED",
      detail: "Simulated data is being mixed in with live alerts",
      banner: "SIMULATED DATA MIXED WITH LIVE ALERTS",
    };
  }
  if (csvRecent) {
    const from = s.csv.filename ? ` from ${s.csv.filename}` : "";
    return {
      state: "simulated", tone: "warn", label: "SIMULATED",
      detail: `Demo data${from} \u2014 not real traffic${s.elastic.configured ? " \u00b7 Elastic connected but quiet" : ""}`,
      banner: "SIMULATED DATA \u2014 NOT LIVE TRAFFIC",
    };
  }

  if (s.elastic.configured) {
    if (!s.elastic.last_poll_ok_at) {
      return { state: "connecting", tone: "idle", label: "CONNECTING", detail: "Waiting for the first Elastic poll", banner: null };
    }
    if (realAge === Infinity) {
      return { state: "live", tone: "ok", label: "LIVE", detail: "Elastic connected \u00b7 waiting for the first alert", banner: null };
    }
    if (realAge < QUIET_AFTER_MS) {
      return { state: "live", tone: "ok", label: "LIVE", detail: `Elastic \u00b7 last alert ${fmtAge(realAge)} ago`, banner: null };
    }
    return {
      state: "quiet", tone: "ok", label: replayRecent ? "LIVE \u00b7 QUIET" : "LIVE",
      detail: `No new alerts for ${fmtAge(realAge)}` +
        (replayRecent ? " \u00b7 arcs shown are replays of recent alerts" : ""),
      banner: null,
    };
  }

  return {
    state: "no-feed", tone: "idle", label: "NO FEED",
    detail: "Elastic isn't configured \u2014 upload a CSV for demo data",
    banner: "NO DATA SOURCE CONNECTED",
  };
}

/** Polls /api/status, tracks what the socket has actually delivered, and
 *  renders the badge (in the top bar) and the big banner (over the map). */
export class StatusMonitor {
  private status: StatusPayload | null = null;
  private statusFetchedAt = 0;
  private failures = 0;
  private wsConnected = false;
  private wsEverConnected = false;
  private readonly startedAt = Date.now();
  private csvAt: number | null = null;
  private elasticAt: number | null = null;
  private replayAt: number | null = null;

  private pill = document.createElement("span");
  private label = document.createElement("span");
  private detail = document.createElement("span");
  private banner = document.createElement("div");
  private clearBtn: HTMLButtonElement | null = null;
  private timers: number[] = [];

  constructor(topbar: HTMLElement, wrap: HTMLElement, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    const box = document.createElement("span");
    box.id = "feed-status";
    this.pill.className = "feed-pill idle";
    const dot = document.createElement("span");
    dot.className = "feed-dot";
    this.pill.append(dot, this.label);
    this.detail.className = "feed-detail";
    box.append(this.pill, this.detail);
    topbar.append(box);

    this.banner.id = "feed-banner";
    this.banner.hidden = true;
    this.banner.setAttribute("role", "alert");
    wrap.append(this.banner);

    this.addClearButton();
    this.render();
    void this.refresh();
    this.timers.push(window.setInterval(() => void this.refresh(), 5000));
    this.timers.push(window.setInterval(() => this.render(), 1000));
  }

  setWsConnected(connected: boolean): void {
    this.wsConnected = connected;
    if (connected) this.wsEverConnected = true;
    this.render();
  }

  /** Call for EVERY event off the socket (replays included -- they're how
   *  we know the arcs on screen may not be new). */
  noteEvent(e: TrafficEvent): void {
    const now = Date.now();
    if (e.is_replay) this.replayAt = now;
    else if (e.source === "csv") this.csvAt = now;
    else this.elasticAt = now;
  }

  get view(): FeedView {
    return computeFeedView({
      now: Date.now(), startedAt: this.startedAt,
      wsConnected: this.wsConnected, wsEverConnected: this.wsEverConnected,
      status: this.status, statusFetchedAt: this.statusFetchedAt, statusFailures: this.failures,
      csvEventAt: this.csvAt, elasticEventAt: this.elasticAt, replayAt: this.replayAt,
    });
  }

  async refresh(): Promise<void> {
    const ctl = new AbortController();
    const timeout = window.setTimeout(() => ctl.abort(), 4000);
    try {
      const resp = await this.fetchImpl("/api/status", { cache: "no-store", signal: ctl.signal });
      if (!resp.ok) throw new Error(String(resp.status));
      this.status = (await resp.json()) as StatusPayload;
      this.statusFetchedAt = Date.now();
      this.failures = 0;
    } catch {
      this.failures += 1;
    } finally {
      window.clearTimeout(timeout);
    }
    this.render();
  }

  render(): void {
    const v = this.view;
    this.pill.className = `feed-pill ${v.tone}`;
    this.label.textContent = v.label;
    this.detail.textContent = v.detail;
    this.banner.hidden = v.banner === null;
    this.banner.textContent = v.banner ?? "";
    this.banner.className = v.tone;
    if (this.clearBtn) this.clearBtn.hidden = !(this.status?.csv.loaded);
  }

  dispose(): void {
    for (const t of this.timers) window.clearInterval(t);
  }

  /** "Clear simulated data" in the Data Source section: the way to go from a
   *  demo back to live data without restarting the server. */
  private addClearButton(): void {
    const section = document.getElementById("csv-file")?.closest(".panel-section");
    if (!section) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.style.marginTop = "8px";
    btn.textContent = "Clear simulated data";
    btn.hidden = true;
    btn.addEventListener("click", async () => {
      try { await this.fetchImpl("/api/upload", { method: "DELETE" }); } catch { /* status poll will show the truth */ }
      this.csvAt = null;
      await this.refresh();
    });
    section.append(btn);
    this.clearBtn = btn;
  }
}
