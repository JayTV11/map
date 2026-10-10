import { severityLevels } from "./types";

/** One-click filters under the search bar, and saved searches.
 *
 *  Chips are ANDed with each other and with whatever is typed in the box, so
 *  "Critical" + "Inbound" + `src_ip:203.0.113.0/24` narrows all three ways.
 *  Saved searches are your own queries, kept in this browser (localStorage);
 *  they are per browser and per person, not shared. */

export interface Chip {
  id: string;
  label: string;
  query: string;
  saved?: boolean;
}

/** The built-in chips. The first is the MOST severe level of your configured scale, whatever you call it. */
export function builtinChips(): Chip[] {
  const top = severityLevels()[0];
  const chips: Chip[] = [];
  if (top) chips.push({ id: "worst", label: top.label, query: `severity:${top.id}` });
  chips.push(
    { id: "key", label: "Key assets", query: "src_criticality:(high or critical) or dst_criticality:(high or critical)" },
    { id: "unusual", label: "Unusual", query: "anomaly_score >= 70" },
    { id: "inbound", label: "Inbound", query: "direction:inbound" },
    { id: "blocked", label: "Blocked", query: "action:(block* or den* or drop* or reject*)" },
  );
  return chips;
}

/** typed query + active chips -> one query. Each part is parenthesised so an `or` inside one can't leak into the others. */
export function combineQueries(typed: string, chips: readonly { query: string }[]): string {
  const parts = [typed.trim(), ...chips.map((c) => c.query)].filter((p) => p !== "");
  if (parts.length <= 1) return parts[0] ?? "";
  return parts.map((p) => `(${p})`).join(" and ");
}

const KEY = "sightline:saved-searches";
const MAX_SAVED = 12;
const MAX_LEN = 300;

export class SavedSearches {
  private read(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX_SAVED) : [];
    } catch {
      return []; // storage blocked or corrupted: behave as if nothing is saved
    }
  }

  list(): string[] { return this.read(); }

  has(text: string): boolean { return this.read().includes(text.trim()); }

  save(text: string): boolean {
    const t = text.trim();
    if (!t || t.length > MAX_LEN) return false;
    const all = this.read().filter((x) => x !== t);
    all.unshift(t);
    return this.write(all.slice(0, MAX_SAVED));
  }

  remove(text: string): void {
    this.write(this.read().filter((x) => x !== text));
  }

  private write(all: string[]): boolean {
    try { localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch { return false; }
  }
}

function label(text: string): string {
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/** The chip row. Knows nothing about filtering itself: it reports which chips are on. */
export class ChipBar {
  readonly el = document.createElement("div");
  onChange?: () => void;
  /** Asked when the Save button is pressed; returns the text to save, or "" when there's nothing valid. */
  getSavable: () => string = () => "";

  private active = new Set<string>();
  private saveBtn = document.createElement("button");

  constructor(private saved = new SavedSearches()) {
    this.el.className = "fb-chips";
    this.saveBtn.type = "button";
    this.saveBtn.className = "fb-chip fb-save";
    this.saveBtn.textContent = "★ Save search";
    this.saveBtn.title = "Save the current search as a one-click chip (kept in this browser)";
    this.saveBtn.hidden = true;
    this.saveBtn.addEventListener("click", () => {
      const text = this.getSavable();
      if (text && this.saved.save(text)) { this.render(); this.onChange?.(); }
    });
    this.render();
  }

  /** Every chip currently available. */
  all(): Chip[] {
    return [...builtinChips(), ...this.saved.list().map((q): Chip => ({ id: `saved:${q}`, label: label(q), query: q, saved: true }))];
  }

  /** The chips that are switched on (a saved chip whose search was deleted drops out). */
  activeChips(): Chip[] {
    return this.all().filter((c) => this.active.has(c.id));
  }

  setActive(ids: Iterable<string>): void {
    this.active = new Set(ids);
    this.render();
  }

  get activeIds(): string[] { return this.activeChips().filter((c) => !c.saved).map((c) => c.id); }

  /** Show the Save button only when there's something new worth saving. */
  updateSave(): void {
    const text = this.getSavable();
    this.saveBtn.hidden = text === "" || this.saved.has(text);
  }

  render(): void {
    const nodes: HTMLElement[] = [];
    for (const chip of this.all()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `fb-chip${chip.saved ? " saved" : ""}${this.active.has(chip.id) ? " on" : ""}`;
      b.textContent = chip.label; // textContent: saved text is user-typed
      b.title = chip.query;
      b.setAttribute("aria-pressed", String(this.active.has(chip.id)));
      b.addEventListener("click", () => {
        if (this.active.has(chip.id)) this.active.delete(chip.id);
        else this.active.add(chip.id);
        this.render();
        this.onChange?.();
      });
      if (chip.saved) {
        const x = document.createElement("span");
        x.className = "fb-chip-x";
        x.textContent = "×";
        x.title = "Forget this saved search";
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.active.delete(chip.id);
          this.saved.remove(chip.query);
          this.render();
          this.onChange?.();
        });
        b.append(x);
      }
      nodes.push(b);
    }
    nodes.push(this.saveBtn);
    this.el.replaceChildren(...nodes);
    this.updateSave();
  }
}
