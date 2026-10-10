import { Severity, severityRank, TrafficEvent } from "./types";

/** Collapses repeated events into groups, and decides when a group is
 *  allowed to draw an arc.
 *
 *  A group is "same source, same destination, same signature". A scanner
 *  hitting you 400 times is one group with count 400 -- one log row, and a
 *  few heavy arcs instead of 400 thin ones. Every event still counts
 *  toward the group total and the top-talkers stats; only the DRAWING is
 *  throttled.
 *
 *  Pure logic with no DOM, so it can be tested on its own. Time is always
 *  passed in (ms since epoch) rather than read from a clock.
 */

export interface AggregatorOptions {
  /** A group with no new events for this long ends; the next event starts a fresh group (new log row, count back to 1). */
  quietMs: number;
  /** Minimum gap between arcs for ONE group. Events inside the gap are folded into the next arc's weight. */
  arcMinIntervalMs: number;
  /** Cap on arc weight (1 = a single plain event). */
  maxWeight: number;
  /** Cap on arcs drawn per second across ALL groups, so distributed floods can't swamp the renderer. */
  arcBudgetPerSec: number;
  /** Distinct destination ports remembered per group. */
  maxPortsTracked: number;
  /** Safety cap on live groups; the oldest are dropped past this. */
  maxGroups: number;
}

export const DEFAULT_OPTIONS: AggregatorOptions = {
  quietMs: 30_000,
  arcMinIntervalMs: 1_500,
  maxWeight: 6,
  arcBudgetPerSec: 40,
  maxPortsTracked: 64,
  maxGroups: 5_000,
};

export interface EventGroup {
  id: number;
  key: string;
  /** Most recent event in the group. */
  event: TrafficEvent;
  /** Highest severity seen in the group. */
  severity: Severity;
  count: number;
  firstSeen: number;
  lastSeen: number;
  dstPorts: Set<number>;
  lastArcAt: number;
  /** Events received since the last arc was drawn for this group. */
  pending: number;
}

export interface GroupSummary {
  count: number;
  firstSeen: number;
  lastSeen: number;
  dstPorts: number[];
}

export interface ArcRequest {
  event: TrafficEvent;
  /** 1 = plain arc; higher = heavier/brighter. */
  weight: number;
}

export interface IngestResult {
  group: EventGroup;
  /** True when this event started a new group (the caller should add a log row). */
  isNew: boolean;
  /** An arc to draw right now, or null if this event was folded into a later one. */
  arc: ArcRequest | null;
}


export function groupKey(e: TrafficEvent): string {
  const src = e.src_ip ?? `${e.src_lat},${e.src_lon}`;
  const dst = e.dst_ip ?? `${e.dst_lat},${e.dst_lon}`;
  return `${src}|${dst}|${e.signature ?? ""}`;
}

export function summarize(g: EventGroup): GroupSummary {
  return {
    count: g.count,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    dstPorts: [...g.dstPorts].sort((a, b) => a - b),
  };
}

export class Aggregator {
  private groups = new Map<string, EventGroup>();
  private nextId = 1;
  private tokens: number;
  private lastRefill = 0;

  constructor(private opts: AggregatorOptions = DEFAULT_OPTIONS) {
    this.tokens = opts.arcBudgetPerSec;
  }

  ingest(event: TrafficEvent, now: number): IngestResult {
    const key = groupKey(event);
    let group = this.groups.get(key);
    let isNew = false;

    if (!group || now - group.lastSeen > this.opts.quietMs) {
      group = {
        id: this.nextId++,
        key,
        event,
        severity: event.severity,
        count: 0,
        firstSeen: now,
        lastSeen: now,
        dstPorts: new Set(),
        lastArcAt: -Infinity,
        pending: 0,
      };
      this.groups.delete(key); // re-insert so Map order tracks recency of group START
      this.groups.set(key, group);
      isNew = true;
      while (this.groups.size > this.opts.maxGroups) {
        this.groups.delete(this.groups.keys().next().value as string);
      }
    }

    group.event = event;
    group.count += 1;
    group.pending += 1;
    group.lastSeen = now;
    if (severityRank(event.severity) > severityRank(group.severity)) group.severity = event.severity;
    if (event.dst_port !== null && group.dstPorts.size < this.opts.maxPortsTracked) {
      group.dstPorts.add(event.dst_port);
    }

    return { group, isNew, arc: this.tryDraw(group, now) };
  }

  /** Call every few hundred ms. Draws arcs that were held back (a burst
   *  that ended, or the global budget ran out) and drops groups that have
   *  gone quiet. */
  tick(now: number): ArcRequest[] {
    const out: ArcRequest[] = [];
    for (const [key, g] of this.groups) {
      if (now - g.lastSeen > this.opts.quietMs) {
        this.groups.delete(key);
        continue;
      }
      if (g.pending > 0) {
        const arc = this.tryDraw(g, now);
        if (arc) out.push(arc);
      }
    }
    return out;
  }

  get size(): number { return this.groups.size; }

  /** The live group an event belongs to, if it is still going (used to pin an arc clicked on the map). */
  find(e: TrafficEvent): EventGroup | undefined {
    return this.groups.get(groupKey(e));
  }

  private tryDraw(g: EventGroup, now: number): ArcRequest | null {
    if (now - g.lastArcAt < this.opts.arcMinIntervalMs) return null;
    if (!this.takeToken(now)) return null;

    const weight = Math.min(this.opts.maxWeight, 1 + Math.log2(g.pending));
    g.pending = 0;
    g.lastArcAt = now;
    return { event: { ...g.event, severity: g.severity }, weight };
  }

  private takeToken(now: number): boolean {
    if (this.lastRefill === 0) this.lastRefill = now;
    const refill = ((now - this.lastRefill) / 1000) * this.opts.arcBudgetPerSec;
    this.tokens = Math.min(this.opts.arcBudgetPerSec, this.tokens + Math.max(0, refill));
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
