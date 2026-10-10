/** Day/night shading: a soft shadow over the half of the world where the sun
 *  is down right now, redrawn every minute. Purely decorative, and cheap --
 *  it is one SVG path computed from the clock, with no data and no network.
 *
 *  The math is the standard low-precision solar position (accurate to well
 *  under a degree), which is far finer than a shaded region on a wall map. */

const DEG = Math.PI / 180;
const SVG_W = 1000;
const SVG_H = 500;

export interface SunPosition {
  /** Declination: latitude the sun is directly over, degrees. */
  lat: number;
  /** Longitude the sun is directly over, degrees (-180..180). */
  lon: number;
}

export function sunPosition(date: Date): SunPosition {
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;                       // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;              // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / DEG - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: dec / DEG, lon };
}

/** True when the sun is below the horizon at this point. */
export function isNight(lat: number, lon: number, date: Date): boolean {
  const sun = sunPosition(date);
  const h = (lon - sun.lon) * DEG;
  const sinAlt = Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) + Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos(h);
  return sinAlt < 0;
}

/** SVG path (in the map's 1000x500 space) enclosing the night side. */
export function nightPath(date: Date, stepDeg = 2): string {
  const sun = sunPosition(date);
  // Right at an equinox the terminator is a straight meridian line; keep the maths away from tan(0).
  const decl = Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat;
  const tanDec = Math.tan(decl * DEG);
  const x = (lon: number) => ((lon + 180) / 360) * SVG_W;
  const y = (lat: number) => ((90 - lat) / 180) * SVG_H;

  const pts: string[] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const lat = Math.atan(-Math.cos((lon - sun.lon) * DEG) / tanDec) / DEG;
    pts.push(`${x(lon).toFixed(1)},${y(lat).toFixed(1)}`);
  }
  // Night lies on the pole side away from the sun: south of the curve when the sun is over the northern half.
  const edge = decl > 0 ? SVG_H : 0;
  return `M${pts.join("L")}L${SVG_W},${edge}L0,${edge}Z`;
}

/** Adds the shading to the map SVG (just above the borders, under the labels) and keeps it current. */
export function mountDayNight(container: HTMLElement, refreshMs = 60_000): () => void {
  const svg = container.querySelector("svg");
  if (!svg) return () => { /* no map to shade */ };
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "night-shade");
  const anchor = svg.querySelector(".borders");
  if (anchor) anchor.after(path);
  else svg.append(path);

  const update = () => path.setAttribute("d", nightPath(new Date()));
  update();
  const timer = window.setInterval(update, refreshMs);
  return () => { window.clearInterval(timer); path.remove(); };
}
