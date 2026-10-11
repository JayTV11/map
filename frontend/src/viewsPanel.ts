import { LayoutState } from "./layoutState";
import { isColorBlind, setColorBlind } from "./types";
import { PRESETS, ViewState, ViewStore, buildShareUrl } from "./views";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: view names are typed by people
  return e;
}

export interface ViewsPanelDeps {
  store: ViewStore;
  getView(): ViewState;
  applyView(v: ViewState): void;
  getLayout(): LayoutState;
  applyLayout(l: LayoutState): void;
  openSummary(): void;
  /** Opens this page again in a second window: the log (with search) or the map alone. */
  openWindow(mode: "console" | "map"): void;
  mode: "full" | "console" | "map";
}

/** The "Views" panel: role starting points, the analyst's own saved views (search + chips + mute + log
 *  settings, and optionally the panel layout), a share link, and export/import of saved views as a file.
 *  Saved views live in this browser; export/import is how they move to another machine or person. */
export class ViewsPanel {
  readonly section = el("div", "panel-section");
  private savedBox = el("div", "vw-saved");
  private msg = el("div", "vw-msg");
  private linkBox = el("input", "vw-link");
  private nameInput = el("input", "vw-name");
  private withLayout = document.createElement("input");
  private msgTimer = 0;

  constructor(private deps: ViewsPanelDeps) {
    this.section.id = "views-section";
    this.section.dataset.collapsed = "1";
    this.section.append(el("h2", undefined, "Views"));

    this.section.append(el("div", "vw-label", "Starting points"));
    const presets = el("div", "vw-presets");
    for (const p of PRESETS) {
      const b = el("button", "btn vw-preset", p.name);
      b.type = "button";
      b.title = p.blurb;
      b.addEventListener("click", () => { deps.applyView(p.view); this.say(`${p.name}: ${p.blurb}`); });
      presets.append(b);
    }
    this.section.append(presets);

    this.section.append(el("div", "vw-label", "My saved views"), this.savedBox);

    const saveRow = el("div", "vw-saverow");
    this.nameInput.type = "text";
    this.nameInput.placeholder = "Name this view";
    this.nameInput.maxLength = 40;
    this.nameInput.setAttribute("aria-label", "Name for the saved view");
    const saveBtn = el("button", "btn vw-save", "Save");
    saveBtn.type = "button";
    saveRow.append(this.nameInput, saveBtn);
    const layoutLabel = el("label", "vw-check");
    this.withLayout.type = "checkbox";
    layoutLabel.append(this.withLayout, el("span", undefined, "Include my panel layout"));
    this.section.append(saveRow, layoutLabel);
    saveBtn.addEventListener("click", () => this.save());
    this.nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") this.save(); ev.stopPropagation(); });

    const share = el("div", "vw-actions");
    const copy = el("button", "btn", "Copy link to this view");
    copy.type = "button";
    copy.title = "A link that opens Sightline with this search, these filters and this log order";
    copy.addEventListener("click", () => void this.copyLink());
    const exp = el("button", "btn", "Export my views");
    exp.type = "button";
    exp.addEventListener("click", () => this.exportFile());
    const imp = el("button", "btn", "Import views…");
    imp.type = "button";
    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    imp.addEventListener("click", () => file.click());
    file.addEventListener("change", () => void this.importFile(file));
    share.append(copy, exp, imp, file);
    this.linkBox.type = "text";
    this.linkBox.readOnly = true;
    this.linkBox.hidden = true;
    this.linkBox.setAttribute("aria-label", "Link to this view");
    this.linkBox.addEventListener("focus", () => this.linkBox.select());
    this.msg.setAttribute("role", "status");
    this.section.append(share, this.linkBox, this.msg);

    this.section.append(el("div", "vw-label", "Reports"));
    const rep = el("div", "vw-actions");
    const sum = el("button", "btn", "Shift summary\u2026");
    sum.type = "button";
    sum.title = "What happened over the last few hours, ready to hand over or print";
    sum.addEventListener("click", () => deps.openSummary());
    rep.append(sum);
    this.section.append(rep);

    if (deps.mode === "full") {
      this.section.append(el("div", "vw-label", "Second monitor"));
      const win = el("div", "vw-actions");
      const con = el("button", "btn", "Log in a new window");
      con.type = "button";
      con.title = "Opens the event log, details and search in their own window. Pinning an alert in either window pins it in both.";
      con.addEventListener("click", () => deps.openWindow("console"));
      const map = el("button", "btn", "Map only in a new window");
      map.type = "button";
      map.title = "Opens just the map, for a wall display. Pinning an alert in either window pins it in both.";
      map.addEventListener("click", () => deps.openWindow("map"));
      win.append(con, map);
      this.section.append(win, el("div", "vw-hint", "Only the pinned alert is shared between windows. Search and filters are separate."));
    }

    this.section.append(el("div", "vw-label", "Display"));
    const cbLabel = el("label", "vw-check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isColorBlind();
    cb.addEventListener("change", () => {
      setColorBlind(cb.checked, true);
      window.location.reload(); // everything already drawn is in the old colours; a reload is the simplest way to be sure none is left
    });
    cbLabel.append(cb, el("span", undefined, "Colour-blind-safe colours and shapes"));
    cbLabel.title = "Replaces red/orange/yellow with colours that stay distinct, and gives each severity its own shape. Reloads the page.";
    this.section.append(cbLabel);

    this.renderSaved();
  }

  /** Inserts the panel before `anchor` (it must exist before PanelLayout is built). */
  mount(anchor: HTMLElement | null): void {
    if (anchor) anchor.before(this.section);
    else document.getElementById("sidebar")?.append(this.section);
  }

  private say(text: string, bad = false): void {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => { this.msg.textContent = ""; }, 6000);
  }

