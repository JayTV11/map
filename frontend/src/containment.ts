/** Where each source stands in the response (investigating / escalated / blocked / false positive), shared by every
 *  analyst through the server (/api/containment). It only records what people did: it never blocks anything. */

export const STATUSES = ["investigating", "escalated", "blocked", "false_positive"] as const;
export type ContainmentStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<ContainmentStatus, string> = {
  investigating: "Investigating", escalated: "Escalated", blocked: "Blocked", false_positive: "False positive",
};
/** Three letters for the log row, where space is tight. */
export const STATUS_SHORT: Record<ContainmentStatus, string> = { investigating: "INV", escalated: "ESC", blocked: "BLK", false_positive: "FP" };

export interface ContainmentEntry {
  ip: string;
  status: ContainmentStatus;
  note: string;
  by: string;
  at: string;
}

export function isStatus(s: unknown): s is ContainmentStatus {
  return typeof s === "string" && (STATUSES as readonly string[]).includes(s);
}

export class ContainmentStore {
  private map = new Map<string, ContainmentEntry>();
  private timer: number | undefined;
  private sig = "";
  /** False when an admin turned the tracker off, or the server is too old to have it. */
  enabled = true;
  loaded = false;
  onChange?: () => void;

  get(ip: string | null | undefined): ContainmentEntry | null {
    return ip ? this.map.get(ip) ?? null : null;
  }
  get size(): number { return this.map.size; }
  entries(): ContainmentEntry[] { return [...this.map.values()]; }

  setEntries(entries: readonly ContainmentEntry[], enabled = true): void {
    const next = new Map<string, ContainmentEntry>();
    for (const e of entries) {
      if (e && typeof e.ip === "string" && isStatus(e.status)) next.set(e.ip, { ip: e.ip, status: e.status, note: String(e.note ?? ""), by: String(e.by ?? ""), at: String(e.at ?? "") });
    }
    const sig = JSON.stringify([[...next.values()], enabled]);
    this.map = next;
    this.enabled = enabled;
    this.loaded = true;
    if (sig !== this.sig) { this.sig = sig; this.onChange?.(); }
  }

  async refresh(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 3000);
    try {
      const resp = await fetchImpl("/api/containment", { cache: "no-store", signal: ctl.signal });
      if (resp.status === 404) { this.setEntries([], false); return; } // an older backend
      if (!resp.ok) return; // keep what we have
      const body = (await resp.json()) as { enabled?: boolean; entries?: ContainmentEntry[] };
      this.setEntries(Array.isArray(body.entries) ? body.entries : [], body.enabled !== false);
    } catch { /* keep the last list */ } finally { window.clearTimeout(t); }
  }

  /** Resolves to a message the analyst can read, or null on success. */
  async set(ip: string, status: ContainmentStatus, note: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, "/api/containment", { method: "PUT", body: JSON.stringify({ ip, status, note }), headers: { "content-type": "application/json" } });
  }

  async clear(ip: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, `/api/containment?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
  }

  private async edit(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<string | null> {
    try {
      const resp = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-sightline-edit": "1" } });
      if (!resp.ok) {
        let detail = `The server said ${resp.status}.`;
        try { const j = (await resp.json()) as { detail?: unknown }; if (typeof j.detail === "string") detail = j.detail; } catch { /* generic */ }
        return detail;
      }
      await this.refresh(fetchImpl);
      return null;
    } catch {
      return "Couldn't reach the server. Nothing was changed.";
    }
  }

  startPolling(everyMs = 15_000): void {
    this.stopPolling();
    this.timer = window.setInterval(() => void this.refresh(), everyMs);
  }
  stopPolling(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
