import { computeArcGeometry } from "./arcGeometry";
import { DrawnArc, hitTest } from "./hitTest";
import { isKeyAsset, severityColor, TrafficEvent } from "./types";

interface ActiveArc {
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  color: string;
  start: number;
  duration: number;
  weight: number;
  /** Aimed at one of your key systems: its landing is drawn bigger and lingers. */
  key: boolean;
}

interface Ping {
  x: number; y: number; color: string; start: number; duration: number;
  weight: number;
  key: boolean;
}

// How much dimmer regular live traffic gets drawn while an event is
// pinned -- keeps the overall shape of traffic visible as context without
// competing with the pinned "missile" for attention.
const DIM_FACTOR = 0.22;

// The trail-fade (destination-out) can never quite reach zero on an 8-bit
// canvas: very faint pixels round back to themselves and stay forever, which
// shows up as ghost streaks across the map once traffic stops. After this
// many consecutive idle frames (~0.7s at 60fps, long enough for the trails
// to finish fading) the overlay is wiped clean.
const IDLE_CLEAR_FRAMES = 40;

// Zoomed in, the map is magnified but arcs are drawn at screen resolution, so they stay sharp.
// Sizes (dots, line widths, rings) grow more slowly than the map itself: with the map at 8x, an
// arc 8x thicker would be a smear. 0 = sizes never grow, 1 = they grow with the map.
const SIZE_GROWTH = 0.5;

export class ArcEngine {
  private ctx: CanvasRenderingContext2D;
  private active: ActiveArc[] = [];
  private pings: Ping[] = [];
  private hiddenSeverities = new Set<string>();
  private paused = false;
  private pinned: TrafficEvent | null = null;
  private idleFrames = 0;
  private drawn: DrawnArc[] = []; // recent arcs, for click-to-pin (hitTest.ts)
  // The map camera (see mapZoom.ts), read from the viewport's CSS transform every frame so it also follows
  // the wall tour's animated glides. Arcs are drawn through it, at the screen's own resolution.
  private cam = { s: 1, tx: 0, ty: 0 };
  private dpr = 1;
  private k = 1; // size factor for the current zoom (see SIZE_GROWTH)

