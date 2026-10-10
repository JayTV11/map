import { SeverityLevel, severityColor, severityLabel, severityLevels } from "./types";

interface MappingState {
  columns: Record<string, string | null>;
  severity_map: Record<string, string>;
  severity_preset: string | null;
  severity_default: string;
}

interface Preview {
  filename: string;
  format: string;
  truncated: boolean;
  total_rows: number;
  columns: string[];
  detected: boolean;
  mapping: MappingState;
  severity_values: { value: string; count: number; level: string }[];
  severity_presets: Record<string, string>;
  levels: { levels: SeverityLevel[]; unknown: SeverityLevel };
  home: { label: string };
  stats: { usable: number; skipped: Record<string, number>; home_assumed: number; by_severity: Record<string, number> };
  sample: { src_ip: string | null; dst_ip: string | null; severity: string; signature: string | null; src: number[]; dst: number[]; note: string | null }[];
}

const GROUPS: { title: string; note?: string; fields: [string, string][] }[] = [
  {
    title: "Where it happened",
    note: "Pick latitude + longitude columns, or a single combined location column. If one side has no location, your home site is used for it.",
    fields: [
      ["src_lat", "Source latitude"], ["src_lon", "Source longitude"], ["src_geo", "Source location (one column)"],
      ["dst_lat", "Destination latitude"], ["dst_lon", "Destination longitude"], ["dst_geo", "Destination location (one column)"],
    ],
  },
  {
    title: "Who",
    fields: [["src_ip", "Source IP"], ["dst_ip", "Destination IP"], ["src_port", "Source port"], ["dst_port", "Destination port"]],
  },
  {
    title: "What",
    fields: [
      ["severity", "Severity"], ["signature", "Title / signature"], ["signature_id", "Rule ID"], ["category", "Category"],
      ["protocol", "Protocol"], ["action", "Action"], ["count", "Count / weight"], ["timestamp", "Time"],
    ],
  },
];

export interface IngestDeps {
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  onLoaded?: (result: { rows: number; filename: string }) => void;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text; // textContent only: column names and values are untrusted data
  return e;
}

/** The "load a dataset" dialog: shows how the file's columns were read,
 *  lets the user correct any guess, decide what its severity values mean,
 *  and see exactly how many rows will make it onto the map, before loading. */
