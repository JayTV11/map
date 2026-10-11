import { TrafficEvent } from "./types";

/** Two windows of the same Sightline (say the map on the TV and the log on a second monitor) share ONE thing: which
 *  alert is pinned. Pin in either and the other follows. Search, filters, sorting and notes stay per window.
 *  Same browser only (BroadcastChannel); a window on another machine is a separate session. */

export type ViewMode = "full" | "console" | "map";

/** ?view=console: the log, details and search only. ?view=map: the map only. Anything else: the normal page. */
export function viewMode(search: string): ViewMode {
  const v = new URLSearchParams(search).get("view");
  return v === "console" || v === "map" ? v : "full";
}

export type SyncMsg = { type: "pin"; event: TrafficEvent } | { type: "unpin" };

/** Accepts only what this module sends: another tab on the same origin can post anything. */
export function parseSyncMessage(data: unknown): SyncMsg | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "unpin") return { type: "unpin" };
  if (d.type !== "pin") return null;
  const e = d.event as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return null;
  if (typeof e.severity !== "string" || typeof e.src_lat !== "number" || typeof e.dst_lat !== "number" ||
      typeof e.src_lon !== "number" || typeof e.dst_lon !== "number") return null;
  if ((e.src_ip !== null && typeof e.src_ip !== "string") || (e.dst_ip !== null && typeof e.dst_ip !== "string")) return null;
  if (e.signature !== null && typeof e.signature !== "string") return null;
  return { type: "pin", event: e as unknown as TrafficEvent };
}

interface ChannelLike {
  postMessage(m: unknown): void;
  addEventListener(t: "message", fn: (ev: { data: unknown }) => void): void;
  close(): void;
}

export class WindowSync {
  private ch: ChannelLike | null = null;
  constructor(onMessage: (m: SyncMsg) => void, make: (() => ChannelLike) | null = typeof BroadcastChannel === "undefined" ? null : () => new BroadcastChannel("sightline-sync")) {
    try {
      this.ch = make ? make() : null;
      this.ch?.addEventListener("message", (ev) => { const m = parseSyncMessage(ev.data); if (m) onMessage(m); });
    } catch { this.ch = null; } // blocked storage partitioning etc.: the windows just work independently
  }
  get available(): boolean { return this.ch !== null; }
  post(m: SyncMsg): void { try { this.ch?.postMessage(m); } catch { /* not worth stopping for */ } }
  close(): void { try { this.ch?.close(); } catch { /* already closed */ } }
}
