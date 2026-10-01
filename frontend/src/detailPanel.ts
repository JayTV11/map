import { SEVERITY_COLOR, TrafficEvent } from "./types";

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

  show(e: TrafficEvent): void {
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

    const rows: [string, string | null][] = [
      ["Flow", `${endpoint(e.src_ip, e.src_port)} → ${endpoint(e.dst_ip, e.dst_port)}`],
      ["Protocol", e.protocol ? e.protocol.toUpperCase() : null],
      ["Action", e.action],
      ["Category", e.category],
      ["SID", e.signature_id],
      ["Time", new Date(e.alert_time ?? e.timestamp).toLocaleString()],
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
      const text = `${e.signature ?? "alert"} | ${endpoint(e.src_ip, e.src_port)} -> ${endpoint(e.dst_ip, e.dst_port)} | ${e.severity} | ${e.alert_time ?? e.timestamp}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy flow"; }, 1200);
    });
    actions.append(copy);
    this.body.append(actions);
  }
}
