/** The shift summary: the shape the backend returns (/api/summary) and a plain-text version for pasting into a handover. Pure. */

export interface Counted { name: string; n: number }
export interface Notable {
  key: string; severity: string; signature: string; src_ip: string; dst_ip: string | null; target: string; country: string | null;
  count: number; score: number; reasons: string[]; first: string; last: string;
}
export interface SummaryData {
  source: "live" | "simulated";
  from: string; to: string; hours: number;
  data_since: string | null;
  complete: boolean;
  events: number; muted: number; unusual: number; key_asset_hits: number;
  by_severity: { id: string; n: number }[];
  timeline: { t: string; n: number; by_sev: Record<string, number> }[];
  top: { signatures: Counted[]; sources: Counted[]; targets: Counted[]; countries: Counted[] };
  notable: Notable[];
  notable_total: number;
}

export interface AnalystNote { text: string; signature: string; src: string; dst: string; at: number }

/** The analyst's own review notes made inside the window, newest first. Keys are "src|dst|signature". */
export function notesInWindow(entries: readonly [string, { note: string; at: number }][], fromMs: number): AnalystNote[] {
  const out: AnalystNote[] = [];
  for (const [key, r] of entries) {
    if (!r.note || r.at < fromMs) continue;
    const [src = "", dst = "", ...sig] = key.split("|");
    out.push({ text: r.note, src, dst, signature: sig.join("|"), at: r.at });
  }
  return out.sort((a, b) => b.at - a.at);
}

export function dataNote(s: SummaryData): string {
  const feed = s.source === "live" ? "the live feed" : "the demo data (uploaded file), not real traffic";
  if (s.data_since === null) return `Nothing has been recorded yet from ${feed}.`;
  const since = new Date(s.data_since).toLocaleString();
  return s.complete
    ? `Counted from ${feed}, complete for this period.`
    : `Counted from ${feed}. This server only started counting at ${since}, so anything earlier in this period is not included.`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A handover note as plain text. `label` turns a severity id into its name. */
export function summaryText(s: SummaryData, label: (id: string) => string, notes: readonly AnalystNote[] = []): string {
  const L: string[] = [];
  L.push(`Sightline shift summary: last ${s.hours} hour${s.hours === 1 ? "" : "s"} (${stamp(s.from)} to ${stamp(s.to)})`);
  L.push(dataNote(s));
  L.push("");
  L.push(`Events: ${s.events.toLocaleString()}` + (s.muted ? ` (+ ${s.muted.toLocaleString()} muted as known-good)` : ""));
  L.push("By severity: " + s.by_severity.map((b) => `${label(b.id)} ${b.n.toLocaleString()}`).join(", "));
  L.push(`Unusual for this network: ${s.unusual.toLocaleString()} · Aimed at key systems: ${s.key_asset_hits.toLocaleString()}`);
  const top = (title: string, items: Counted[]): void => {
    if (items.length === 0) return;
    L.push("", `${title}:`);
    items.slice(0, 5).forEach((it, i) => L.push(`  ${i + 1}. ${it.name} (${it.n.toLocaleString()})`));
  };
  top("Top alert types", s.top.signatures);
  top("Top sources", s.top.sources);
  top("Top targets", s.top.targets);
  top("Top source countries", s.top.countries);
  if (s.notable.length > 0) {
    L.push("", `Worth a look (${s.notable_total.toLocaleString()}${s.notable_total > s.notable.length ? `, showing ${s.notable.length}` : ""}):`);
    for (const n of s.notable.slice(0, 15)) {
      L.push(`  - [${label(n.severity)}] ${n.signature}: ${n.src_ip} -> ${n.target} x${n.count.toLocaleString()}, last ${stamp(n.last)}` + (n.score >= 70 ? `, unusual (${n.score})` : ""));
    }
  }
  if (notes.length > 0) {
    L.push("", "My notes:");
    for (const n of notes) L.push(`  - ${n.signature || "(alert)"} ${n.src} -> ${n.dst}: ${n.text}`);
  }
  return L.join("\n");
}
