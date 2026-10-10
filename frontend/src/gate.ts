import { CompiledQuery } from "./kql";
import { KnownGoodMatcher } from "./knownGood";
import { TrafficEvent } from "./types";

export type Verdict = "pass" | "muted" | "filtered";

/** Decides whether an incoming event is shown, and counts what it hides.
 *
 *  Two independent reasons to hide an event:
 *    - muted:    its SOURCE is on the known-good list and muting is on
 *    - filtered: it doesn't match the search bar's query
 *  Muted wins when both apply, so the "muted" count is everything the
 *  known-good list removed.
 *
 *  Hidden events are still counted here (and the caller still tells the
 *  feed-status monitor about them), so a hidden event never makes the feed
 *  look dead, and the wall always says how much it is hiding. */
export class EventGate {
  private query: CompiledQuery | null = null;
  private queryText = "";
  private muteOn = true; // muted by default on load

  mutedCount = 0;
  filteredCount = 0;
  /** Fires when the mute switch or the query changes, so callers can re-check what's already on screen. */
  onChange?: () => void;

  constructor(private knownGood: KnownGoodMatcher) {}

  get muteEnabled(): boolean { return this.muteOn; }
  get activeQuery(): string { return this.query ? this.queryText : ""; }
  get hasQuery(): boolean { return this.query !== null; }

  setMute(on: boolean): void {
    if (on === this.muteOn) return;
    this.muteOn = on;
    this.onChange?.();
  }

  /** Pass null (or an empty query) to clear the filter. */
  setQuery(query: CompiledQuery | null, text = ""): void {
    const next = query && !query.isEmpty ? query : null;
    const nextText = next ? text.trim() : "";
    if (nextText !== this.queryText) this.filteredCount = 0; // "hidden by this filter" restarts with each new filter
    this.query = next;
    this.queryText = nextText;
    this.onChange?.();
  }

  /** The known-good list was edited: the same re-check applies. */
  listChanged(): void { this.onChange?.(); }

  verdict(e: TrafficEvent): Verdict {
    if (this.muteOn && this.knownGood.matches(e.src_ip)) return "muted";
    if (this.query && !this.query.test(e)) return "filtered";
    return "pass";
  }

  passes(e: TrafficEvent): boolean { return this.verdict(e) === "pass"; }

  /** Count one hidden live event (replays are not counted: they re-fire events already counted). */
  count(v: Verdict): void {
    if (v === "muted") this.mutedCount += 1;
    else if (v === "filtered") this.filteredCount += 1;
  }
}
