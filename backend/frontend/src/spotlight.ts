import { groupKey } from "./aggregator";
import { sourceCountry } from "./countries";
import { isKeyAsset, severityColor, severityLabel, severityLevels, TrafficEvent } from "./types";

/** The wall's "spotlight card": when the most severe kind of alert hits one
 *  of your key systems, a card slides in saying what, from where, at whom --
 *  something to read at a glance from across the room, instead of only arcs.
 *
 *  What counts as worth a card:
 *    - the MOST severe level of your scale, and
 *    - if you have named your systems (assets.yaml), only when a key
 *      (high / critical) system is at either end; with no names configured,
 *      any event of that top level.
 *  The same test drives the optional desktop/sound alert (alerts.ts).
 *
 *  Cards don't pile up: one at a time, each shown for `showMs`, a short gap
 *  between, the same flow isn't repeated for `repeatMs`, and if several
 *  arrive while one is up the best waits its turn (a key-asset hit beats
 *  an ordinary top-level one; later beats earlier). Pure logic; time is
 *  passed in. */

export function isSpotlightWorthy(e: TrafficEvent, assetsConfigured: boolean): boolean {
  const top = severityLevels()[0]?.id;
  if (!top || e.severity !== top) return false;
  if (!assetsConfigured) return true;
  return isKeyAsset(e.dst_asset) || isKeyAsset(e.src_asset);
}

export interface SpotlightCard {
  event: TrafficEvent;
  shownAt: number;
  keyAsset: boolean;
  country: string | null;
}

export interface SpotlightOptions {
  showMs: number;
  gapMs: number;
  repeatMs: number;
}

export const DEFAULT_SPOTLIGHT_OPTIONS: SpotlightOptions = { showMs: 10_000, gapMs: 3_000, repeatMs: 60_000 };

export class SpotlightController {
  current: SpotlightCard | null = null;
  /** Fires when a card appears (with it) or goes away (null). */
  onChange?: (card: SpotlightCard | null) => void;

  private pending: TrafficEvent | null = null;
  private lastEnd = -Infinity;
  private recent = new Map<string, number>();

  constructor(private assetsConfigured: () => boolean, private opts: SpotlightOptions = DEFAULT_SPOTLIGHT_OPTIONS) {}

  offer(e: TrafficEvent, now: number): void {
    if (!isSpotlightWorthy(e, this.assetsConfigured())) return;
    const key = groupKey(e);
    const seen = this.recent.get(key);
    if (seen !== undefined && now - seen < this.opts.repeatMs) return;
    if (this.current && groupKey(this.current.event) === key) return;

    if (!this.current && now - this.lastEnd >= this.opts.gapMs) {
      this.show(e, now);
      return;
    }
    const better = !this.pending || isKeyAsset(e.dst_asset) || !isKeyAsset(this.pending.dst_asset);
    if (better) this.pending = e;
  }

  /** Call about once a second: ends an expired card and promotes a waiting one. */
  tick(now: number): void {
    if (this.current && now - this.current.shownAt >= this.opts.showMs) {
      this.current = null;
      this.lastEnd = now;
      this.onChange?.(null);
    }
    if (!this.current && this.pending && now - this.lastEnd >= this.opts.gapMs) {
      const e = this.pending;
      this.pending = null;
      this.show(e, now);
    }
  }

  private show(e: TrafficEvent, now: number): void {
    this.pending = null;
    this.recent.set(groupKey(e), now);
    if (this.recent.size > 200) {
      for (const [k, t] of this.recent) if (now - t > this.opts.repeatMs) this.recent.delete(k);
    }
    this.current = {
      event: e,
      shownAt: now,
      keyAsset: isKeyAsset(e.dst_asset) || isKeyAsset(e.src_asset),
      country: sourceCountry(e),
    };
    this.onChange?.(this.current);
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: signatures and names are untrusted data
  return e;
}

/** Draws the card. Visible in wall mode only (wall.css hides it otherwise). */
export class SpotlightView {
  private root = el("div", "spotlight");

  constructor(controller: SpotlightController, parent: HTMLElement) {
    this.root.id = "spotlight";
    this.root.hidden = true;
    this.root.setAttribute("role", "status");
    parent.append(this.root);
    controller.onChange = (card) => this.render(card);
  }

  private render(card: SpotlightCard | null): void {
    if (!card) {
      this.root.classList.remove("in");
      window.setTimeout(() => { if (!this.root.classList.contains("in")) this.root.hidden = true; }, 500);
      return;
    }
    const e = card.event;
    const color = severityColor(e.severity);
    const from = e.src_asset?.name ?? [e.src_ip ?? "unknown source", card.country].filter(Boolean).join(" · ");
    const to = e.dst_asset?.name ?? e.dst_ip ?? "unknown target";

    const tag = el("div", "sp-tag", `${severityLabel(e.severity).toUpperCase()}${card.keyAsset ? " · KEY ASSET" : ""}`);
    tag.style.color = color;
    const sig = el("div", "sp-sig", e.signature ?? "(no signature)");
    const flow = el("div", "sp-flow");
    flow.append(el("span", "sp-from", from), el("span", "sp-arrow", "→"), el("span", "sp-to", to));

    const nodes = [tag, sig, flow];
    const an = e.anomaly;
    if (an && an.level === "unusual" && !an.learning && an.reasons[0]) nodes.push(el("div", "sp-why", `Unusual: ${an.reasons[0]}`));
    this.root.replaceChildren(...nodes);
    this.root.style.setProperty("--sp-color", color);
    this.root.hidden = false;
    void this.root.offsetWidth; // restart the slide-in when a new card replaces the old one
    this.root.classList.add("in");
  }
}
