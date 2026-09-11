import { project } from "./map";
import { SEVERITY_COLOR, TrafficEvent } from "./types";

interface ActiveArc {
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  color: string;
  start: number;
  duration: number;
}

interface Ping {
  x: number; y: number; color: string; start: number; duration: number;
}

export class ArcEngine {
  private ctx: CanvasRenderingContext2D;
  private active: ActiveArc[] = [];
  private pings: Ping[] = [];
  private enabledSeverities = new Set<string>(["critical", "major", "high", "unknown"]);
  private paused = false;

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

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.wrap.clientWidth * dpr;
    this.canvas.height = this.wrap.clientHeight * dpr;
    this.canvas.style.width = this.wrap.clientWidth + "px";
    this.canvas.style.height = this.wrap.clientHeight + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  spawn(event: TrafficEvent): void {
    if (this.paused) return;
    if (!this.enabledSeverities.has(event.severity)) return;

    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const [x1, y1] = project(event.src_lat, event.src_lon, w, h);
    const [x2, y2] = project(event.dst_lat, event.dst_lon, w, h);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    const bow = Math.min(dist * 0.28, 140);
    const nx = -dy / dist, ny = dx / dist;
    const cx = mx + nx * bow, cy = my + ny * bow;

    this.active.push({
      x1, y1, x2, y2, cx, cy,
      color: SEVERITY_COLOR[event.severity],
      start: performance.now(),
      duration: 1100 + Math.random() * 900,
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

  private tick(now: number): void {
    const ctx = this.ctx;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;

    // Fade trails without ever reaching opaque: destination-out on a
    // transparent overlay canvas, NOT a plain fillRect (a plain fillRect
    // accumulates toward solid black over many frames -- see the mockup's
    // notes on why this specific technique is used).
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      const t = (now - a.start) / a.duration;
      if (t >= 1) {
        this.pings.push({ x: a.x2, y: a.y2, color: a.color, start: now, duration: 650 });
        this.active.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.quadraticCurveTo(a.cx, a.cy, a.x2, a.y2);
      ctx.stroke();
      ctx.restore();

      for (let k = 0; k < 6; k++) {
        const tt = Math.max(0, t - k * 0.02);
        const [px, py] = this.arcPoint(a, tt);
        this.glowDot(px, py, k === 0 ? 3.2 : 2.0, a.color, 1 - k * 0.16);
      }
      if (t < 0.08) {
        this.glowDot(a.x1, a.y1, 3 + (0.08 - t) * 40, a.color, (0.08 - t) * 6);
      }
    }

    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      const pt = (now - p.start) / p.duration;
      if (pt >= 1) { this.pings.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - pt;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 + pt * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this.glowDot(p.x, p.y, 2.5, p.color, 1 - pt);
    }

    this.onActiveCountChange?.(this.active.length);
    requestAnimationFrame((t) => this.tick(t));
  }
}