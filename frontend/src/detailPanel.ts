import { GroupSummary } from "./aggregator";
import { AssetRef, SEVERITY_COLOR, TrafficEvent } from "./types";

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

  constructor() {
    document.getElementById("detail-close")!.addEventListener("click", () => this.hide());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.section.hidden) this.hide();
    });
  }

  /** Hides the panel. `notify` is false when the caller (FocusController)
   *  is itself the one clearing selection, so onClose doesn't call back
   *  into it. The x button and Esc use the default and DO notify, which
   *  is how closing the panel also unpins the event on the map. */
  hide(notify = true): void {
    const wasOpen = !this.section.hidden;
    this.section.hidden = true;
    if (notify && wasOpen) this.onClose?.();
  }

  /** `summary` is present when the event stands for a group of repeats
   *  (see aggregator.ts); it adds the count, first/last seen and the
   *  distinct destination ports hit. */
  show(e: TrafficEvent, summary?: GroupSummary): void {
    this.section.hidden = false;
    this.body.replaceChildren();

    const sig = document.createElement("div");
    sig.className = "detail-sig";
    sig.textContent = e.signature ?? "(no signature)";
    const badge = document.createElement("span");
    badge.className = "detail-badge";
    badge.textContent = e.severity;
    badge.style.background = SEVERITY_COLOR[e.severity];
    this.body.append(badge, sig);

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
      ["SID", e.signature_id],
      ["Time", grouped ? null : new Date(e.alert_time ?? e.timestamp).toLocaleString()],
      ["First seen", grouped ? new Date(summary!.firstSeen).toLocaleString() : null],
      ["Last seen", grouped ? new Date(summary!.lastSeen).toLocaleString() : null],
      ["Source geo", `${e.src_lat.toFixed(2)}, ${e.src_lon.toFixed(2)}`],
      ["Dest geo", `${e.dst_lat.toFixed(2)}, ${e.dst_lon.toFixed(2)}`],
      ["Feed", e.source === "elastic" ? "Live (Elastic)" : "Simulated (CSV)"],
    ];
    const dl = document.createElement("dl");
    dl.className = "detail-grid";
    for (const [k, v] of rows) {
      if (v === null || v === "") continue;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
    this.body.append(dl);

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
      const text = `${e.signature ?? "alert"} | ${endpoint(e.src_ip, e.src_port)} -> ${endpoint(e.dst_ip, e.dst_port)} | ${e.severity} | ${e.alert_time ?? e.timestamp}${grouped ? ` | x${summary!.count}` : ""}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy flow"; }, 1200);
    });
    actions.append(copy);
    this.body.append(actions);
  }
}
