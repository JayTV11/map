import { CaseStore } from "./cases";
import { Campaign, campaignId, campaignQuery, campaignText, campaignTitle, CampaignData } from "./campaigns";
import { ContainmentStore, STATUS_LABEL } from "./containment";
import { paintSeverity, severityLabel, severityLevels } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: names come from the network
  return e;
}

const WINDOWS = [30, 60, 180];

/** The Campaigns panel: activity that looks coordinated in the last while, worst first. One source sweeping many
 *  targets, or many sources hitting one target with the same alert. Asked of the server, which holds more history
 *  than the log does. */
export class CampaignPanel {
  readonly section = el("div", "panel-section");
  private list = el("div", "camp-list");
  private note = el("div", "vw-hint");
  private minutes = 60;
  private timer: number | undefined;
  private last: CampaignData | null = null;
  private failed = false;

  constructor(private deps: {
    containment: ContainmentStore;
    cases: CaseStore;
    search(query: string): void;
    dossier(ip: string): void;
  }) {
    this.section.id = "campaigns-section";
    this.section.dataset.collapsed = "1";
    this.section.append(el("h2", undefined, "Campaigns"));
    const win = el("div", "camp-win");
    for (const m of WINDOWS) {
      const b = el("button", "btn sm-hour", m < 60 ? `${m}m` : `${m / 60}h`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(m === this.minutes));
      b.addEventListener("click", () => { this.minutes = m; win.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); void this.refresh(); });
      win.append(b);
    }
    this.section.append(win, this.list, this.note);
  }

  mount(anchor: HTMLElement | null): void {
    if (anchor) anchor.before(this.section);
    else document.getElementById("sidebar")?.append(this.section);
  }

  start(everyMs = 15_000): void {
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), everyMs);
  }
  stop(): void { if (this.timer !== undefined) window.clearInterval(this.timer); this.timer = undefined; }

  /** Redraw from what we have (e.g. a status changed). */
  redraw(): void { this.render(); }

  async refresh(): Promise<void> {
    try {
      const resp = await fetch(`/api/campaigns?minutes=${this.minutes}`, { cache: "no-store" });
      if (resp.status === 404) { this.section.hidden = true; return; } // an older backend
      if (!resp.ok) throw new Error(String(resp.status));
      this.last = (await resp.json()) as CampaignData;
      this.failed = false;
    } catch { this.failed = true; }
    this.render();
  }

  private render(): void {
    const d = this.last;
    const n = d?.campaigns.length ?? 0;
    this.section.querySelector("h2")!.textContent = n > 0 ? `Campaigns · ${n}` : "Campaigns";
    if (!d) { this.list.replaceChildren(el("div", "vw-empty", this.failed ? "Couldn’t reach the server." : "Looking…")); return; }
    if (d.campaigns.length === 0) this.list.replaceChildren(el("div", "vw-empty", `Nothing looks coordinated in the last ${this.minutes < 60 ? `${this.minutes} minutes` : `${this.minutes / 60} hour${this.minutes > 60 ? "s" : ""}`}.`));
    else this.list.replaceChildren(...d.campaigns.map((c) => this.row(c)));
    const since = d.since ? new Date(d.since) : null;
    const partial = since && since.getTime() > Date.now() - this.minutes * 60_000;
    this.note.textContent = `${d.source === "simulated" ? "Demo data. " : ""}${partial ? `This server only started counting at ${since!.toLocaleTimeString()}. ` : ""}` +
      "A guide to what belongs together, not proof of who is behind it.";
  }

  private row(c: Campaign): HTMLElement {
    const row = el("div", "camp-row");
    const dot = el("span", "sev-dot");
    paintSeverity(dot, c.severity);
    dot.title = severityLabel(c.severity);
    const main = el("button", "camp-main");
    main.type = "button";
    main.title = "Filter the screen to this campaign";
    main.append(el("span", "camp-title", campaignTitle(c)),
      el("span", "camp-sub", c.kind === "fan-in" ? `${c.signature} · ${c.events.toLocaleString()} events` : `${c.signatures.map((s) => s.name).slice(0, 2).join(", ")} · ${c.events.toLocaleString()} events`));
    main.addEventListener("click", () => this.deps.search(campaignQuery(c)));
    row.append(dot, main);

    // A sweeping source with no recorded response, and the worst severity: the one to look at first.
    if (c.kind === "fan-out") {
      const st = this.deps.containment.get(c.src_ip);
      if (st) row.append(el("span", `cs-chip cs-${st.status}`, STATUS_LABEL[st.status]));
      else if (c.severity === severityLevels()[0]?.id) row.append(el("span", "cs-chip cs-needs", "No status"));
    }
    const tools = el("div", "camp-tools");
    const add = el("button", "btn camp-btn", this.deps.cases.has(campaignId(c)) ? "In case ✓" : "+ Case");
    add.type = "button";
    add.addEventListener("click", () => {
      const ok = this.deps.cases.add({ kind: "summary", id: campaignId(c), title: campaignTitle(c), text: campaignText(c, severityLabel), severity: c.severity,
        first: Date.parse(c.first), last: Date.parse(c.last), addedAt: Date.now() });
      add.textContent = ok ? "In case ✓" : "Case is full";
    });
    tools.append(add);
    if (c.kind === "fan-out") {
      const dos = el("button", "btn camp-btn", "Dossier");
      dos.type = "button";
      dos.addEventListener("click", () => this.deps.dossier(c.src_ip));
      tools.append(dos);
    }
    row.append(tools);
    return row;
  }
}
