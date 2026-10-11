import { CaseStore } from "./cases";
import { ContainmentStore, isStatus, STATUS_LABEL, STATUSES } from "./containment";
import { PivotField } from "./pivot";
import { paintSeverity, severityColor, severityLabel } from "./types";

/** A source's dossier: everything this server has recorded about one address, in one window, with where it
 *  stands in the response. For "is this one actor, or many?" and "what has it done to us?". */

export interface Counted { name: string; n: number }
export interface Dossier {
  ip: string;
  first_seen: string; last_seen: string;
  events: number; distinct_targets: number; distinct_signatures: number;
  top_signatures: Counted[]; top_targets: Counted[]; top_ports: Counted[];
  severities: Record<string, number>;
  activity: { t: string; n: number }[];
  activity_hours: number;
  recent: { t: string; signature: string; target: string; severity: string; port: number | null }[];
}

export interface DossierDeps {
  containment: ContainmentStore;
  cases: CaseStore;
  onPivot(field: PivotField, value: string, and: boolean): void;
  /** Called after something that changes what the screen shows (e.g. a status was set). */
  onChange?(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: names come from the network
  return e;
}

export function dossierText(d: Dossier, label: (id: string) => string): string {
  const sev = Object.entries(d.severities).map(([k, v]) => `${label(k)} ${v}`).join(", ");
  const sigs = d.top_signatures.slice(0, 3).map((s) => `${s.name} (${s.n})`).join("; ");
  return `${d.events} events from ${d.ip} between ${d.first_seen.slice(0, 16).replace("T", " ")} and ${d.last_seen.slice(0, 16).replace("T", " ")} UTC; ` +
    `${d.distinct_targets} targets, ${d.distinct_signatures} alert types (${sev}). Top alerts: ${sigs}.`;
}

export function openDossier(ip: string, deps: DossierDeps): void {
  if (document.querySelector(".dossier-overlay")) return;
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el("div", "dossier-overlay popout-overlay");
  const dialog = el("div", "summary-dialog dossier-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `Dossier for ${ip}`);
  dialog.tabIndex = -1;

  const head = el("div", "sm-head");
  const title = el("h2", undefined, ip);
  const closeBtn = el("button", "popout-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(title, closeBtn);
  const body = el("div", "sm-body");
  dialog.append(head, body);
  overlay.append(dialog);

  let hours = 24;
  let data: Dossier | null = null;
  let feed: "live" | "simulated" = "live";
  let seq = 0;

  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey, true); returnTo?.focus?.(); };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  dialog.addEventListener("keydown", (ev) => ev.stopPropagation());

  const pivot = (text: string, field: PivotField, value: string): HTMLElement => {
    const b = el("button", "pivot sm-link", text);
    b.type = "button";
    b.title = "Filter the screen to this";
    b.addEventListener("click", (ev) => { close(); deps.onPivot(field, value, ev.shiftKey); });
    return b;
  };
  const section = (t: string): HTMLElement => { const s = el("section", "sm-sec"); s.append(el("h3", undefined, t)); return s; };

  // ---- response status ----------------------------------------------------------------
  const statusBlock = (): HTMLElement => {
    const s = section("Where this stands");
    const cur = deps.containment.get(ip);
    if (!deps.containment.enabled) { s.append(el("div", "sm-empty", "The response tracker is turned off on this server.")); return s; }
    if (cur) {
      const chip = el("span", `cs-chip cs-${cur.status}`, STATUS_LABEL[cur.status]);
      const line = el("div", "dos-status");
      line.append(chip, ` ${cur.by ? `by ${cur.by}` : ""} ${cur.at ? `at ${new Date(cur.at).toLocaleString()}` : ""}${cur.note ? ` — ${cur.note}` : ""}`);
      s.append(line);
    } else s.append(el("div", "sm-empty", "No status recorded yet. Setting one tells the other analysts it is being handled."));
    const form = el("div", "dos-form");
    const sel = el("select", "dos-select");
    sel.setAttribute("aria-label", "Status");
    for (const st of STATUSES) { const o = el("option", undefined, STATUS_LABEL[st]); o.value = st; sel.append(o); }
    if (cur) sel.value = cur.status;
    const note = el("input", "dos-note");
    note.type = "text"; note.maxLength = 200; note.placeholder = "Note (e.g. blocked at edge firewall, ticket 4521)"; note.value = cur?.note ?? "";
    const set = el("button", "btn", cur ? "Update" : "Set status");
    set.type = "button";
    const msg = el("div", "mc-msg");
    msg.setAttribute("role", "alert");
    set.addEventListener("click", async () => {
      if (!isStatus(sel.value)) return;
      set.disabled = true;
      const err = await deps.containment.set(ip, sel.value, note.value.trim());
      set.disabled = false;
      if (err) { msg.textContent = err; return; }
      deps.onChange?.();
      draw();
    });
    form.append(sel, note, set);
    if (cur) {
      const clr = el("button", "btn", "Clear");
      clr.type = "button";
      clr.addEventListener("click", async () => {
        const err = await deps.containment.clear(ip);
        if (err) { msg.textContent = err; return; }
        deps.onChange?.();
        draw();
      });
      form.append(clr);
    }
    s.append(form, msg);
    return s;
  };

  // ---- the rest -----------------------------------------------------------------------
  const chart = (d: Dossier): HTMLElement => {
    const s = section("Activity per hour");
    const bar = el("div", "sm-hours");
    for (const h of [24, 72]) {
      const b = el("button", "btn sm-hour", `${h}h`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(h === hours));
      b.addEventListener("click", () => { hours = h; void load(); });
      bar.append(b);
    }
    s.append(bar);
    const peak = Math.max(1, ...d.activity.map((a) => a.n));
    const c = el("div", "sm-chart");
    for (const a of d.activity) {
      const col = el("div", "sm-col");
      const t = new Date(a.t);
      col.title = `${t.toLocaleString([], { weekday: "short", hour: "numeric" })}: ${a.n.toLocaleString()} events`;
      const stack = el("div", "sm-stack");
      stack.style.height = `${(a.n / peak) * 100}%`;
      const seg = el("div", "sm-seg");
      seg.style.background = "#4f8cff";
      seg.style.flexGrow = "1";
      stack.append(seg);
      col.append(stack, el("div", "sm-tick", hours <= 24 || t.getHours() % 6 === 0 ? String(t.getHours()) : ""));
      c.append(col);
    }
    s.append(c);
    return s;
  };

  const tops = (t: string, items: Counted[], field?: PivotField): HTMLElement => {
    const s = section(t);
    if (items.length === 0) { s.append(el("div", "sm-empty", "None")); return s; }
    const max = Math.max(...items.map((i) => i.n));
    for (const it of items.slice(0, 8)) {
      const row = el("div", "sm-row");
      const bar = el("span", "sm-bar");
      const fill = el("span", "sm-fill");
      fill.style.width = `${Math.max(3, (it.n / max) * 100)}%`;
      bar.append(fill);
      row.append(field ? pivot(it.name, field, it.name) : el("span", "sm-name", it.name), bar, el("span", "sm-n", it.n.toLocaleString()));
      s.append(row);
    }
    return s;
  };

  const recent = (d: Dossier): HTMLElement => {
    const s = section("Latest events");
    for (const r of d.recent) {
      const row = el("div", "sm-notable");
      const dot = el("span", "sev-dot");
      paintSeverity(dot, r.severity);
      dot.title = severityLabel(r.severity);
      row.append(dot, el("span", "sm-nsig", r.signature),
        el("span", "sm-nflow", `${r.target}${r.port !== null ? `:${r.port}` : ""} · ${new Date(r.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`));
      s.append(row);
    }
    return s;
  };

  function draw(): void {
    if (!data) return;
    const d = data;
    const kpis = el("div", "sm-kpis");
    const kpi = (n: string, l: string): void => { const k = el("div", "sm-kpi"); k.append(el("b", undefined, n), el("span", undefined, l)); kpis.append(k); };
    kpi(d.events.toLocaleString(), "events");
    kpi(String(d.distinct_targets), d.distinct_targets === 1 ? "target" : "targets");
    kpi(String(d.distinct_signatures), d.distinct_signatures === 1 ? "alert type" : "alert types");
    for (const [sid, n] of Object.entries(d.severities)) {
      const k = el("div", "sm-kpi");
      const dot = el("span", "sev-dot");
      dot.style.background = severityColor(sid);
      paintSeverity(dot, sid);
      k.append(el("b", undefined, n.toLocaleString()), el("span", undefined, severityLabel(sid)), dot);
      kpis.append(k);
    }
    const when = el("div", "sm-note", `First seen ${new Date(d.first_seen).toLocaleString()} · last seen ${new Date(d.last_seen).toLocaleString()}` +
      (feed === "simulated" ? " · demo data, not real traffic" : "") + ". Counted since this server started, so earlier activity is not included.");
    const grid = el("div", "sm-grid");
    grid.append(tops("Alert types", d.top_signatures, "signature"), tops("Targets", d.top_targets), tops("Ports", d.top_ports, "dst_port"));

    const actions = el("div", "sm-actions");
    const filter = el("button", "btn", "Filter the screen to this source");
    filter.type = "button";
    filter.addEventListener("click", () => { close(); deps.onPivot("src_ip", ip, false); });
    const addCase = el("button", "btn", deps.cases.active ? `Add to ${deps.cases.active.name}` : "Add to a new case");
    addCase.type = "button";
    addCase.addEventListener("click", () => {
      const first = Date.parse(d.first_seen), last = Date.parse(d.last_seen);
      const top = Object.keys(d.severities)[0] ?? null;
      const ok = deps.cases.add({ kind: "summary", id: `source:${ip}`, title: `Source ${ip}`, text: dossierText(d, severityLabel), severity: top, first, last, addedAt: Date.now() });
      addCase.textContent = ok ? "Added ✓" : "Case is full";
      deps.onChange?.();
    });
    actions.append(filter, addCase);
    body.replaceChildren(when, kpis, statusBlock(), chart(d), grid, recent(d), actions);
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    body.replaceChildren(el("div", "sm-empty", "Loading…"));
    try {
      const resp = await fetch(`/api/source-dossier?ip=${encodeURIComponent(ip)}&hours=${hours}`, { cache: "no-store" });
      if (!resp.ok) throw new Error(String(resp.status));
      const j = (await resp.json()) as { source: "live" | "simulated" | null; dossier: Dossier | null };
      if (mine !== seq) return;
      if (!j.dossier || !j.source) {
        data = null;
        body.replaceChildren(el("div", "sm-empty", "This server has not recorded anything for this address."), statusBlock());
        return;
      }
      data = j.dossier;
      feed = j.source;
      draw();
    } catch {
      if (mine !== seq) return;
      body.replaceChildren(el("div", "sm-empty", "Couldn’t get the dossier from the server."));
    }
  }

  document.body.append(overlay);
  dialog.focus();
  void load();
}
