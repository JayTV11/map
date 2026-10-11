import { TrafficEvent } from "./types";

/** Configurable ticket/tool links (backend/config.yaml `links:`). The server has already checked the template;
 *  everything is checked again here because the filled-in URL ends up in an <a href>. Pure: no DOM. */

export interface LinkSpec {
  label: string;
  url: string;
  public_only?: boolean;
}

/** True for RFC1918 / loopback / link-local IPv4. IPv6 and anything unparseable counts as private (no outside lookups). */
export function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return true;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const PH = /\{([a-z_]+)\}/g;

function valueOf(e: TrafficEvent, name: string): string {
  switch (name) {
    case "src_ip": return e.src_ip ?? "";
    case "dst_ip": return e.dst_ip ?? "";
    case "src_port": return e.src_port === null ? "" : String(e.src_port);
    case "dst_port": return e.dst_port === null ? "" : String(e.dst_port);
    case "signature": return e.signature ?? "";
    case "signature_id": return e.signature_id ?? "";
    case "severity": return e.severity;
    case "category": return e.category ?? "";
    case "time": return e.alert_time ?? e.timestamp;
    case "src_asset": return e.src_asset?.name ?? "";
    case "dst_asset": return e.dst_asset?.name ?? "";
    case "score": return e.anomaly ? String(e.anomaly.score) : "";
    default: return "";
  }
}

/** The finished URL for one event, or null when the link should not be offered. */
export function fillLink(spec: LinkSpec, e: TrafficEvent): string | null {
  if (!/^https?:\/\//i.test(spec.url)) return null;
  if (spec.public_only) {
    // Every address the template uses must be public, so an internal IP can't be sent to an outside site.
    for (const name of spec.url.matchAll(PH)) {
      if (name[1] === "src_ip" || name[1] === "dst_ip") {
        const ip = valueOf(e, name[1]);
        if (!ip || isPrivateIp(ip)) return null;
      }
    }
  }
  const url = spec.url.replace(PH, (_m, name: string) => encodeURIComponent(valueOf(e, name)));
  return /^https?:\/\//i.test(url) ? url : null;
}

export function linksFor(specs: readonly LinkSpec[], e: TrafficEvent): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  for (const s of specs) {
    const href = fillLink(s, e);
    if (href) out.push({ label: s.label, href });
  }
  return out;
}