  private renderSaved(): void {
    const list = this.deps.store.list();
    if (list.length === 0) {
      this.savedBox.replaceChildren(el("div", "vw-empty", "None yet. Set up the screen the way you like it, name it, and Save."));
      return;
    }
    this.savedBox.replaceChildren(...list.map((sv) => {
      const row = el("div", "vw-row");
      const open = el("button", "vw-open", sv.name);
      open.type = "button";
      open.title = `Open this view${sv.layout ? " (with its panel layout)" : ""}`;
      open.addEventListener("click", () => {
        this.deps.applyView(sv.view);
        if (sv.layout) this.deps.applyLayout(sv.layout);
        this.say(`Opened “${sv.name}”.`);
      });
      const del = el("button", "vw-del", "×");
      del.type = "button";
      del.title = "Delete this saved view";
      del.setAttribute("aria-label", `Delete ${sv.name}`);
      del.addEventListener("click", () => { this.deps.store.remove(sv.name); this.renderSaved(); });
      row.append(open, del);
      return row;
    }));
  }

  private save(): void {
    const name = this.nameInput.value.trim();
    if (!name) { this.say("Give the view a name first.", true); this.nameInput.focus(); return; }
    const ok = this.deps.store.save(name, this.deps.getView(), this.withLayout.checked ? this.deps.getLayout() : undefined);
    if (!ok) { this.say("Couldn’t save: you can keep up to 20 views. Delete one first.", true); return; }
    this.nameInput.value = "";
    this.renderSaved();
    this.say(`Saved “${name}”.`);
  }

  private async copyLink(): Promise<void> {
    const url = buildShareUrl(location.href, this.deps.getView());
    try {
      await navigator.clipboard.writeText(url);
      this.linkBox.hidden = true;
      this.say("Link copied.");
    } catch {
      this.linkBox.value = url; // clipboard blocked (plain http, some browsers): show it to copy by hand
      this.linkBox.hidden = false;
      this.linkBox.select();
      this.say("Couldn’t copy automatically. The link is below.", true);
    }
  }

  private exportFile(): void {
    if (this.deps.store.list().length === 0) { this.say("Nothing to export yet: save a view first.", true); return; }
    const blob = new Blob([this.deps.store.exportJson()], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sightline-views.json";
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    if (f.size > 200_000) { this.say("That file is too large to be a views export.", true); return; }
    const n = this.deps.store.importJson(await f.text());
    this.renderSaved();
    this.say(n > 0 ? `Imported ${n} view${n === 1 ? "" : "s"}.` : "No views found in that file.", n === 0);
  }
}
