/** Cases: a handful of alerts (and campaign/source summaries) an analyst pins together as the story of an incident,
 *  then exports as a timeline for a ticket or report. Kept in THIS browser (localStorage), like reviews and notes. */

export interface CaseEvent {
  kind: "event";
  id: string;            // the group key: src|dst|signature
  src: string;
  dst: string;
  srcName: string | null;
  dstName: string | null;
  signature: string;
  severity: string;
  first: number;         // ms
  last: number;
  count: number;
  score: number | null;
  addedAt: number;
}
/** A campaign or a source's profile, written as one line of text at the time it was added. */
export interface CaseSummary {
  kind: "summary";
  id: string;
  title: string;
  text: string;
  severity: string | null;
  first: number;
  last: number;
  addedAt: number;
}
export type CaseItem = CaseEvent | CaseSummary;

export interface Case {
  id: string;
  name: string;
  created: number;
  items: CaseItem[];
}

export const MAX_CASES = 10;
export const MAX_ITEMS = 200;
export const MAX_NAME = 80;
const KEY = "sightline:cases";

type Store = Pick<Storage, "getItem" | "setItem">;

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");

export function parseCases(raw: unknown): { cases: Case[]; active: string | null } {
  const out: Case[] = [];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const c of Array.isArray(o.cases) ? o.cases : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const items: CaseItem[] = [];
    for (const it of Array.isArray(r.items) ? r.items : []) {
      if (!it || typeof it !== "object") continue;
      const x = it as Record<string, unknown>;
      if (x.kind === "event" && typeof x.id === "string") {
        items.push({ kind: "event", id: str(x.id, 400), src: str(x.src, 64), dst: str(x.dst, 64), srcName: x.srcName ? str(x.srcName, 100) : null,
          dstName: x.dstName ? str(x.dstName, 100) : null, signature: str(x.signature, 300), severity: str(x.severity, 40),
          first: num(x.first), last: num(x.last), count: Math.max(1, num(x.count, 1)), score: typeof x.score === "number" ? x.score : null, addedAt: num(x.addedAt) });
      } else if (x.kind === "summary" && typeof x.id === "string") {
        items.push({ kind: "summary", id: str(x.id, 400), title: str(x.title, 200), text: str(x.text, 1200), severity: x.severity ? str(x.severity, 40) : null,
          first: num(x.first), last: num(x.last), addedAt: num(x.addedAt) });
      }
      if (items.length >= MAX_ITEMS) break;
    }
    if (typeof r.id === "string") out.push({ id: str(r.id, 60), name: str(r.name, MAX_NAME) || "Case", created: num(r.created), items });
    if (out.length >= MAX_CASES) break;
  }
  const active = typeof o.active === "string" && out.some((c) => c.id === o.active) ? o.active : out[0]?.id ?? null;
  return { cases: out, active };
}

export class CaseStore {
  private list: Case[] = [];
  private activeId: string | null = null;
  private listeners: (() => void)[] = [];
  subscribe(fn: () => void): void { this.listeners.push(fn); }

  constructor(private storage: Store | null, private now: () => number = Date.now) {
    try {
      const p = parseCases(JSON.parse(storage?.getItem(KEY) ?? "null"));
      this.list = p.cases;
      this.activeId = p.active;
    } catch { /* blocked or corrupted: start empty */ }
  }

  get cases(): readonly Case[] { return this.list; }
  get active(): Case | null { return this.list.find((c) => c.id === this.activeId) ?? null; }

  setActive(id: string): void {
    if (this.list.some((c) => c.id === id) && id !== this.activeId) { this.activeId = id; this.save(); }
  }

