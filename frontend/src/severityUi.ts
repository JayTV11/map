import { ArcEngine } from "./arcs";
import { severityColor, severityLabel, severityLevels } from "./types";

/** Builds the sidebar's severity filter and the map legend from the
 *  configured scale (rather than three hard-coded levels), and keeps the
 *  per-level counters. Levels that only appear in the data later -- like
 *  "Unknown" -- get their row the first time one is seen. */
export class SeverityUi {
  private section: HTMLElement | null;
  private legend: HTMLElement | null;
  private rows = new Set<string>();
  private checks = new Map<string, HTMLInputElement>();
  private counts = new Map<string, HTMLElement>();
  private totals = new Map<string, number>();

  constructor(private engine: ArcEngine) {
    this.section = document.querySelector(".sev-row")?.parentElement ?? null;
    this.section?.querySelectorAll(".sev-row").forEach((r) => r.remove());
    this.legend = document.getElementById("legend");
    this.legend?.replaceChildren();
    for (const lv of severityLevels()) this.addRow(lv.id);
  }

  /** Count one event of this severity (adding its row if it's new). */
  record(id: string): void {
    if (!this.rows.has(id)) this.addRow(id);
    const n = (this.totals.get(id) ?? 0) + 1;
    this.totals.set(id, n);
    const el = this.counts.get(id);
    if (el) el.textContent = String(n);
  }

  private addRow(id: string): void {
    this.rows.add(id);
    const color = severityColor(id);

    if (this.section) {
      const row = document.createElement("div");
      row.className = "sev-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = `sev-${id}`;
      box.checked = true;
      box.addEventListener("change", () => this.apply());
      const label = document.createElement("label");
      label.htmlFor = box.id;
      const dot = document.createElement("span");
      dot.className = "sev-dot";
      dot.style.background = color;
      label.append(dot, severityLabel(id));
      const count = document.createElement("span");
      count.className = "sev-count";
      count.id = `count-${id}`;
      count.textContent = "0";
      row.append(box, label, count);
      this.section.append(row);
      this.checks.set(id, box);
      this.counts.set(id, count);
    }

    if (this.legend) {
      const item = document.createElement("div");
      item.className = "legend-item";
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.background = color;
      item.append(dot, severityLabel(id));
      this.legend.append(item);
    }
  }

  private apply(): void {
    const hidden = new Set<string>();
    for (const [id, box] of this.checks) if (!box.checked) hidden.add(id);
    this.engine.setHiddenSeverities(hidden);
  }
}
