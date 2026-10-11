import { GroupSummary } from "./aggregator";
import { AssetRef, severityColor, severityLabel, TrafficEvent } from "./types";

/** True for RFC1918 / loopback / link-local IPv4 -- pivots to external
 *  lookup sites are only offered for public addresses so internal IPs
 *  aren't one misclick away from being sent to a third party. */
function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return true; // IPv6 / unparseable: don't offer a pivot
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function endpoint(ip: string | null, port: number | null): string {
  if (!ip) return "?";
  return port !== null ? `${ip}:${port}` : ip;
}

/** The YAML for one known-good entry, indented to paste under `sources:`. The IP is quoted-safe: it comes from the network. */
export function knownGoodEntry(ip: string, name: string | null): string {
  const safeIp = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(ip) ? ip : JSON.stringify(ip);
  const note = name ? `note: ${JSON.stringify(name)}` : "note: ";
  return `  - ip: ${safeIp}\n    ${note}`;
}

function assetText(a: AssetRef | null | undefined): string | null {
  return a ? `${a.name} (${a.criticality} priority)` : null;
}

const DIRECTION_TEXT = {
  inbound: "Inbound \u2014 from outside to one of our systems",
  outbound: "Outbound \u2014 from one of our systems to outside",
  internal: "Internal \u2014 between two of our systems",
} as const;

function formatPorts(ports: number[], limit = 8): string {
  const shown = ports.slice(0, limit).join(", ");
  return ports.length > limit ? `${shown} (+${ports.length - limit} more)` : shown;
}

export class DetailPanel {
  private section = document.getElementById("detail-section")!;
  private body = document.getElementById("detail-body")!;
  onClose?: () => void;
  private current: { e: TrafficEvent; summary?: GroupSummary } | null = null;
  private overlay: HTMLElement | null = null;
  private lastFocus: HTMLElement | null = null;

