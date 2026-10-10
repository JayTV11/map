import { Alerter } from "./alerts";
import { downloadCsv, eventsToCsv } from "./csv";
import { EventHistory, Replayer } from "./replay";
import { TrafficEvent } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A sidebar section whose heading folds it open and shut. */
function foldable(id: string, title: string, collapsed: boolean): { section: HTMLElement; body: HTMLElement } {
  const section = el("div", "panel-section foldable");
  section.id = id;
  const h2 = el("h2", "fold-head", title);
  h2.tabIndex = 0;
  h2.setAttribute("role", "button");
  const body = el("div", "fold-body");
  const set = (c: boolean) => {
    section.classList.toggle("collapsed", c);
    h2.setAttribute("aria-expanded", String(!c));
  };
  h2.addEventListener("click", () => set(!section.classList.contains("collapsed")));
  h2.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(!section.classList.contains("collapsed")); }
  });
  set(collapsed);
  section.append(h2, body);
  return { section, body };
}

const WINDOWS: [string, number][] = [["1 min", 60_000], ["5 min", 300_000], ["10 min", 600_000]];
const SPEEDS: [string, number][] = [["5×", 5], ["15×", 15], ["60×", 60]];

export interface ToolsOptions {
  history: EventHistory;
  replayer: Replayer;
  /** Draws one replayed event (the caller applies the search/mute filters). */
  onReplayEvent: (e: TrafficEvent) => void;
  alerter: Alerter;
  /** Section to insert the new panels in front of. */
  anchor: HTMLElement | null;
  /** The map, for the "replaying" chip. */
  mapWrap: HTMLElement;
}

/** The analyst-only sidebar tools: replay the last few minutes, export them as CSV, and
 *  switch on alerts. Folded shut by default so they don't crowd the log. Hidden in wall
 *  mode (wall.css only keeps the talkers, trend, log and detail panels). */
export class AnalystTools {
  private replayBtn = el("button", "btn", "▶ Play replay");
  private replayInfo = el("div", "tool-info");
  private exportBtn = el("button", "btn", "Export CSV");
  private winSel = el("select");
  private speedSel = el("select");
  private chip = el("div", "replay-chip");
  private alertInfo = el("div", "tool-info");
  private alertBox = document.createElement("input");
  private timer = 0;

  constructor(private o: ToolsOptions) {
    const replay = foldable("replay-section", "Replay & Export", true);
    const alerts = foldable("alerts-section", "Alerts", true);

    for (const [label, ms] of WINDOWS) this.winSel.append(new Option(label, String(ms), false, ms === 300_000));
    for (const [label, x] of SPEEDS) this.speedSel.append(new Option(label, String(x), false, x === 15));
    this.winSel.setAttribute("aria-label", "How far back to replay");
    this.speedSel.setAttribute("aria-label", "Replay speed");

    const r1 = el("div", "row");
    r1.append(el("label", undefined, "Replay the last"), this.winSel);
    const r2 = el("div", "row");
    r2.append(el("label", undefined, "Speed"), this.speedSel);
    this.replayBtn.type = "button";
    this.exportBtn.type = "button";
    this.replayBtn.addEventListener("click", () => this.toggleReplay());
    this.exportBtn.addEventListener("click", () => this.exportCsv());
    const actions = el("div", "tool-actions");
    actions.append(this.replayBtn, this.exportBtn);
    replay.body.append(r1, r2, actions, this.replayInfo);

    const row = el("div", "row");
    const label = el("label", undefined, "Alert on top-severity hits to key systems");
    label.htmlFor = "alert-toggle";
    const sw = el("label", "switch");
    this.alertBox.type = "checkbox";
    this.alertBox.id = "alert-toggle";
    sw.append(this.alertBox, el("span", "slider-toggle"));
    row.append(label, sw);
    this.alertBox.addEventListener("change", () => void o.alerter.setEnabled(this.alertBox.checked));
    o.alerter.onChange = () => this.renderAlerts();
    alerts.body.append(row, this.alertInfo);

    this.chip.id = "replay-chip";
    this.chip.hidden = true;
    o.mapWrap.append(this.chip);

    if (o.anchor) { o.anchor.before(replay.section, alerts.section); }
    else document.body.append(replay.section, alerts.section);

    this.renderReplay();
    this.renderAlerts();
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  dispose(): void { window.clearInterval(this.timer); }

  /** True while a replay is drawing, so live arcs can step aside. */
  get replaying(): boolean { return this.o.replayer.playing; }

  toggleReplay(now = Date.now()): void {
    if (this.o.replayer.playing) {
      this.o.replayer.stop();
    } else {
      const ms = Number(this.winSel.value);
      const items = this.o.history.last(ms, now);
      if (!this.o.replayer.start(items, Number(this.speedSel.value), now)) {
        this.replayInfo.textContent = "Nothing to replay yet — this screen hasn't seen any events in that window.";
        return;
      }
    }
    this.renderReplay();
  }

  exportCsv(now = Date.now()): void {
    const items = this.o.history.last(10 * 60_000, now);
    if (items.length === 0) { this.replayInfo.textContent = "Nothing to export yet."; return; }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadCsv(`sightline-events-${stamp}.csv`, eventsToCsv(items));
    this.replayInfo.textContent = `Exported ${items.length.toLocaleString()} events (what this screen saw in the last 10 min, before any filter).`;
  }

  /** Drives playback; public so tests can step it. */
  tick(now = Date.now()): void {
    if (!this.o.replayer.playing) return;
    for (const b of this.o.replayer.tick(now)) this.o.onReplayEvent(b.event);
    this.renderReplay(); // also what hides the chip once the last event has played
  }

  private renderReplay(): void {
    const r = this.o.replayer;
    const playing = r.playing;
    this.replayBtn.textContent = playing ? "■ Stop replay" : "▶ Play replay";
    this.winSel.disabled = this.speedSel.disabled = playing;
    this.chip.hidden = !playing;
    if (playing) {
      const pct = Math.round(r.progress * 100);
      const win = WINDOWS.find(([, ms]) => String(ms) === this.winSel.value)?.[0] ?? "";
      this.chip.textContent = `⏪ REPLAY · last ${win} · ${this.speedSel.selectedOptions[0]?.text ?? ""} · ${pct}%`;
      this.replayInfo.textContent = "Live arcs are paused on the map while the replay plays. The log and counters keep updating.";
    } else if (this.replayInfo.textContent?.startsWith("Live arcs are paused")) {
      this.replayInfo.textContent = "";
    }
  }

  private renderAlerts(): void {
    const a = this.o.alerter;
    this.alertBox.checked = a.enabled;
    this.alertInfo.textContent =
      !a.enabled ? "Off. Turning it on plays a test beep and asks your browser for permission to show notifications."
      : a.permission === "on" ? "On: beep and desktop notification (at most one every 15 seconds)."
      : "On: beep only. Notifications are blocked or unavailable in this browser.";
  }
}
