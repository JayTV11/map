import { groupKey } from "./aggregator";
import { isSpotlightWorthy } from "./spotlight";
import { TrafficEvent } from "./types";

/** Optional desktop notification and beep for the same events that earn a
 *  spotlight card (the most severe level, on a key system when you have named
 *  them). Off by default: a person turns it on, which is also the click the
 *  browser requires before it allows sound or notifications.
 *
 *  Rate limited so an attack does not turn into a car alarm: at most one alert
 *  per `minGapMs`, and the same flow is not announced twice within `repeatMs`. */

export class AlertGate {
  private lastAt = -Infinity;
  private recent = new Map<string, number>();

  constructor(
    private assetsConfigured: () => boolean,
    private minGapMs = 15_000,
    private repeatMs = 120_000,
  ) {}

  shouldAlert(e: TrafficEvent, now: number): boolean {
    if (!isSpotlightWorthy(e, this.assetsConfigured())) return false;
    if (now - this.lastAt < this.minGapMs) return false;
    const key = groupKey(e);
    const seen = this.recent.get(key);
    if (seen !== undefined && now - seen < this.repeatMs) return false;
    this.lastAt = now;
    this.recent.set(key, now);
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t > this.repeatMs) this.recent.delete(k);
    return true;
  }
}

export type AlertPermission = "off" | "on" | "sound-only";

export interface AlertEnv {
  /** Ask for notification permission; resolves to the browser's answer. */
  requestNotifications: () => Promise<"granted" | "denied" | "default" | "unsupported">;
  notify: (title: string, body: string) => void;
  beep: () => void;
}

/** The real browser plumbing, kept apart from the logic so tests can swap it. */
export function browserEnv(): AlertEnv {
  let ctx: AudioContext | null = null;
  return {
    requestNotifications: async () => {
      if (typeof Notification === "undefined") return "unsupported";
      if (Notification.permission !== "default") return Notification.permission;
      try { return await Notification.requestPermission(); } catch { return "denied"; }
    },
    notify: (title, body) => {
      try { if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body, tag: "sightline-alert" }); }
      catch { /* some browsers only allow notifications from a service worker; the beep still plays */ }
    },
    beep: () => {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx ??= new Ctor();
        void ctx.resume();
        const t = ctx.currentTime;
        for (const [i, f] of [880, 660].entries()) { // two short descending tones
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t + i * 0.18);
          g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
          o.connect(g).connect(ctx.destination);
          o.start(t + i * 0.18);
          o.stop(t + i * 0.18 + 0.18);
        }
      } catch { /* no audio available */ }
    },
  };
}

export class Alerter {
  private on = false;
  permission: AlertPermission = "off";
  onChange?: () => void;

  constructor(private gate: AlertGate, private env: AlertEnv = browserEnv()) {}

  get enabled(): boolean { return this.on; }

  /** Turn on or off. Turning on asks for notification permission; sound works either way. */
  async setEnabled(on: boolean): Promise<void> {
    if (!on) {
      this.on = false;
      this.permission = "off";
      this.onChange?.();
      return;
    }
    const answer = await this.env.requestNotifications();
    this.on = true;
    this.permission = answer === "granted" ? "on" : "sound-only";
    this.env.beep(); // doubles as a test, and satisfies the browser's "sound needs a click" rule
    this.onChange?.();
  }

  offer(e: TrafficEvent, now: number): void {
    if (!this.on || !this.gate.shouldAlert(e, now)) return;
    const target = e.dst_asset?.name ?? e.dst_ip ?? "unknown target";
    this.env.beep();
    if (this.permission === "on") this.env.notify(`Sightline: ${e.signature ?? "critical alert"}`, `${e.src_ip ?? "unknown source"} → ${target}`);
  }
}