  constructor() {
    document.getElementById("detail-close")!.addEventListener("click", () => this.hide());
    document.getElementById("detail-expand")!.addEventListener("click", () => this.expand());
    // Capture phase: with the large window open, Esc closes just that window
    // (not also the panel and the pin behind it).
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.overlay) { e.stopPropagation(); e.preventDefault(); this.collapse(); return; }
      if (!this.section.hidden) this.hide();
    }, true);
  }

  get isExpanded(): boolean { return this.overlay !== null; }

  /** Opens the pinned event in a large window with every field, the extra source
   *  fields and the raw record. Stays in step as more repeats join the group. */
  expand(): void {
    if (!this.current || this.overlay) return;
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.className = "popout-overlay";
    overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) this.collapse(); });
    const dialog = document.createElement("div");
    dialog.className = "popout-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Alert details");
    overlay.append(dialog);
    document.body.append(overlay);
    this.overlay = overlay;
    this.renderPopout();
    dialog.querySelector<HTMLElement>(".popout-x")?.focus();
  }

  collapse(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.lastFocus?.focus?.();
    this.lastFocus = null;
  }

  private renderPopout(): void {
    const dialog = this.overlay?.querySelector<HTMLElement>(".popout-dialog");
    if (!dialog || !this.current) return;
    const { e, summary } = this.current;
    const head = document.createElement("div");
    head.className = "popout-head";
    const title = document.createElement("h2");
    title.textContent = "Alert Detail";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "popout-x";
    x.setAttribute("aria-label", "Close");
    x.textContent = "\u00d7";
    x.addEventListener("click", () => this.collapse());
    head.append(title, x);
    const body = document.createElement("div");
    body.className = "popout-body";
    const scroll = dialog.querySelector<HTMLElement>(".popout-body")?.scrollTop ?? 0;
    this.render(body, e, summary, true);
    dialog.replaceChildren(head, body);
    body.scrollTop = scroll;
  }

  /** Hides the panel. `notify` is false when the caller (FocusController)
   *  is itself the one clearing selection, so onClose doesn't call back
   *  into it. The x button and Esc use the default and DO notify, which
   *  is how closing the panel also unpins the event on the map. */
  hide(notify = true): void {
    const wasOpen = !this.section.hidden;
    this.section.hidden = true;
    this.current = null;
    this.collapse();
    if (notify && wasOpen) this.onClose?.();
  }

  private anomalyBlock(a: NonNullable<TrafficEvent["anomaly"]>): HTMLElement {
    const box = document.createElement("div");
    box.className = `detail-anomaly an-${a.level}${a.learning ? " an-learning" : ""}`;
    const head = document.createElement("div");
    head.className = "an-head";
    const label = { usual: "Usual", uncommon: "Uncommon", unusual: "Unusual" }[a.level];
    head.textContent = `Unusualness ${a.score}/100 \u00b7 ${label}${a.learning ? " (provisional, still learning this network)" : ""}`;
    const list = document.createElement("ul");
    for (const r of a.reasons) {
      const li = document.createElement("li");
      li.textContent = r;
      list.append(li);
    }
    box.append(head, list);
    return box;
  }

  /** `summary` is present when the event stands for a group of repeats
   *  (see aggregator.ts); it adds the count, first/last seen and the
   *  distinct destination ports hit. */
  show(e: TrafficEvent, summary?: GroupSummary): void {
    const wasHidden = this.section.hidden;
    this.current = { e, summary };
    this.section.hidden = false;
    if (wasHidden) this.section.scrollIntoView({ block: "nearest" }); // the column may be scrolled; an opened detail must be seen
    this.render(this.body, e, summary, false);
    if (this.overlay) this.renderPopout();
  }

  /** Draws one event into `target`. `large` adds the full source record for the pop-out window. */
  private render(target: HTMLElement, e: TrafficEvent, summary: GroupSummary | undefined, large: boolean): void {
    target.replaceChildren();
    const body = target;
    target.classList.toggle("detail-large", large);

    const sig = document.createElement("div");
    sig.className = "detail-sig";
    sig.textContent = e.signature ?? "(no signature)";
    const badge = document.createElement("span");
    badge.className = "detail-badge";
    badge.textContent = severityLabel(e.severity);
    badge.style.background = severityColor(e.severity);
    body.append(badge, sig);
    if (e.anomaly) body.append(this.anomalyBlock(e.anomaly));

    const grouped = summary !== undefined && summary.count > 1;
    const rows: [string, string | null][] = [
      ["Flow", `${endpoint(e.src_ip, e.src_port)} \u2192 ${endpoint(e.dst_ip, e.dst_port)}`],
      ["Source system", assetText(e.src_asset)],
      ["Target system", assetText(e.dst_asset)],
      ["Direction", e.direction ? DIRECTION_TEXT[e.direction] : null],
      ["Count", grouped ? `${summary!.count.toLocaleString()} events` : null],
      ["Dest ports", grouped && summary!.dstPorts.length > 1 ? formatPorts(summary!.dstPorts) : null],
      ["Protocol", e.protocol ? e.protocol.toUpperCase() : null],
      ["Action", e.action],
      ["Category", e.category],
      ["Rule ID", e.signature_id],
      ["Time", grouped ? null : new Date(e.alert_time ?? e.timestamp).toLocaleString()],
      ["First seen", grouped ? new Date(summary!.firstSeen).toLocaleString() : null],
      ["Last seen", grouped ? new Date(summary!.lastSeen).toLocaleString() : null],
      ["Source geo", `${e.src_lat.toFixed(2)}, ${e.src_lon.toFixed(2)}`],
      ["Dest geo", `${e.dst_lat.toFixed(2)}, ${e.dst_lon.toFixed(2)}`],
      ["Location note", e.geo_note],
      ["Feed", e.source === "elastic" ? "Live (Elastic)" : "Simulated (uploaded data)"],
    ];
    const dl = document.createElement("dl");
    dl.className = "detail-grid";
    for (const [k, v] of rows) {
      if (v === null || v === "") continue;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
    body.append(dl);

    // Anything in the source data that didn't map to a field above (collapsed by default).
    const extraKeys = Object.keys(e.extra ?? {});
    if (extraKeys.length > 0) {
      const details = document.createElement("details");
      details.className = "detail-extra";
      details.open = large;
      const summaryEl = document.createElement("summary");
      summaryEl.textContent = `Other fields in the data (${extraKeys.length})`;
      const extraGrid = document.createElement("dl");
      extraGrid.className = "detail-grid";
      for (const k of extraKeys) {
        const dt = document.createElement("dt"); dt.textContent = k; dt.title = k;
        const dd = document.createElement("dd"); dd.textContent = e.extra[k];
        extraGrid.append(dt, dd);
      }
      details.append(summaryEl, extraGrid);
      body.append(details);
    }

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const link = (label: string, href: string) => {
      const a = document.createElement("a");
      a.className = "btn";
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      actions.append(a);
    };
    if (e.kibana_url) link("Open in Kibana ↗", e.kibana_url);
    if (e.src_ip && !isPrivateIp(e.src_ip)) {
      link("VirusTotal (source IP) ↗", `https://www.virustotal.com/gui/ip-address/${encodeURIComponent(e.src_ip)}`);
      link("AbuseIPDB (source IP) ↗", `https://www.abuseipdb.com/check/${encodeURIComponent(e.src_ip)}`);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn";
    copy.textContent = "Copy flow";
    copy.addEventListener("click", async () => {
      const text = `${e.signature ?? "alert"} | ${endpoint(e.src_ip, e.src_port)} -> ${endpoint(e.dst_ip, e.dst_port)} | ${severityLabel(e.severity)} | ${e.alert_time ?? e.timestamp}${grouped ? ` | x${summary!.count}` : ""}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy flow"; }, 1200);
    });
    actions.append(copy);

    // A ready-to-paste line for backend/known_good.yaml, for sources that turn out to be harmless.
    if (e.src_ip) {
      const kg = document.createElement("button");
      kg.type = "button";
      kg.className = "btn";
      kg.textContent = "Copy as known-good entry";
      kg.title = "Copies a line to paste under sources: in backend/known_good.yaml";
      kg.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(knownGoodEntry(e.src_ip!, e.src_asset?.name ?? null)); kg.textContent = "Copied"; }
        catch { kg.textContent = "Copy failed"; }
        setTimeout(() => { kg.textContent = "Copy as known-good entry"; }, 1400);
      });
      actions.append(kg);
    }
    body.append(actions);

    if (large) {
      const raw = document.createElement("details");
      raw.className = "detail-extra detail-raw";
      raw.open = true;
      const rs = document.createElement("summary");
      rs.textContent = "Raw event (JSON)";
      const pre = document.createElement("pre");
      const json = JSON.stringify(e, null, 2);
      pre.textContent = json;
      const rc = document.createElement("button");
      rc.type = "button";
      rc.className = "btn";
      rc.textContent = "Copy JSON";
      rc.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(json); rc.textContent = "Copied"; }
        catch { rc.textContent = "Copy failed"; }
        setTimeout(() => { rc.textContent = "Copy JSON"; }, 1200);
      });
      raw.append(rs, pre, rc);
      body.append(raw);
    }
  }
}
