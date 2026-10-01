import { project } from "./map";
import { SEVERITY_COLOR, TrafficEvent } from "./types";

interface ActiveArc {
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  color: string;
  start: number;
  duration: number;
  weight: number;
}

interface Ping {
  x: number; y: number; color: string; start: number; duration: number;
  weight: number;
}

interface ArcGeometry {
  x1: number; y1: number; x2: number; y2: number; cx: number; cy: number;
}

/** Same src/dst -> quadratic-curve-control-point math used for every live
 *  arc. Pulled out so the pinned "missile" (see pin()/unpin() below) can
 *  recompute its geometry fresh every frame from the event's lat/lon,
 *  rather than caching stale pixel coordinates that would drift out of
 *  sync on window resize. */
function computeArcGeometry(event: TrafficEvent, w: number, h: number): ArcGeometry {
  const [x1, y1] = project(event.src_lat, event.src_lon, w, h);
  const [x2, y2] = project(event.dst_lat, event.dst_lon, w, h);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(dist * 0.28, 140);
  const nx = -dy / dist, ny = dx / dist;
  return { x1, y1, x2, y2, cx: mx + nx * bow, cy: my + ny * bow };
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

export class ArcEngine {
  private ctx: CanvasRenderingContext2D;
  private active: ActiveArc[] = [];
  private pings: Ping[] = [];
  private enabledSeverities = new Set<string>(["critical", "major", "high", "unknown"]);
  private paused = false;
  private pinned: TrafficEvent | null = null;
  private idleFrames = 0;

  onActiveCountChange?: (n: number) => void;

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((t) => this.tick(t));
  }

  setPaused(paused: boolean): void { this.paused = paused; }
  setEnabledSeverities(set: Set<string>): void { this.enabledSeverities = set; }

  /** Pin a single event as a persistent "missile" -- rendered every frame
   *  until unpin()'d, independent of the severity filter and the
   *  live/paused toggle (pinning is an explicit deep-dive, it shouldn't
   *  get hidden by whatever the ambient filters happen to be set to).
   *  Regular live traffic dims while a pin is active -- see DIM_FACTOR. */
  pin(event: TrafficEvent): void { this.pinned = event; }
  unpin(): void { this.pinned = null; }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.wrap.clientWidth * dpr;
    this.canvas.height = this.wrap.clientHeight * dpr;
    this.canvas.style.width = this.wrap.clientWidth + "px";
    this.canvas.style.height = this.wrap.clientHeight + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** `weight` is 1 for a single plain event; the aggregator passes a
   *  higher value when one arc stands in for many events (see
   *  aggregator.ts), which draws it thicker and brighter. */
  spawn(event: TrafficEvent, weight = 1): void {
    if (this.paused) return;
    if (!this.enabledSeverities.has(event.severity)) return;

    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const geo = computeArcGeometry(event, w, h);

    this.active.push({
      ...geo,
      color: SEVERITY_COLOR[event.severity],
      start: performance.now(),
      duration: 1100 + Math.random() * 900,
      weight,
    });
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
    ctx.shadowBlur = r * 4;
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
    const color = SEVERITY_COLOR[this.pinned.severity];
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 5]);
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
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.x2, g.y2, 6 + pulse * 4, 0, Math.PI * 2);
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
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    if (this.active.length > 0 || this.pings.length > 0) {
      this.idleFrames = 0;
    } else if (++this.idleFrames === IDLE_CLEAR_FRAMES) {
      ctx.clearRect(0, 0, w, h); // wipe the un-fadeable residue (see IDLE_CLEAR_FRAMES)
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      const t = (now - a.start) / a.duration;
      if (t >= 1) {
        this.pings.push({ x: a.x2, y: a.y2, color: a.color, start: now, duration: 650, weight: a.weight });
        this.active.splice(i, 1);
        continue;
      }
      // weight 1 = a single plain event (looks exactly as before); higher
      // weights stand in for many events and read heavier.
      const extra = a.weight - 1;
      ctx.save();
      ctx.globalAlpha = Math.min(0.05 * (1 + extra * 0.8), 0.3) * dim;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1 + extra * 0.6;
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
      ctx.lineWidth = 2 + extra * 0.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 + pt * 22 * (1 + extra * 0.15), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this.glowDot(p.x, p.y, 2.5 * (1 + extra * 0.15), p.color, (1 - pt) * dim);
    }

    this.drawPinned(now, w, h);

    this.onActiveCountChange?.(this.active.length);
    requestAnimationFrame((t) => this.tick(t));
  }
}
