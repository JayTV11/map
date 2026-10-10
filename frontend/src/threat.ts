import { severityLevels, TrafficEvent } from "./types";

/** The wall's overall threat level: NORMAL, ELEVATED or HIGH.
 *
 *  It is a rate, not a verdict: each event adds a score by severity (the most
 *  severe level counts 10, the next 4, the next 2, everything else 1), and the
 *  level comes from how the score per minute over the last few minutes
 *  compares with what is normal for THIS network.
 *
 *  What "normal" means is yours to say, in one of two ways:
 *    - Fixed thresholds: set `threat_level: {elevated: N, high: M}` in
 *      backend/config.yaml (score per minute).
 *    - Learned (the default): the average over the preceding hour. It needs
 *      about 15 minutes of data after the page opens and shows LEARNING until
 *      then, because guessing a baseline would show a false "all clear" or a
 *      false alarm. It is only as good as that hour: a wall opened during an
 *      attack learns the attack as normal, so set fixed thresholds if that
 *      matters.
 *
 *  A level steps up immediately but only steps down after a minute below it,
 *  so a display doesn't flicker. Pure logic with no DOM; time is passed in. */

export type ThreatLevel = "learning" | "normal" | "elevated" | "high";

export interface ThreatThresholds {
  /** Score per minute at or above which the level is ELEVATED. */
  elevated?: number;
  /** Score per minute at or above which the level is HIGH. */
  high?: number;
}

export interface ThreatAssessment {
  level: ThreatLevel;
  /** Score per minute over the recent window. */
  rate: number;
  /** The learned baseline (score per minute), or null when fixed thresholds are in use or still learning. */
  baseline: number | null;
  /** One line saying why, for the tooltip. */
  reason: string;
}

export interface ThreatOptions {
  recentMin: number;
  baselineMin: number;
  /** Minutes of history needed beyond the recent window before a learned baseline is trusted. */
  learnMin: number;
  /** A baseline below this is treated as this, so one stray event on a quiet network isn't "10x normal". */
  baselineFloor: number;
  /** Learned mode: ratios to the baseline for each level, and the smallest rate that can reach them. */
  elevatedRatio: number;
  highRatio: number;
  elevatedMinRate: number;
  highMinRate: number;
  /** How long a level must be unsupported before it steps down. */
  holdMs: number;
}

export const DEFAULT_THREAT_OPTIONS: ThreatOptions = {
  recentMin: 5,
  baselineMin: 60,
  learnMin: 10,
  baselineFloor: 5,
  elevatedRatio: 2,
  highRatio: 4,
  elevatedMinRate: 15,
  highMinRate: 30,
  holdMs: 60_000,
};

const ORDER: ThreatLevel[] = ["learning", "normal", "elevated", "high"];
const MIN_MS = 60_000;

/** Score for one event of the given severity level id. */
export function severityScore(id: string): number {
  const i = severityLevels().findIndex((l) => l.id === id);
  return i < 0 ? 1 : ([10, 4, 2][i] ?? 1);
}

export class ThreatMonitor {
  private minutes = new Map<number, number>(); // minute index -> score
  private firstMinute: number | null = null;
  private current: ThreatLevel = "learning";
  private heldSince = 0;

  constructor(private thresholds: ThreatThresholds = {}, private opts: ThreatOptions = DEFAULT_THREAT_OPTIONS) {}

  get fixedThresholds(): boolean {
    return this.thresholds.elevated !== undefined && this.thresholds.high !== undefined;
  }

  record(e: TrafficEvent, now: number): void {
    const m = Math.floor(now / MIN_MS);
    if (this.firstMinute === null) this.firstMinute = m;
    this.minutes.set(m, (this.minutes.get(m) ?? 0) + severityScore(e.severity));
    this.evict(m);
  }

  assess(now: number): ThreatAssessment {
    const m = Math.floor(now / MIN_MS);
    if (this.firstMinute === null) this.firstMinute = m; // the clock starts when the page does, quiet or not
    this.evict(m);
    const { recentMin, baselineMin, learnMin } = this.opts;

    // The newest minute is only partly elapsed, so divide by the time actually covered
    // instead of letting a half-finished minute drag the rate down.
    let recentSum = 0;
    for (let i = 0; i < recentMin; i++) recentSum += this.minutes.get(m - i) ?? 0;
    const covered = recentMin - 1 + Math.max((now % MIN_MS) / MIN_MS, 0.1);
    const rate = recentSum / covered;

    let level: ThreatLevel;
    let baseline: number | null = null;
    let reason: string;

    if (this.fixedThresholds) {
      const { elevated, high } = this.thresholds as Required<ThreatThresholds>;
      level = rate >= high ? "high" : rate >= elevated ? "elevated" : "normal";
      reason = `${rate.toFixed(0)}/min against your thresholds (elevated ${elevated}, high ${high})`;
    } else {
      const haveMin = this.firstMinute === null ? 0 : m - this.firstMinute;
      if (haveMin < recentMin + learnMin) {
        level = "learning";
        reason = `Learning what is normal for this network (${Math.max(0, recentMin + learnMin - haveMin)} more min)`;
      } else {
        // The baseline is the hour BEFORE the recent window, counting quiet minutes as zero.
        const span = Math.min(baselineMin, haveMin - recentMin);
        let sum = 0;
        for (let i = recentMin; i < recentMin + span; i++) sum += this.minutes.get(m - i) ?? 0;
        baseline = sum / span;
        const base = Math.max(baseline, this.opts.baselineFloor);
        const ratio = rate / base;
        if (ratio >= this.opts.highRatio && rate >= this.opts.highMinRate) level = "high";
        else if (ratio >= this.opts.elevatedRatio && rate >= this.opts.elevatedMinRate) level = "elevated";
        else level = "normal";
        reason = `${rate.toFixed(0)}/min now, ${ratio.toFixed(1)}x the usual ${base.toFixed(0)}/min`;
      }
    }

    // Step up at once; step down only after holdMs without support for the higher level.
    if (ORDER.indexOf(level) >= ORDER.indexOf(this.current) || this.current === "learning" || level === "learning") {
      if (level !== this.current) this.heldSince = now;
      this.current = level;
    } else if (now - this.heldSince >= this.opts.holdMs) {
      this.current = level;
      this.heldSince = now;
    }
    return { level: this.current, rate, baseline, reason };
  }

  private evict(m: number): void {
    const oldest = m - this.opts.baselineMin - this.opts.recentMin - 1;
    for (const k of this.minutes.keys()) if (k < oldest) this.minutes.delete(k);
  }
}
