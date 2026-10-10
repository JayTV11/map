/** Small wall-display touches: a clock, and a slot for your organisation's logo.
 *  Both are shown in wall mode only (wall.css). */

const pad = (n: number): string => String(n).padStart(2, "0");

export interface ClockText {
  time: string;
  date: string;
  utc: string;
}

export function formatClock(d: Date, locale?: string): ClockText {
  return {
    time: d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    date: d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" }),
    utc: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`,
  };
}

/** Local time (large), the date, and UTC (for teams working across time zones). */
export class WallClock {
  private time = document.createElement("div");
  private sub = document.createElement("div");
  private timer: number;

  constructor(parent: HTMLElement) {
    const root = document.createElement("div");
    root.id = "wall-clock";
    this.time.className = "wc-time";
    this.sub.className = "wc-sub";
    root.append(this.time, this.sub);
    parent.append(root);
    this.render();
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  render(now = new Date()): void {
    const c = formatClock(now);
    this.time.textContent = c.time;
    this.sub.textContent = `${c.date} · ${c.utc}`;
  }

  dispose(): void { window.clearInterval(this.timer); }
}

/** Shows `logo.svg` or `logo.png` (served next to index.html) at the start of the top bar, if one exists.
 *  To brand the wall, put your file at frontend/public/logo.svg (or .png) and rebuild; with neither,
 *  nothing is shown. */
export function mountLogo(topbar: HTMLElement, candidates: string[] = ["logo.svg", "logo.png"]): void {
  const img = document.createElement("img");
  img.id = "brand-logo";
  img.alt = "";
  img.hidden = true;
  topbar.prepend(img);

  const tryNext = (i: number): void => {
    if (i >= candidates.length) { img.remove(); return; }
    img.onload = () => { img.hidden = false; };
    img.onerror = () => tryNext(i + 1);
    img.src = candidates[i];
  };
  tryNext(0);
}
