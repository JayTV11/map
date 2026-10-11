import { ReviewStore } from "./reviews";
import { PivotField } from "./pivot";
import { Counted, dataNote, Notable, notesInWindow, summaryText, SummaryData } from "./summary";
import { paintSeverity, severityColor, severityLabel } from "./types";

/** The shift summary: what happened over the last few hours, for a handover or a manager. The numbers come from
 *  the server (/api/summary), which counts every event as it is published, so they do not depend on what this
 *  browser happened to have open. The analyst's own notes come from this browser. */

export interface SummaryDeps {
  reviews: ReviewStore | null;
  onPivot(field: PivotField, value: string, and: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: names come from the network
  return e;
}

const HOURS = [4, 8, 12, 24];
const PREF = "sightline:summary-hours";

function savedHours(): number {
  try { const n = Number(localStorage.getItem(PREF)); if (HOURS.includes(n)) return n; } catch { /* blocked */ }
  return 8;
}

export function openSummary(deps: SummaryDeps): void {
  if (document.querySelector(".summary-overlay")) return;
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el("div", "summary-overlay popout-overlay");
  const dialog = el("div", "summary-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Shift summary");
  dialog.tabIndex = -1;

  const head = el("div", "sm-head");
  head.append(el("h2", undefined, "Shift summary"));
  const picker = el("div", "sm-hours");
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Period");
  let hours = savedHours();
  const hourBtns = HOURS.map((h) => {
    const b = el("button", "btn sm-hour", `${h}h`);
    b.type = "button";
    b.title = `The last ${h} hours`;
    b.addEventListener("click", () => { hours = h; try { localStorage.setItem(PREF, String(h)); } catch { /* ignore */ } void load(); });
    picker.append(b);
    return b;
  });
  const copyBtn = el("button", "btn", "Copy as text");
  copyBtn.type = "button";
  const printBtn = el("button", "btn", "Print");
  printBtn.type = "button";
  const closeBtn = el("button", "popout-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(picker, copyBtn, printBtn, closeBtn);
  const body = el("div", "sm-body");
  dialog.append(head, body);
  overlay.append(dialog);

  let data: SummaryData | null = null;
  let seq = 0;
  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey, true); returnTo?.focus?.(); };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  dialog.addEventListener("keydown", (ev) => ev.stopPropagation()); // page shortcuts stay quiet in here

  const pivotable = (text: string, field: PivotField, value: string): HTMLElement => {
    const b = el("button", "pivot sm-link", text);
    b.type = "button";
    b.title = "Filter the screen to this";
    b.addEventListener("click", (ev) => { close(); deps.onPivot(field, value, ev.shiftKey); });
    return b;
  };

  const section = (title: string): HTMLElement => { const s = el("section", "sm-sec"); s.append(el("h3", undefined, title)); return s; };

  const topList = (title: string, items: Counted[], field?: PivotField): HTMLElement => {
    const s = section(title);
    if (items.length === 0) { s.append(el("div", "sm-empty", "None")); return s; }
    const max = Math.max(...items.map((i) => i.n));
    for (const it of items.slice(0, 8)) {
      const row = el("div", "sm-row");
      const name = field ? pivotable(it.name, field, it.name) : el("span", "sm-name", it.name);
      const bar = el("span", "sm-bar");
      const fill = el("span", "sm-fill");
      fill.style.width = `${Math.max(3, (it.n / max) * 100)}%`;
      bar.append(fill);
      row.append(name, bar, el("span", "sm-n", it.n.toLocaleString()));
      s.append(row);
    }
    return s;
  };

  const timeline = (d: SummaryData): HTMLElement => {
    const s = section("Events per hour");
    const peak = Math.max(1, ...d.timeline.map((h) => h.n));
    const chart = el("div", "sm-chart");
    const sevOrder = d.by_severity.map((b) => b.id);
    for (const h of d.timeline) {
      const col = el("div", "sm-col");
      const t = new Date(h.t);
      col.title = `${t.toLocaleString([], { weekday: "short", hour: "numeric" })}: ${h.n.toLocaleString()} events`;
      const stack = el("div", "sm-stack");
      stack.style.height = `${(h.n / peak) * 100}%`;
      for (const id of [...sevOrder].reverse()) {
        const n = h.by_sev[id] ?? 0;
        if (!n) continue;
        const seg = el("div", "sm-seg");
        seg.style.flexGrow = String(n);
        seg.style.background = severityColor(id);
        stack.append(seg);
      }
      col.append(stack, el("div", "sm-tick", String(t.getHours())));
      chart.append(col);
    }
    s.append(chart);
    return s;
  };

