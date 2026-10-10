/** Wall-mode auto-tour: when nobody has touched the screen for a while, the
 *  map slowly cycles between the whole world, your home site, and the
 *  countries sending the most traffic, then back. It stops the moment someone
 *  uses the screen, and starts again after the next quiet spell.
 *
 *  Needs no data of its own: it asks for the busiest countries (and where
 *  their traffic sits) each time it picks the next stop, so it follows what
 *  is actually happening. Turn it off with ?tour=0. Pure logic: time and
 *  the camera are passed in, so it can be tested without a browser. */

export interface TourPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface TourHooks {
  /** Wall mode is on. */
  active: () => boolean;
  /** Milliseconds since anyone last touched the screen. */
  idleMs: () => number;
  home: () => TourPlace;
  /** Busiest source countries right now, busiest first. */
  topCountries: () => TourPlace[];
  focus: (lat: number, lon: number, scale: number) => void;
  reset: () => void;
}

export interface TourOptions {
  startAfterMs: number;
  worldDwellMs: number;
  regionDwellMs: number;
  regionScale: number;
}

export const DEFAULT_TOUR_OPTIONS: TourOptions = {
  startAfterMs: 30_000,
  worldDwellMs: 25_000,
  regionDwellMs: 14_000,
  regionScale: 3.4,
};

interface Stop {
  kind: "world" | "place";
  place?: TourPlace;
}

export class Tour {
  private running = false;
  private step = 0;
  private nextAt = 0;
  /** What the tour is showing right now, for tests and the tooltip. */
  currentLabel = "";

  constructor(private hooks: TourHooks, private opts: TourOptions = DEFAULT_TOUR_OPTIONS) {}

  get isRunning(): boolean { return this.running; }

  /** Call about once a second. */
  tick(now: number): void {
    if (!this.hooks.active() || this.hooks.idleMs() < this.opts.startAfterMs) {
      this.running = false; // someone is using it (or wall mode is off): hands off
      return;
    }
    if (!this.running) {
      this.running = true;
      this.step = 0;
      this.nextAt = now;
    }
    if (now < this.nextAt) return;

    const stops = this.plan();
    const stop = stops[this.step % stops.length];
    this.step += 1;
    if (stop.kind === "world") {
      this.hooks.reset();
      this.currentLabel = "World";
      this.nextAt = now + this.opts.worldDwellMs;
    } else {
      this.hooks.focus(stop.place!.lat, stop.place!.lon, this.opts.regionScale);
      this.currentLabel = stop.place!.name;
      this.nextAt = now + this.opts.regionDwellMs;
    }
  }

  /** world, home, busiest country, world, second busiest, third busiest -- skipping any that don't exist yet. */
  private plan(): Stop[] {
    const top = this.hooks.topCountries();
    const stops: Stop[] = [{ kind: "world" }, { kind: "place", place: this.hooks.home() }];
    if (top[0]) stops.push({ kind: "place", place: top[0] });
    stops.push({ kind: "world" });
    if (top[1]) stops.push({ kind: "place", place: top[1] });
    if (top[2]) stops.push({ kind: "place", place: top[2] });
    return stops;
  }
}