  /** Starts a new case and makes it the active one. Null when the limit is reached. */
  create(name?: string): Case | null {
    if (this.list.length >= MAX_CASES) return null;
    const c: Case = { id: `c${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, name: (name ?? "").trim().slice(0, MAX_NAME) || this.defaultName(), created: this.now(), items: [] };
    this.list.push(c);
    this.activeId = c.id;
    this.save();
    return c;
  }

  private defaultName(): string {
    const used = new Set(this.list.map((c) => c.name));
    for (let i = 1; ; i++) if (!used.has(`Case ${i}`)) return `Case ${i}`;
  }

  rename(id: string, name: string): void {
    const c = this.list.find((x) => x.id === id);
    const n = name.trim().slice(0, MAX_NAME);
    if (c && n && n !== c.name) { c.name = n; this.save(); }
  }

  remove(id: string): void {
    const i = this.list.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (this.activeId === id) this.activeId = this.list[0]?.id ?? null;
    this.save();
  }

  /** Adds (or refreshes) an item in the active case, starting a case if there is none. False when it is full. */
  add(item: CaseItem): boolean {
    const c = this.active ?? this.create();
    if (!c) return false;
    const i = c.items.findIndex((x) => x.id === item.id && x.kind === item.kind);
    if (i >= 0) c.items[i] = { ...item, addedAt: c.items[i].addedAt };
    else {
      if (c.items.length >= MAX_ITEMS) return false;
      c.items.push(item);
    }
    this.save();
    return true;
  }

  has(id: string): boolean { return this.active?.items.some((x) => x.id === id) ?? false; }

  removeItem(caseId: string, itemId: string, kind: CaseItem["kind"]): void {
    const c = this.list.find((x) => x.id === caseId);
    if (!c) return;
    const n = c.items.length;
    c.items = c.items.filter((x) => !(x.id === itemId && x.kind === kind));
    if (c.items.length !== n) this.save();
  }

  private save(): void {
    try { this.storage?.setItem(KEY, JSON.stringify({ v: 1, active: this.activeId, cases: this.list })); } catch { /* quota or blocked: lasts until reload */ }
    for (const fn of this.listeners) fn();
  }
}

// ---- export ---------------------------------------------------------------------------------

export interface ExportContext {
  /** Severity id -> its name. */
  label(id: string): string;
  /** The analyst's own note on an alert, by group key. */
  note(key: string): string;
  /** The response status recorded for a source address, if any. */
  status(ip: string): { label: string; by: string; at: string; note: string } | null;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** UTC, because incident timelines are written in UTC so that everyone reads the same clock. */
export function utc(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** A table cell: no pipes or line breaks that would break the row. */
const cell = (s: string): string => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
const who = (ip: string, name: string | null): string => (name ? `${name} (${ip})` : ip);

export function caseMarkdown(c: Case, ctx: ExportContext): string {
  const items = [...c.items].sort((a, b) => a.first - b.first || a.addedAt - b.addedAt);
  const L: string[] = [];
  L.push(`# ${c.name}`, "");
  const span = items.length ? `${utc(items[0].first)} to ${utc(Math.max(...items.map((i) => i.last)))} UTC` : "no items yet";
  L.push(`${items.length} item${items.length === 1 ? "" : "s"} · ${span} · all times UTC`, "");
  const events = items.filter((i): i is CaseEvent => i.kind === "event");
  if (events.length > 0) {
    L.push("## Timeline", "", "| First seen (UTC) | Last seen (UTC) | Severity | Source | Target | Alert | Count | Note |", "|---|---|---|---|---|---|---|---|");
    for (const e of events) {
      L.push(`| ${utc(e.first)} | ${e.count > 1 ? utc(e.last) : ""} | ${cell(ctx.label(e.severity))} | ${cell(who(e.src, e.srcName))} | ${cell(who(e.dst, e.dstName))} | ${cell(e.signature)} | ${e.count} | ${cell(ctx.note(e.id))} |`);
    }
    L.push("");
  }
  const sums = items.filter((i): i is CaseSummary => i.kind === "summary");
  if (sums.length > 0) {
    L.push("## Context", "");
    for (const s of sums) L.push(`- **${s.title}** (${utc(s.first)} to ${utc(s.last)} UTC): ${s.text}`);
    L.push("");
  }
  const ips = [...new Set(events.map((e) => e.src))];
  const statuses = ips.map((ip) => ({ ip, s: ctx.status(ip) })).filter((x) => x.s);
  if (statuses.length > 0) {
    L.push("## Response status", "");
    for (const { ip, s } of statuses) L.push(`- ${ip}: ${s!.label}${s!.by ? ` by ${s!.by}` : ""}${s!.at ? ` at ${s!.at.replace("T", " ").replace(/\+00:00$/, "")} UTC` : ""}${s!.note ? ` (${s!.note})` : ""}`);
    L.push("");
  }
  return L.join("\n").trimEnd() + "\n";
}
