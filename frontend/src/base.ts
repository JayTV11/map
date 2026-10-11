// Where Sightline is mounted. The build uses relative asset paths and every
// request goes through url(), so one build works at "/" or at "/sightline/"
// (or anywhere else a reverse proxy puts it).
export function basePath(loc?: { href: string }): string {
  const l = loc ?? (typeof location !== "undefined" ? location : undefined);
  if (!l) return "/";
  try {
    const p = new URL(".", l.href).pathname;
    return p.endsWith("/") ? p : p + "/";
  } catch {
    return "/";
  }
}

/** url("/api/x?y=1") -> "<base>api/x?y=1" */
export function url(path: string, loc?: { href: string }): string {
  return basePath(loc) + path.replace(/^\/+/, "");
}

export function wsUrl(path: string, loc?: { href: string; protocol: string; host: string }): string {
  const l = loc ?? (typeof location !== "undefined" ? location : undefined);
  if (!l) return path;
  const proto = l.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${l.host}${url(path, l)}`;
}
