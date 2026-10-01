/** Pan/zoom "camera" for the map.
 *
 * This deliberately only ever touches a CSS transform on #map-viewport,
 * which wraps BOTH the static SVG background (map.ts) and the fx canvas
 * (arcs.ts) as one unit. A CSS transform doesn't change an element's own
 * layout size, or its children's clientWidth/clientHeight -- so
 * map.ts's project() and ArcEngine's resize()/spawn() keep computing
 * pixel positions in the same untransformed coordinate space they always
 * have. The background and every arc/ping stay perfectly in sync under
 * zoom/pan for free, with no changes needed anywhere else.
 *
 * Known gap: this wires up wheel-zoom and single-pointer drag-to-pan
 * (which covers mouse and single-finger touch drag), plus on-screen +/-
 * /reset buttons. It does NOT implement two-finger pinch-to-zoom on
 * touchscreens -- worth adding if this ends up used on tablets.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 14;

// Scale thresholds at which progressively less-prominent city labels turn
// on (see map.ts's CITY_LABELS tiers and style.css's .label-city rules) --
// a population-ranked approximation of Google Maps' "more detail as you
// zoom in" behavior.
// (Must match CITY_ZOOM / COUNTRY_ZOOM in mapgen/gen-labels.js, which
// collision-checks every label against these exact zoom levels.)
const CITY_TIER_THRESHOLDS: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 4.5, 3: 8, 4: 12 };

export function wireMapZoom(viewport: HTMLElement, wrap: HTMLElement): { reset: () => void } {
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function clamp(): void {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    // Content is w*scale / h*scale at the current zoom. At scale === 1
    // that's exactly w/h, so this collapses tx/ty to 0 -- same
    // always-fully-visible framing as before pan/zoom existed.
    const minTx = Math.min(0, w - w * scale);
    const minTy = Math.min(0, h - h * scale);
    tx = Math.min(0, Math.max(minTx, tx));
    ty = Math.min(0, Math.max(minTy, ty));
  }

  function apply(): void {
    viewport.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // map-theme.css divides stroke widths by this so coastlines/borders stay
    // crisp hairlines at any zoom instead of thickening along with the map.
    wrap.style.setProperty("--zoom", String(scale));
    wrap.classList.toggle("zoomed", scale > MIN_SCALE);
    wrap.classList.toggle("zoom-tier-1", scale >= CITY_TIER_THRESHOLDS[1]);
    wrap.classList.toggle("zoom-tier-2", scale >= CITY_TIER_THRESHOLDS[2]);
    wrap.classList.toggle("zoom-tier-3", scale >= CITY_TIER_THRESHOLDS[3]);
    wrap.classList.toggle("zoom-tier-4", scale >= CITY_TIER_THRESHOLDS[4]);
  }

  /** Zoom by `factor`, keeping the content point under (clientX, clientY)
   *  fixed on-screen -- so scrolling in on a spot keeps that spot under
   *  the cursor instead of re-centering on the map. */
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = wrap.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const contentX = (mx - tx) / scale;
    const contentY = (my - ty) / scale;

    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    tx = mx - contentX * scale;
    ty = my - contentY * scale;
    clamp();
    apply();
  }

  function resetView(): void {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false },
  );

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTx = 0;
  let dragStartTy = 0;

  /** True only for pointer events that originated on the actual map
   *  surface (the SVG background / fx canvas inside #map-viewport) -- NOT
   *  on an overlay control like the zoom buttons. Those buttons are
   *  children of `wrap`, so their pointerdown/dblclick events bubble up
   *  to these listeners too; without this check, pressing a zoom button
   *  would start a drag-pan and capture the pointer to `wrap`, which
   *  hijacks the click before it ever reaches the button. */
  function isMapSurfaceEvent(e: Event): boolean {
    return e.target instanceof Node && viewport.contains(e.target);
  }

  wrap.addEventListener("pointerdown", (e) => {
    if (scale <= MIN_SCALE) return; // nothing to pan when fully zoomed out
    if (!isMapSurfaceEvent(e)) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartTx = tx;
    dragStartTy = ty;
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add("panning");
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    tx = dragStartTx + (e.clientX - dragStartX);
    ty = dragStartTy + (e.clientY - dragStartY);
    clamp();
    apply();
  });

  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    wrap.releasePointerCapture(e.pointerId);
    wrap.classList.remove("panning");
  }
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("dblclick", (e) => {
    if (!isMapSurfaceEvent(e)) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, 2);
  });

  document.getElementById("zoom-in")?.addEventListener("click", () => {
    const r = wrap.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.6);
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => {
    const r = wrap.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.6);
  });
  document.getElementById("zoom-reset")?.addEventListener("click", resetView);

  apply();
  return { reset: resetView };
}
