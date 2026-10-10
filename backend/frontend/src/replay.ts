import { BufferedEvent } from "./csv";

/** A short memory of what this screen has shown, used for "replay the last N
 *  minutes" and "export as CSV". It lives in the browser's memory only: it
 *  is gone when the page closes, and holds at most `maxAgeMs` / `maxItems`. */
export class EventHistory {
  private items: BufferedEvent[] = [];

  constructor(private maxAgeMs = 10 * 60_000, private maxItems = 6_000) {}

  add(event: BufferedEvent["event"], at: number): void {
    this.items.push({ event, at });
    const cutoff = at - this.maxAgeMs;
    let drop = 0;
    while (drop < this.items.length && this.items[drop].at < cutoff) drop++;
    if (this.items.length - drop > this.maxItems) drop = this.items.length - this.maxItems;
    if (drop > 0) this.items.splice(0, drop);
  }

  /** Events from the last `ms`, oldest first. */
  last(ms: number, now: number): BufferedEvent[] {
    const cutoff = now - ms;
    return this.items.filter((b) => b.at >= cutoff && b.at <= now);
  }

  get size(): number { return this.items.length; }
}

/** Plays a list of past events back faster than real time: an event that
 *  happened 3 minutes into the window comes out 3 minutes / speed after the
 *  start. Pure scheduling -- time is passed in, and what to do with each
 *  event (draw an arc) is the caller's business. */
export class Replayer {
  private items: BufferedEvent[] = [];
  private next = 0;
  private startedAt = 0;
  private speed = 1;
  private t0 = 0;
  private active = false;

  get playing(): boolean { return this.active; }

  start(items: readonly BufferedEvent[], speed: number, now: number): boolean {
    this.items = [...items].sort((a, b) => a.at - b.at);
    if (this.items.length === 0) { this.active = false; return false; }
    this.speed = Math.max(1, speed);
    this.t0 = this.items[0].at;
    this.startedAt = now;
    this.next = 0;
    this.active = true;
    return true;
  }

  stop(): void {
    this.active = false;
    this.items = [];
    this.next = 0;
  }

  /** Events that are due as of `now`. Stops itself after the last one. */
  tick(now: number): BufferedEvent[] {
    if (!this.active) return [];
    const elapsed = (now - this.startedAt) * this.speed;
    const due: BufferedEvent[] = [];
    while (this.next < this.items.length && this.items[this.next].at - this.t0 <= elapsed) {
      due.push(this.items[this.next++]);
    }
    if (this.next >= this.items.length) this.active = false;
    return due;
  }

  /** 0..1 */
  get progress(): number {
    return this.items.length === 0 ? 0 : this.next / this.items.length;
  }

  /** How much real time the whole replay takes, for the label. */
  get totalMs(): number {
    if (this.items.length === 0) return 0;
    return (this.items[this.items.length - 1].at - this.t0) / this.speed;
  }
}
