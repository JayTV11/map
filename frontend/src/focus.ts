import { ArcEngine } from "./arcs";
import { SEVERITY_COLOR, TrafficEvent } from "./types";

/** Owns the "pin one event as a static missile" workflow end to end:
 *  toggling ArcEngine's pinned state, highlighting the selected log row,
 *  and showing/hiding the focus banner. Centralizing it here means
 *  main.ts and eventLog.ts don't need to coordinate selection state with
 *  each other directly.
 *
 * The banner (not just the log row highlight) matters because the event
 * log caps at 60 entries (see eventLog.ts's MAX_ENTRIES) -- a pinned
 * event's row can scroll off and get pruned while the pin is still
 * active. Without a way to clear it that doesn't depend on the row still
 * existing, the user would be stuck with a permanent pin.
 */
export class FocusController {
  private selectedId: string | null = null;
  private selectedEl: HTMLElement | null = null;

  constructor(
    private engine: ArcEngine,
    private banner: HTMLElement,
    private dot: HTMLElement,
    private text: HTMLElement,
    clearButton: HTMLElement,
  ) {
    clearButton.addEventListener("click", () => this.clear());
  }

  /** Call from the log row's click/keydown handler. Clicking the
   *  already-pinned row unpins it (toggle), matching how the severity
   *  checkboxes and live-feed switch behave elsewhere in this app. */
  toggle(event: TrafficEvent, el: HTMLElement): void {
    if (this.selectedId === event.id) {
      this.clear();
      return;
    }

    this.selectedEl?.classList.remove("selected");
    el.classList.add("selected");
    this.selectedId = event.id;
    this.selectedEl = el;
    this.engine.pin(event);

    this.dot.style.background = SEVERITY_COLOR[event.severity];
    this.text.textContent = `${event.src_ip ?? "?"} → ${event.dst_ip ?? "?"}`;
    this.banner.hidden = false;
  }

  clear(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedId = null;
    this.selectedEl = null;
    this.engine.unpin();
    this.banner.hidden = true;
  }
}