  onActiveCountChange?: (n: number) => void;

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement, private viewport: HTMLElement | null = null) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((t) => this.tick(t));
  }

  setPaused(paused: boolean): void { this.paused = paused; }
  setHiddenSeverities(hidden: Set<string>): void { this.hiddenSeverities = hidden; }

  /** Pin a single event as a persistent "missile" -- rendered every frame
   *  until unpin()'d, independent of the severity filter and the
   *  live/paused toggle (pinning is an explicit deep-dive, it shouldn't
   *  get hidden by whatever the ambient filters happen to be set to).
   *  Regular live traffic dims while a pin is active -- see DIM_FACTOR. */
  pin(event: TrafficEvent): void { this.pinned = event; }
  unpin(): void { this.pinned = null; }

  /** The recently drawn event nearest a click, in the map's own (unzoomed) pixel space, or null. */
  eventAt(x: number, y: number): TrafficEvent | null {
    return hitTest(this.drawn, x, y, this.wrap.clientWidth, this.wrap.clientHeight, Date.now());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = this.wrap.clientWidth * dpr;
    this.canvas.height = this.wrap.clientHeight * dpr;
    this.canvas.style.width = this.wrap.clientWidth + "px";
    this.canvas.style.height = this.wrap.clientHeight + "px";
  }

  /** Reads the camera from the map viewport. True when it moved since the last frame. */
  private readCamera(): boolean {
    if (!this.viewport) return false;
    const m = new DOMMatrix(getComputedStyle(this.viewport).transform);
    const s = m.a > 0 ? m.a : 1;
    const moved = Math.abs(s - this.cam.s) > 1e-4 || Math.abs(m.e - this.cam.tx) > 0.01 || Math.abs(m.f - this.cam.ty) > 0.01;
    this.cam = { s, tx: m.e, ty: m.f };
    this.k = Math.pow(s, SIZE_GROWTH - 1); // on-screen size = world size x s x k = size x s^SIZE_GROWTH
    return moved;
  }

  /** `weight` is 1 for a single plain event; the aggregator passes a
   *  higher value when one arc stands in for many events (see
   *  aggregator.ts), which draws it thicker and brighter. */
  spawn(event: TrafficEvent, weight = 1): void {
    if (this.paused) return;
    if (this.hiddenSeverities.has(event.severity)) return;

    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const geo = computeArcGeometry(event, w, h);

    this.active.push({
      ...geo,
      color: severityColor(event.severity),
      start: performance.now(),
      duration: 1100 + Math.random() * 900,
      weight,
      key: isKeyAsset(event.dst_asset),
    });

    const now = Date.now();
    this.drawn.push({ event, at: now });
    if (this.drawn.length > 400) this.drawn.splice(0, this.drawn.length - 300);
  }

  private arcPoint(a: ActiveArc, t: number): [number, number] {
    const mt = 1 - t;
    return [
      mt * mt * a.x1 + 2 * mt * t * a.cx + t * t * a.x2,
      mt * mt * a.y1 + 2 * mt * t * a.cy + t * t * a.y2,
    ];
  }

  private glowDot(x: number, y: number, r: number, color: string, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    r *= this.k;
    ctx.shadowBlur = r * 4 * this.cam.s * this.dpr; // shadows ignore the transform, so scale the blur by hand
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Draws the pinned "missile" (if any) at full brightness, on top of
   *  everything else: a dashed persistent line (dashed reads as "static
   *  selection", not "in-flight comet" like the live arcs) plus a gently
   *  pulsing glow at both endpoints so it's clearly alive/selected rather
   *  than looking like a dead leftover. Geometry is recomputed every frame
   *  from the event's lat/lon so it stays correct across window resizes. */
  private drawPinned(now: number, w: number, h: number): void {
    if (!this.pinned) return;
    const ctx = this.ctx;
    const g = computeArcGeometry(this.pinned, w, h);
    const color = severityColor(this.pinned.severity);
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6 * this.k;
    ctx.setLineDash([5 * this.k, 5 * this.k]);
    ctx.beginPath();
    ctx.moveTo(g.x1, g.y1);
    ctx.quadraticCurveTo(g.cx, g.cy, g.x2, g.y2);
    ctx.stroke();
    ctx.restore();

    this.glowDot(g.x1, g.y1, 4 + pulse * 1.5, color, 0.9);
    this.glowDot(g.x2, g.y2, 4 + pulse * 1.5, color, 0.9);

    ctx.save();
    ctx.globalAlpha = 0.3 + 0.25 * pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * this.k;
    ctx.beginPath();
    ctx.arc(g.x2, g.y2, (6 + pulse * 4) * this.k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private tick(now: number): void {
    const ctx = this.ctx;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    // Regular live traffic dims to this while something's pinned, so the
    // pinned missile (drawn last, at full brightness) reads as the focus
    // without the rest of the map going completely blank.
    const dim = this.pinned ? DIM_FACTOR : 1;

    // Fade trails without ever reaching opaque: destination-out on a
    // transparent overlay canvas, NOT a plain fillRect (a plain fillRect
    // accumulates toward solid black over many frames -- see the mockup's
    // notes on why this specific technique is used).
    // Fading and wiping work on the whole canvas, so they run untransformed; drawing then goes
    // through the camera. When the camera moves the old trails would hang in the wrong place on
    // screen, so they are wiped (arcs in flight redraw at once).
    const cameraMoved = this.readCamera();
    const k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cameraMoved) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = "source-over";
    }

    if (this.active.length > 0 || this.pings.length > 0) {
      this.idleFrames = 0;
    } else if (++this.idleFrames === IDLE_CLEAR_FRAMES) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); // wipe the un-fadeable residue (see IDLE_CLEAR_FRAMES)
    }
    const { s: cs, tx, ty } = this.cam;
    const d = this.dpr;
    ctx.setTransform(d * cs, 0, 0, d * cs, d * tx, d * ty);

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      const t = (now - a.start) / a.duration;
      if (t >= 1) {
        this.pings.push({ x: a.x2, y: a.y2, color: a.color, start: now, duration: a.key ? 1500 : 650, weight: a.weight, key: a.key });
        this.active.splice(i, 1);
        continue;
      }
      // weight 1 = a single plain event (looks exactly as before); higher
      // weights stand in for many events and read heavier.
      const extra = a.weight - 1;
      ctx.save();
      ctx.globalAlpha = Math.min(0.05 * (1 + extra * 0.8), 0.3) * dim;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = (1 + extra * 0.6) * k;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.quadraticCurveTo(a.cx, a.cy, a.x2, a.y2);
      ctx.stroke();
      ctx.restore();

      for (let k = 0; k < 6; k++) {
        const tt = Math.max(0, t - k * 0.02);
        const [px, py] = this.arcPoint(a, tt);
        const base = k === 0 ? 3.2 : 2.0;
        this.glowDot(px, py, base * (1 + extra * 0.2), a.color, (1 - k * 0.16) * dim);
      }
      if (t < 0.08) {
        this.glowDot(a.x1, a.y1, 3 + (0.08 - t) * 40, a.color, (0.08 - t) * 6 * dim);
      }
    }

    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      const pt = (now - p.start) / p.duration;
      if (pt >= 1) { this.pings.splice(i, 1); continue; }
      const extra = p.weight - 1;
      ctx.save();
      ctx.globalAlpha = (1 - pt) * dim;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = (2 + extra * 0.4) * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (3 + pt * 22 * (1 + extra * 0.15)) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this.glowDot(p.x, p.y, 2.5 * (1 + extra * 0.15), p.color, (1 - pt) * dim);

      if (p.key) {
        // A hit on one of YOUR key systems: two wider, slower rings and a steady glow, so it stands
        // out from ordinary landings even from across the room.
        for (const [delay, reach] of [[0, 46], [0.22, 64]] as const) {
          const rt = (pt - delay) / (1 - delay);
          if (rt <= 0 || rt >= 1) continue;
          ctx.save();
          ctx.globalAlpha = (1 - rt) * 0.9 * dim;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3.2 * k;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (6 + rt * reach) * k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        this.glowDot(p.x, p.y, 6, p.color, (1 - pt) * 0.8 * dim);
      }
    }

    this.drawPinned(now, w, h);

    this.onActiveCountChange?.(this.active.length);
    requestAnimationFrame((t) => this.tick(t));
  }
}