  const notableList = (d: SummaryData): HTMLElement => {
    const s = section(`Worth a look (${d.notable_total.toLocaleString()})`);
    if (d.notable.length === 0) { s.append(el("div", "sm-empty", "Nothing stood out: no top-severity, unusual or key-system alerts in this period.")); return s; }
    for (const n of d.notable.slice(0, 15) as Notable[]) {
      const row = el("div", "sm-notable");
      const dot = el("span", "sev-dot");
      paintSeverity(dot, n.severity);
      dot.title = severityLabel(n.severity);
      const what = el("span", "sm-nsig");
      what.append(pivotable(n.signature, "signature", n.signature));
      const flow = el("span", "sm-nflow");
      flow.append(pivotable(n.src_ip, "src_ip", n.src_ip), ` → ${n.target} · ${n.count.toLocaleString()}× · ${new Date(n.last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      if (n.score >= 70) flow.append(el("span", "sm-unusual", ` unusual ${n.score}`));
      if (n.reasons?.[0]) what.title = n.reasons[0];
      row.append(dot, what, flow);
      s.append(row);
    }
    if (d.notable_total > 15) s.append(el("div", "sm-empty", `Showing 15 of ${d.notable_total.toLocaleString()}.`));
    return s;
  };

  const myNotes = (d: SummaryData): HTMLElement | null => {
    const notes = deps.reviews ? notesInWindow(deps.reviews.entries(), new Date(d.from).getTime()) : [];
    if (notes.length === 0) return null;
    const s = section("My notes (kept in this browser)");
    for (const n of notes) {
      const row = el("div", "sm-mynote");
      row.append(el("b", undefined, `${n.signature || "Alert"} `), `${n.src} → ${n.dst}: ${n.text}`);
      s.append(row);
    }
    return s;
  };

  const draw = (d: SummaryData): void => {
    const kpis = el("div", "sm-kpis");
    const kpi = (n: number, label: string): void => { const k = el("div", "sm-kpi"); k.append(el("b", undefined, n.toLocaleString()), el("span", undefined, label)); kpis.append(k); };
    kpi(d.events, "events");
    for (const b of d.by_severity) {
      const k = el("div", "sm-kpi");
      const dot = el("span", "sev-dot");
      paintSeverity(dot, b.id);
      const num = el("b", undefined, b.n.toLocaleString());
      k.append(num, el("span", undefined, severityLabel(b.id)), dot);
      kpis.append(k);
    }
    kpi(d.unusual, "unusual");
    kpi(d.key_asset_hits, "at key systems");
    if (d.muted) kpi(d.muted, "muted (known-good)");
    const note = el("div", d.complete ? "sm-note" : "sm-note warn", dataNote(d));
    const grid = el("div", "sm-grid");
    grid.append(topList("Top alert types", d.top.signatures, "signature"), topList("Top sources", d.top.sources, "src_ip"),
      topList("Top targets", d.top.targets), topList("Top source countries", d.top.countries));
    const mine = myNotes(d);
    body.replaceChildren(note, kpis, timeline(d), notableList(d), grid, ...(mine ? [mine] : []));
  };

  async function load(): Promise<void> {
    const mine = ++seq;
    hourBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(HOURS[i] === hours)));
    body.replaceChildren(el("div", "sm-empty", "Loading…"));
    try {
      const resp = await fetch(`/api/summary?hours=${hours}`, { cache: "no-store" });
      if (!resp.ok) throw new Error(String(resp.status));
      const d = (await resp.json()) as SummaryData;
      if (mine !== seq) return; // a newer request has taken over
      data = d;
      draw(d);
    } catch {
      if (mine !== seq) return;
      data = null;
      body.replaceChildren(el("div", "sm-empty", "Couldn’t get the summary from the server."));
    }
  }

  copyBtn.addEventListener("click", async () => {
    if (!data) return;
    const notes = deps.reviews ? notesInWindow(deps.reviews.entries(), new Date(data.from).getTime()) : [];
    try { await navigator.clipboard.writeText(summaryText(data, severityLabel, notes)); copyBtn.textContent = "Copied"; }
    catch { copyBtn.textContent = "Copy failed"; }
    window.setTimeout(() => { copyBtn.textContent = "Copy as text"; }, 1400);
  });
  printBtn.addEventListener("click", () => window.print());

  document.body.append(overlay);
  dialog.focus();
  void load();
}

