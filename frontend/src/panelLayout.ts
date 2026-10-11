import { LayoutState, clampHeight, isDefaultLayout, mergeOrder, moveStep, parseLayout } from "./layoutState";

const STORE_KEY = "sightline:panel-layout";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Panel {
  id: string;
  section: HTMLElement;
  header: HTMLElement;
  title: HTMLElement;
  defaultCollapsed: boolean;
}

/** Lets the analyst fold, resize and reorder the panels in the right-hand column, and remembers it
 *  (in this browser only). Each panel gets: a title you click to fold it, a grip in the left margin
 *  (drag it, or focus it and press Alt+Up / Alt+Down) and a handle on its bottom edge to resize
 *  (double-click the handle to undo the resize). Wall mode ignores folding and sizes.
 *  Call it once, after every panel has been added to the sidebar. */
export class PanelLayout {
  private panels: Panel[] = [];
  private state: LayoutState = parseLayout(null);
  private defaultOrder: string[] = [];
  private resetBtn = el("button", "pl-reset", "Reset panel layout");

  constructor(private sidebar: HTMLElement) {
    for (const section of Array.from(sidebar.querySelectorAll<HTMLElement>(":scope > .panel-section"))) {
      const title = section.querySelector<HTMLElement>("h2");
      if (!title) continue;
      let header: HTMLElement = title;
      while (header.parentElement && header.parentElement !== section) header = header.parentElement;
      if (!section.id) section.id = `pl-${(title.textContent ?? "panel").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      this.panels.push({ id: section.id, section, header, title, defaultCollapsed: section.dataset.collapsed === "1" });
    }
    this.defaultOrder = this.panels.map((p) => p.id);
    this.state = this.load();

    for (const p of this.panels) this.decorate(p);
    this.applyOrder(mergeOrder(this.defaultOrder, this.state.order));
    for (const p of this.panels) {
      this.setCollapsed(p, this.state.collapsed[p.id] ?? p.defaultCollapsed, false);
      const h = this.state.heights[p.id];
      if (h !== undefined) this.setHeight(p, h);
    }

    this.resetBtn.type = "button";
    this.resetBtn.addEventListener("click", () => this.reset());
    const footer = el("div", "pl-footer");
    footer.append(this.resetBtn);
    sidebar.append(footer);
    this.syncResetButton();
  }

  // ---- persistence -----------------------------------------------------------------
  private load(): LayoutState {
    try {
      return parseLayout(JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"));
    } catch {
      return parseLayout(null);
    }
  }

  private save(): void {
    this.state.order = this.currentOrder();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* storage blocked: the layout still works, it just is not remembered */ }
    this.syncResetButton();
  }

  private currentOrder(): string[] {
    return Array.from(this.sidebar.querySelectorAll<HTMLElement>(":scope > .panel-section")).map((s) => s.id).filter((id) => this.panels.some((p) => p.id === id));
  }

  private syncResetButton(): void {
    const dirty = !isDefaultLayout({ ...this.state, order: this.currentOrder() }, this.defaultOrder, (id) => this.panels.find((p) => p.id === id)?.defaultCollapsed ?? false);
    this.resetBtn.hidden = !dirty;
  }

  /** The layout as it is now, for saving into a view. */
  getState(): LayoutState {
    const collapsed: Record<string, boolean> = {};
    for (const p of this.panels) collapsed[p.id] = p.section.classList.contains("pl-collapsed");
    return { order: this.currentOrder(), collapsed, heights: { ...this.state.heights } };
  }

  /** Puts the panels into a saved layout (and remembers it, like any change the analyst makes by hand). */
  applyState(next: LayoutState): void {
    this.state = { order: [], collapsed: { ...next.collapsed }, heights: { ...next.heights } };
    this.applyOrder(mergeOrder(this.defaultOrder, next.order));
    for (const p of this.panels) {
      this.setCollapsed(p, next.collapsed[p.id] ?? p.defaultCollapsed, false);
      const h = next.heights[p.id];
      if (h !== undefined) this.setHeight(p, h);
      else this.clearHeight(p);
    }
    this.save();
  }

  reset(): void {
    this.state = parseLayout(null);
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    this.applyOrder(this.defaultOrder);
    for (const p of this.panels) {
      this.setCollapsed(p, p.defaultCollapsed, false);
      this.clearHeight(p);
    }
    this.syncResetButton();
  }

  // ---- per-panel controls ----------------------------------------------------------
  private decorate(p: Panel): void {
    p.header.classList.add("pl-header");
    p.title.tabIndex = 0;
    p.title.setAttribute("role", "button");
    p.title.title = "Click to fold or unfold";

    const toggle = (): void => this.setCollapsed(p, !p.section.classList.contains("pl-collapsed"), true);
    p.header.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, input, select, a, label, .pl-grip")) return; // the header can hold its own controls
      toggle();
    });
    p.title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    const grip = el("div", "pl-grip", "⋮⋮");
    grip.tabIndex = 0;
    grip.setAttribute("role", "button");
    grip.setAttribute("aria-label", `Move the ${p.title.textContent ?? ""} panel. Drag it, or press Alt+Up or Alt+Down.`);
    grip.title = "Drag to move (or Alt+Up / Alt+Down)";
    this.wireGrip(p, grip);
    p.section.append(grip);

    const handle = el("div", "pl-resize");
    handle.title = "Drag to resize. Double-click to undo.";
    this.wireResize(p, handle);
    p.section.append(handle);
  }

  private setCollapsed(p: Panel, collapsed: boolean, persist: boolean): void {
    p.section.classList.toggle("pl-collapsed", collapsed);
    p.title.setAttribute("aria-expanded", String(!collapsed));
    if (persist) {
      this.state.collapsed[p.id] = collapsed;
      this.save();
    }
  }

  private setHeight(p: Panel, px: number): void {
    p.section.classList.add("pl-sized");
    p.section.style.setProperty("--pl-h", `${px}px`);
  }

  private clearHeight(p: Panel): void {
    p.section.classList.remove("pl-sized");
    p.section.style.removeProperty("--pl-h");
  }

  private wireResize(p: Panel, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = p.section.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("pl-resizing");
      let h = startH;
      const move = (ev: PointerEvent): void => {
        h = clampHeight(startH + ev.clientY - startY);
        this.setHeight(p, h);
      };
      const up = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        document.body.classList.remove("pl-resizing");
        if (p.section.classList.contains("pl-sized")) {
          this.state.heights[p.id] = h;
          this.save();
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      this.clearHeight(p);
      delete this.state.heights[p.id];
      this.save();
    });
  }

  // ---- reordering ------------------------------------------------------------------
  private shown(id: string): boolean {
    const p = this.panels.find((x) => x.id === id);
    return !!p && !p.section.hidden;
  }

  private applyOrder(order: string[]): void {
    const footer = this.sidebar.querySelector(":scope > .pl-footer");
    for (const id of order) {
      const p = this.panels.find((x) => x.id === id);
      if (p) this.sidebar.insertBefore(p.section, footer);
    }
  }

  private wireGrip(p: Panel, grip: HTMLElement): void {
    grip.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const next = moveStep(this.currentOrder(), p.id, e.key === "ArrowUp" ? -1 : 1, (id) => this.shown(id));
      this.applyOrder(next);
      this.save();
      grip.focus();
      p.section.scrollIntoView({ block: "nearest" });
    });

    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      p.section.classList.add("pl-dragging");
      document.body.classList.add("pl-moving");
      let target: HTMLElement | null = null;
      let after = false;

      const clearMarks = (): void => {
        for (const q of this.panels) q.section.classList.remove("pl-drop-before", "pl-drop-after");
      };
      const move = (ev: PointerEvent): void => {
        clearMarks();
        target = null;
        const others = this.panels.filter((q) => q !== p && !q.section.hidden);
        for (const q of others) {
          const r = q.section.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { target = q.section; after = false; break; }
          target = q.section;
          after = true;
        }
        if (target) target.classList.add(after ? "pl-drop-after" : "pl-drop-before");
      };
      const up = (): void => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        clearMarks();
        p.section.classList.remove("pl-dragging");
        document.body.classList.remove("pl-moving");
        if (target && target !== p.section) {
          this.sidebar.insertBefore(p.section, after ? target.nextElementSibling : target);
          this.save();
        }
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
  }
}
