import { Case, CaseStore, caseMarkdown, ExportContext, utc } from "./cases";
import { severityLabel } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: alert names come from the network
  return e;
}

/** The Case panel: the active case's items in time order, and export as a Markdown timeline for a ticket or report. */
export class CasePanel {
  readonly section = el("div", "panel-section");
  private pickRow = el("div", "case-pick");
  private list = el("div", "case-list");
  private msg = el("div", "vw-msg");
  private msgTimer = 0;

  constructor(private store: CaseStore, private ctx: () => ExportContext, private onOpenItem: (id: string) => void) {
    this.section.id = "case-section";
    this.section.dataset.collapsed = "1";
    this.section.append(el("h2", undefined, "Case"));
    this.section.append(this.pickRow, this.list);
    const act = el("div", "vw-actions");
    const copy = el("button", "btn", "Copy timeline");
    copy.type = "button";
    copy.title = "Copies the case as a Markdown timeline (times in UTC)";
    copy.addEventListener("click", () => void this.copy());
    const dl = el("button", "btn", "Download .md");
    dl.type = "button";
    dl.addEventListener("click", () => this.download());
    act.append(copy, dl);
    this.msg.setAttribute("role", "status");
    this.section.append(act, this.msg, el("div", "vw-hint", "Cases are kept in this browser. Use “Add to case” in an event’s details, a campaign, or a source dossier."));
    store.subscribe(() => this.render());
    this.render();
  }

  mount(anchor: HTMLElement | null): void {
    if (anchor) anchor.before(this.section);
    else document.getElementById("sidebar")?.append(this.section);
  }

  private say(t: string, bad = false): void {
    this.msg.textContent = t;
    this.msg.classList.toggle("bad", bad);
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => { this.msg.textContent = ""; }, 5000);
  }

  private render(): void {
    const active = this.store.active;
    this.section.querySelector("h2")!.textContent = active ? `Case · ${active.items.length}` : "Case";
    // Picker: a select of cases, plus New / Rename / Delete.
    const sel = el("select", "case-select");
    sel.setAttribute("aria-label", "Active case");
    for (const c of this.store.cases) { const o = el("option", undefined, `${c.name} (${c.items.length})`); o.value = c.id; sel.append(o); }
    if (active) sel.value = active.id;
    sel.addEventListener("change", () => this.store.setActive(sel.value));
    const mkBtn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = el("button", "btn case-btn", label); b.type = "button"; b.title = title; b.addEventListener("click", fn); return b;
    };
    const nw = mkBtn("New", "Start a new case", () => { if (!this.store.create()) this.say("You can keep up to 10 cases. Delete one first.", true); });
    const ren = mkBtn("Rename", "Rename this case", () => {
      if (!active) return;
      const name = window.prompt("Case name", active.name);
      if (name) this.store.rename(active.id, name);
    });
    const del = mkBtn("Delete", "Delete this case", () => {
      if (active && window.confirm(`Delete “${active.name}” and its ${active.items.length} item(s)?`)) this.store.remove(active.id);
    });
    this.pickRow.replaceChildren(...(this.store.cases.length ? [sel] : []), nw, ...(active ? [ren, del] : []));
    this.renderItems(active);
  }

  private renderItems(active: Case | null): void {
    if (!active || active.items.length === 0) {
      this.list.replaceChildren(el("div", "vw-empty", active ? "Empty. Add alerts from their details." : "No case yet. The first thing you add starts one."));
      return;
    }
    const items = [...active.items].sort((a, b) => a.first - b.first);
    this.list.replaceChildren(...items.map((it) => {
      const row = el("div", "case-item");
      const when = el("span", "case-when", utc(it.first).slice(5, 16));
      when.title = `${utc(it.first)} UTC`;
      const text = it.kind === "event"
        ? el("button", "case-text", `${it.signature} · ${it.srcName ?? it.src} → ${it.dstName ?? it.dst}${it.count > 1 ? ` ×${it.count}` : ""}`)
        : el("button", "case-text", it.title);
      text.type = "button";
      text.title = it.kind === "event" ? `${severityLabel(it.severity)}. Click to filter to it.` : it.text;
      text.addEventListener("click", () => this.onOpenItem(it.id));
      const x = el("button", "kg-del", "×");
      x.type = "button";
      x.title = "Remove from the case";
      x.setAttribute("aria-label", "Remove from the case");
      x.addEventListener("click", () => this.store.removeItem(active.id, it.id, it.kind));
      row.append(when, text, x);
      return row;
    }));
  }

  private markdown(): string | null {
    const c = this.store.active;
    return c && c.items.length ? caseMarkdown(c, this.ctx()) : null;
  }

  private async copy(): Promise<void> {
    const md = this.markdown();
    if (!md) { this.say("Nothing in the case yet.", true); return; }
    try { await navigator.clipboard.writeText(md); this.say("Timeline copied."); }
    catch { this.say("Couldn’t copy automatically. Use Download .md.", true); }
  }

  private download(): void {
    const md = this.markdown();
    const c = this.store.active;
    if (!md || !c) { this.say("Nothing in the case yet.", true); return; }
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${c.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "case"}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
