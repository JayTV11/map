export interface KioskOptions {
  /** Return to the world view and drop any pin after this long with no input. */
  idleResetMs?: number;
  /** Hide the mouse cursor after this long with no input. */
  cursorHideMs?: number;
  onIdle?: () => void;
}

/** Wall-display mode. Press K (or open the page with ?kiosk=1) to hide the
 *  analyst controls, enlarge the text, go fullscreen, keep the screen awake,
 *  and make the display recover on its own: if someone zooms in or pins an
 *  event and walks away, it returns to the world view after a couple of
 *  minutes so the wall never sits on a stale close-up.
 *
 *  The layout itself is pure CSS keyed off `body.kiosk` (see wall.css). */
export class Kiosk {
  private active = false;
  private lastActivity = Date.now();
  private idleFired = false;
  private wakeLock: WakeLockSentinel | null = null;
  private hint = document.createElement("div");
  private hintTimer = 0;
  private readonly idleResetMs: number;
  private readonly cursorHideMs: number;

  constructor(private opts: KioskOptions = {}) {
    this.idleResetMs = opts.idleResetMs ?? 120_000;
    this.cursorHideMs = opts.cursorHideMs ?? 4_000;

    this.hint.id = "kiosk-hint";
    this.hint.hidden = true;
    document.body.append(this.hint);

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" ||
        (t.tagName === "INPUT" && !["range", "checkbox", "file"].includes((t as HTMLInputElement).type)));
      if (e.key.toLowerCase() === "k" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) this.toggle();
    });
    for (const ev of ["pointermove", "pointerdown", "wheel", "keydown"]) {
      window.addEventListener(ev, () => this.activity(), { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.active) void this.requestWakeLock();
    });
    window.setInterval(() => this.checkIdle(), 1000);

    if (new URLSearchParams(location.search).get("kiosk") === "1") this.enable(false);
  }

  get isActive(): boolean { return this.active; }

  /** Milliseconds since anyone last touched the screen. */
  get idleMs(): number { return Date.now() - this.lastActivity; }

  toggle(): void {
    if (this.active) this.disable();
    else this.enable(true);
  }

  enable(fullscreen: boolean): void {
    this.active = true;
    document.body.classList.add("kiosk");
    this.activity();
    this.showHint("Wall mode \u2014 press K to exit");
    if (fullscreen) void document.documentElement.requestFullscreen?.().catch(() => { /* needs a user gesture; F11 works too */ });
    void this.requestWakeLock();
    this.relayout();
  }

  disable(): void {
    this.active = false;
    document.body.classList.remove("kiosk", "cursor-hidden");
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => { /* ignore */ });
    void this.wakeLock?.release().catch(() => { /* ignore */ });
    this.wakeLock = null;
    this.relayout();
  }

  /** Called every second; public so it can be driven directly in tests. */
  checkIdle(now = Date.now()): void {
    if (!this.active) return;
    const idle = now - this.lastActivity;
    document.body.classList.toggle("cursor-hidden", idle > this.cursorHideMs);
    if (idle > this.idleResetMs && !this.idleFired) {
      this.idleFired = true;
      this.opts.onIdle?.();
    }
  }

  private activity(): void {
    this.lastActivity = Date.now();
    this.idleFired = false;
    document.body.classList.remove("cursor-hidden");
  }

  private showHint(text: string): void {
    this.hint.textContent = text;
    this.hint.hidden = false;
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { this.hint.hidden = true; }, 4000);
  }

  /** The sidebar changes width in wall mode, so the map area (and the arc
   *  canvas sized from it) has to be re-measured. ArcEngine listens for resize. */
  private relayout(): void {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  private async requestWakeLock(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null; // unsupported or denied; the OS screensaver settings still apply
    }
  }
}