export class IngestDialog {
  private overlay = el("div", "ingest-overlay");
  private body = el("div", "ingest-body");
  private foot = el("div", "ingest-foot");
  private loadBtn = el("button", "btn ingest-load", "Load as simulated feed");
  private message = el("div", "ingest-message");
  private preview: Preview | null = null;
  private mapping: MappingState | null = null;
  private seq = 0;
  private timer = 0;
  private closed = false;
  private triedRecall = false; // reuse a saved mapping at most once, so a misbehaving server can't make this loop
  private fetchImpl: typeof fetch;
  private storage: Pick<Storage, "getItem" | "setItem"> | null;
  private onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };
  private done!: () => void;
  readonly finished = new Promise<void>((resolve) => { this.done = resolve; });

  constructor(private file: File, private deps: IngestDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.storage = deps.storage ?? (() => { try { return window.localStorage; } catch { return null; } })();

    const dialog = el("div", "ingest-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const head = el("div", "ingest-head");
    head.append(el("h2", undefined, "Load a dataset"), el("span", "ingest-file", file.name));
    const x = el("button", "ingest-x", "\u00d7");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => this.close());
    head.append(x);

    const cancel = el("button", "btn ingest-cancel", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    this.loadBtn.type = "button";
    this.loadBtn.disabled = true;
    this.loadBtn.addEventListener("click", () => void this.load());
    this.foot.append(this.message, cancel, this.loadBtn);

    dialog.append(head, this.body, this.foot);
    this.overlay.append(dialog);
    this.overlay.addEventListener("pointerdown", (e) => { if (e.target === this.overlay) this.close(); });
    window.addEventListener("keydown", this.onKey);
    document.body.append(this.overlay);

    this.body.append(el("div", "ingest-loading", "Reading the file\u2026"));
    void this.refresh(null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.timer);
    window.removeEventListener("keydown", this.onKey);
    this.overlay.remove();
    this.done();
  }

  // ---- talking to the backend ------------------------------------------------
  private async post(path: string, mapping: MappingState | null): Promise<Response> {
    const form = new FormData();
    form.append("file", this.file, this.file.name);
    if (mapping) form.append("mapping", JSON.stringify(mapping));
    return this.fetchImpl(path, { method: "POST", body: form });
  }

  private async refresh(mapping: MappingState | null): Promise<void> {
    const mine = ++this.seq;
    let data: Preview | { detail?: string };
    let ok = false;
    try {
      const resp = await this.post("/api/ingest/preview", mapping);
      ok = resp.ok;
      data = await resp.json();
    } catch {
      data = { detail: "Couldn't reach the Sightline server" };
    }
    if (mine !== this.seq || this.closed) return; // a newer change superseded this response
    if (!ok) {
      this.preview = null;
      this.loadBtn.disabled = true;
      this.body.replaceChildren(el("div", "ingest-error", (data as { detail?: string }).detail ?? "Couldn't read that file"));
      return;
    }
    this.preview = data as Preview;
    this.mapping = this.preview.mapping;
    this.render();
  }

  private changed(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(this.mapping), 350);
  }

  private async load(): Promise<void> {
    if (!this.mapping || !this.preview) return;
    this.loadBtn.disabled = true;
    this.message.textContent = "Loading\u2026";
    try {
      const resp = await this.post("/api/ingest/load", this.mapping);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail ?? "Couldn't load that file");
      this.remember(this.mapping);
      this.deps.onLoaded?.({ rows: data.rows, filename: data.filename });
      this.close();
    } catch (err) {
      this.message.textContent = err instanceof Error ? err.message : "Couldn't load that file";
      this.loadBtn.disabled = false;
    }
  }

  // ---- remembering a confirmed mapping for this file layout -------------------
  private key(columns: string[]): string {
    return `traffic-map:ingest:${hash(columns.join("\u0001"))}`;
  }
  private remember(m: MappingState): void {
    if (!this.preview) return;
    try { this.storage?.setItem(this.key(this.preview.columns), JSON.stringify(m)); } catch { /* storage unavailable: fine */ }
  }
  // ---- drawing ---------------------------------------------------------------
  private render(): void {
    const p = this.preview!, m = this.mapping!;

    // First time we see this file's layout: reuse what the user confirmed last time, if anything.
    if (p.detected && !this.triedRecall) {
      this.triedRecall = true;
      try {
        const saved = this.storage?.getItem(this.key(p.columns));
        if (saved) {
          this.mapping = JSON.parse(saved) as MappingState;
          void this.refresh(this.mapping);
          return;
        }
      } catch { /* ignore a corrupt entry */ }
    }

    const frag = document.createDocumentFragment();
    frag.append(el("div", "ingest-summary",
      `${p.format.toUpperCase()} \u00b7 ${p.total_rows.toLocaleString()} rows \u00b7 ${p.columns.length} columns` +
      (p.truncated ? " \u00b7 only the first 200,000 rows are used" : "") +
      (p.detected ? " \u00b7 columns detected automatically \u2014 check them below" : " \u00b7 using your chosen columns")));

    for (const g of GROUPS) {
      const sec = el("div", "ingest-section");
      sec.append(el("h3", undefined, g.title));
      if (g.note) sec.append(el("p", "ingest-note", g.note));
      const grid = el("div", "ingest-grid");
      for (const [key, label] of g.fields) grid.append(this.field(key, label, p.columns, m));
      sec.append(grid);
      frag.append(sec);
    }

    frag.append(this.severitySection(p, m), this.previewSection(p));
    this.body.replaceChildren(frag);
    this.loadBtn.disabled = p.stats.usable === 0;
    this.message.textContent = p.stats.usable === 0 ? "Nothing on the map yet \u2014 set the location columns" : "";
  }

  private field(key: string, label: string, columns: string[], m: MappingState): HTMLElement {
    const wrap = el("label", "ingest-field");
    wrap.append(el("span", undefined, label));
    const sel = el("select");
    sel.dataset.field = key;
    sel.append(new Option("(not in this data)", ""));
    for (const c of columns) sel.append(new Option(c, c));
    sel.value = m.columns[key] ?? "";
    sel.addEventListener("change", () => {
      this.mapping!.columns[key] = sel.value || null;
      if (key === "severity") { this.mapping!.severity_map = {}; this.mapping!.severity_preset = null; }
      this.changed();
    });
    wrap.append(sel);
    return wrap;
  }

  private levelSelect(current: string, onChange: (v: string) => void, withUnknown = true): HTMLSelectElement {
    const sel = el("select");
    for (const lv of severityLevels()) sel.append(new Option(lv.label, lv.id));
    if (withUnknown) sel.append(new Option("Unknown", "unknown"));
    sel.value = current;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  private severitySection(p: Preview, m: MappingState): HTMLElement {
    const sec = el("div", "ingest-section");
    sec.append(el("h3", undefined, "What the severity values mean"));
    const scale = severityLevels().map((l) => l.label).join(" \u203a ");
    sec.append(el("p", "ingest-note", `Your scale, most severe first: ${scale}.`));

    if (!m.columns["severity"]) {
      const row = el("label", "ingest-field");
      row.append(el("span", undefined, "This data has no severity column. Treat every event as"));
      row.append(this.levelSelect(m.severity_default, (v) => { this.mapping!.severity_default = v; this.changed(); }));
      sec.append(row);
      return sec;
    }

    const preset = el("label", "ingest-field");
    preset.append(el("span", undefined, "Numeric scale"));
    const ps = el("select");
    ps.append(new Option("Values are words, or numbers I'll set myself", ""));
    for (const [id, label] of Object.entries(p.severity_presets)) ps.append(new Option(label, id));
    ps.value = m.severity_preset ?? "";
    ps.addEventListener("change", () => { this.mapping!.severity_preset = ps.value || null; this.mapping!.severity_map = {}; this.changed(); });
    preset.append(ps);
    sec.append(preset);

    const table = el("div", "ingest-sev-table");
    const numeric = p.severity_values.some((v) => v.level === "unknown" && !Number.isNaN(Number(v.value)));
    for (const v of p.severity_values) {
      const row = el("div", "ingest-sev-row");
      row.append(el("span", "ingest-sev-value", v.value), el("span", "ingest-sev-count", `${v.count.toLocaleString()}\u00d7`));
      const chip = el("span", "ingest-chip");
      chip.style.background = severityColor(v.level);
      row.append(chip, this.levelSelect(v.level, (lv) => { this.mapping!.severity_map[v.value] = lv; this.changed(); }));
      table.append(row);
    }
    sec.append(table);
    if (numeric) {
      sec.append(el("p", "ingest-warn",
        "These are plain numbers, and the app won't guess whether 1 or 5 is worse: that differs between tools. Pick the matching numeric scale above, or set each value yourself."));
    }
    return sec;
  }

  private previewSection(p: Preview): HTMLElement {
    const sec = el("div", "ingest-section ingest-preview");
    sec.append(el("h3", undefined, "What will be loaded"));
    const s = p.stats;
    sec.append(el("p", s.usable === 0 ? "ingest-error" : "ingest-ok", `${s.usable.toLocaleString()} of ${p.total_rows.toLocaleString()} rows can be placed on the map.`));
    const skipped = Object.values(s.skipped).reduce((a, b) => a + b, 0);
    if (skipped > 0) sec.append(el("p", "ingest-warn", `${skipped.toLocaleString()} rows have no usable location and will be skipped (a location of exactly 0,0 counts as missing).`));
    if (s.home_assumed > 0) sec.append(el("p", "ingest-note", `${s.home_assumed.toLocaleString()} rows have a location for only one side; ${p.home.label} (your home site) is used for the other.`));

    const chips = el("div", "ingest-chips");
    for (const lv of [...severityLevels(), { id: "unknown", label: "Unknown", color: "" } as SeverityLevel]) {
      const n = s.by_severity[lv.id];
      if (!n) continue;
      const c = el("span", "ingest-count-chip");
      const dot = el("span", "sev-dot"); dot.style.background = severityColor(lv.id);
      c.append(dot, `${severityLabel(lv.id)} ${n.toLocaleString()}`);
      chips.append(c);
    }
    sec.append(chips);

    if (p.sample.length > 0) {
      const t = el("div", "ingest-sample");
      for (const r of p.sample) {
        const row = el("div", "ingest-sample-row");
        const dot = el("span", "sev-dot"); dot.style.background = severityColor(r.severity);
        const where = (ip: string | null, pt: number[]) => ip ?? `${pt[0].toFixed(1)}, ${pt[1].toFixed(1)}`;
        row.append(dot, el("span", "ingest-sample-flow", `${where(r.src_ip, r.src)} \u2192 ${where(r.dst_ip, r.dst)}`), el("span", "ingest-sample-title", r.signature ?? ""));
        t.append(row);
      }
      sec.append(t);
    }
    return sec;
  }
}

export function openIngestDialog(file: File, deps: IngestDeps = {}): Promise<void> {
  const d = new IngestDialog(file, deps);
  return d.finished;
}
