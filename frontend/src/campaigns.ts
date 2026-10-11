import { pivotClause, pivotQuery } from "./pivot";

/** Activity that looks coordinated, as the server describes it (/api/campaigns). It is a heuristic for
 *  "these belong together", not an attribution. */

export interface Counted { name: string; n: number }
interface Base { events: number; distinct: number; severity: string; first: string; last: string }
export interface FanOut extends Base { kind: "fan-out"; src_ip: string; targets: Counted[]; signatures: Counted[] }
export interface FanIn extends Base { kind: "fan-in"; target: string; dst_ip: string | null; signature: string; sources: Counted[] }
export type Campaign = FanOut | FanIn;
export interface CampaignData {
  source: "live" | "simulated";
  minutes: number;
  events_considered: number;
  since: string | null;
  campaigns: Campaign[];
  total: number;
}

export function campaignTitle(c: Campaign): string {
  return c.kind === "fan-out"
    ? `${c.src_ip} reached ${c.distinct} different targets`
    : `${c.distinct} different sources hit ${c.target}`;
}

/** The search that shows exactly this campaign's events. */
export function campaignQuery(c: Campaign): string {
  if (c.kind === "fan-out") return pivotClause("src_ip", c.src_ip);
  const target = c.dst_ip && c.target === c.dst_ip ? pivotClause("dst_ip", c.dst_ip) : pivotClause("dst_asset", c.target);
  return pivotQuery(target, pivotClause("signature", c.signature), true);
}

/** Stable id, so adding the same campaign twice to a case refreshes it. */
export function campaignId(c: Campaign): string {
  return c.kind === "fan-out" ? `campaign:out:${c.src_ip}` : `campaign:in:${c.target}|${c.signature}`;
}

/** One line for a case: what was seen, over what window. */
export function campaignText(c: Campaign, label: (id: string) => string): string {
  if (c.kind === "fan-out") {
    const sigs = c.signatures.map((s) => `${s.name} (${s.n})`).join(", ");
    const tgts = c.targets.slice(0, 3).map((t) => t.name).join(", ");
    return `One source, ${c.distinct} targets, ${c.events} events, worst severity ${label(c.severity)}. Alerts: ${sigs}. Includes ${tgts}${c.distinct > 3 ? " and others" : ""}.`;
  }
  const srcs = c.sources.slice(0, 3).map((s) => s.name).join(", ");
  return `${c.distinct} sources, ${c.events} events of "${c.signature}" aimed at ${c.target}, severity ${label(c.severity)}. Includes ${srcs}${c.distinct > 3 ? " and others" : ""}.`;
}

const IP_LIKE = /^[0-9a-fA-F:.]+$/;

/** The search that shows what a case item was about, from its id (an alert's group key, a campaign, or a source). */
export function queryForItemId(id: string): string | null {
  if (id.startsWith("source:")) return pivotClause("src_ip", id.slice(7));
  if (id.startsWith("campaign:out:")) return pivotClause("src_ip", id.slice(13));
  if (id.startsWith("campaign:in:")) {
    const rest = id.slice(12);
    const bar = rest.lastIndexOf("|");
    const target = bar < 0 ? rest : rest.slice(0, bar);
    const sig = bar < 0 ? "" : rest.slice(bar + 1);
    const t = pivotClause(IP_LIKE.test(target) ? "dst_ip" : "dst_asset", target);
    return sig ? pivotQuery(t, pivotClause("signature", sig), true) : t;
  }
  const [src, dst, ...sig] = id.split("|");
  if (src && dst && sig.length) return pivotQuery(pivotQuery(pivotClause("src_ip", src), pivotClause("dst_ip", dst), true), pivotClause("signature", sig.join("|")), true);
  return null;
}
