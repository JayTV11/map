/** Click-to-pin on the map. Reports the click position in the map's own
 *  (unzoomed) pixel space -- the space ArcEngine and project() work in -- so
 *  it stays correct while the map is zoomed or panned. A drag (panning) or a
 *  long press is not a click. */
export function wireMapPick(
  wrap: HTMLElement,
  viewport: HTMLElement,
  canvas: HTMLCanvasElement,
  onPick: (x: number, y: number) => void,
): void {
  let down: { x: number; y: number; t: number; onMap: boolean } | null = null;

  wrap.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: Date.now(), onMap: e.target instanceof Node && viewport.contains(e.target) };
  });

  wrap.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || !d.onMap) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || Date.now() - d.t > 600) return;
    // getBoundingClientRect includes the CSS zoom transform, so rect.width / clientWidth is the zoom factor.
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * wrap.clientWidth;
    const y = ((e.clientY - rect.top) / rect.height) * wrap.clientHeight;
    onPick(x, y);
  });

  wrap.addEventListener("pointercancel", () => { down = null; });
}
