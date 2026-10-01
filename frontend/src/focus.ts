import { ArcEngine } from "./arcs";
import { EventGroup, summarize } from "./aggregator";
import { DetailPanel } from "./detailPanel";
import { SEVERITY_COLOR } from "./types";

/** Owns the "pin one event as a static missile" workflow end to end:
 *  toggling ArcEngine's pinned state, highlighting the selected log row,
 *  showing/hiding the focus banner, and showing the alert detail panel
 *  for the pinned event. Centralizing it here means main.ts and
 *  eventLog.ts don't need to coordinate selection state with each other
 *  directly.
 *
 * What gets pinned is a GROUP of repeated events (see aggregator.ts). The
 * detail panel shows the group's running totals and is refreshed via
 * refresh() as more events join it.
 *
 * The banner (not just the log row highlight) matters because the event
 * log caps at 60 entries (see eventLog.ts's MAX_ENTRIES) -- a pinned
 * event's row can scroll off and get pruned while the pin is still
 * active. Without a way to clear it that doesn't depend on the row still
 * existing, the user would be stuck with a permanent pin.
 */
export class FocusController {
  private selectedId: number | null = null;
  private selectedEl: HTMLElement | null = null;

  constructor(
    private engine: ArcEngine,
    private detail: DetailPanel,
    private banner: HTMLElement,
    private dot: HTMLElement,
    private text: HTMLElement,
    clearButton: HTMLElement,
  ) {
    clearButton.addEventListener("click", () => this.clear());
    // The detail panel's close button and Esc also unpin the event.
    this.detail.onClose = () => this.clear();
  }

  /** Call from the log row's click/keydown handler. Clicking the
   *  already-pinned row unpins it (toggle), matching how the severity
   *  checkboxes and live-feed switch behave elsewhere in this app. */
  toggle(group: EventGroup, el: HTMLElement): void {
    if (this.selectedId === group.id) {
      this.clear();
      return;
    }

    this.selectedEl?.classList.remove("selected");
    el.classList.add("selected");
    this.selectedId = group.id;
    this.selectedEl = el;
    this.engine.pin(group.event);
    this.detail.show(group.event, summarize(group));

    const e = group.event;
    this.dot.style.background = SEVERITY_COLOR[group.severity];
    this.text.textContent = `${e.src_ip ?? "?"} \u2192 ${e.dst_ip ?? "?"}`;
    this.banner.hidden = false;
  }

  /** Re-renders the detail panel if `group` is the pinned one. Called
   *  whenever the group receives another event. */
  refresh(group: EventGroup): void {
    if (this.selectedId !== group.id) return;
    this.detail.show(group.event, summarize(group));
  }

  clear(): void {
    this.selectedEl?.classList.remove("selected");
    this.selectedId = null;
    this.selectedEl = null;
    this.engine.unpin();
    this.detail.hide(false);
    this.banner.hidden = true;
  }
}
