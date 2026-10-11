import { ipInNet, IpNet, parseNet } from "./ipmatch";

/** The known-good source list (backend/known_good.yaml), as the browser
 *  sees it: fetched from /api/known-good, matched against each event's
 *  SOURCE address. No DOM here -- viewFilters.ts shows it. */

export interface KnownGoodEntry {
  cidr: string;
  note: string;
  /** "file" = known_good.yaml (admin); "analyst" = added from the screen. */
  source?: "file" | "analyst";
  added_by?: string;
  added_at?: string;
}

interface Parsed extends KnownGoodEntry {
  net: IpNet;
}

export interface KnownGoodMatcher {
  readonly size: number;
  matches(ip: string | null | undefined): boolean;
}

const MAX_CACHE = 5_000;

export class KnownGoodList implements KnownGoodMatcher {
  private list: Parsed[] = [];
  private cache = new Map<string, Parsed | null>();
  private signature = "";
  private timer: number | undefined;

  /** The server's own complaint about the file (bad entries skipped, or a bad edit ignored). */
  serverError: string | null = null;
  /** True when the last fetch failed; the previous list stays in force. */
  loadFailed = false;
  /** Fires when the list or its error changed (not on every refresh). */
  onChange?: () => void;

  get size(): number { return this.list.length; }
  /** True when an admin has turned on editing from the screen (config.yaml known_good: editable). */
  editable = false;

  get entries(): readonly KnownGoodEntry[] { return this.list.map(({ net: _net, ...entry }) => entry); }

  find(ip: string | null | undefined): KnownGoodEntry | null {
    if (!ip || this.list.length === 0) return null;
    let hit = this.cache.get(ip);
    if (hit === undefined) {
      hit = this.list.find((p) => ipInNet(ip, p.net)) ?? null;
      if (this.cache.size >= MAX_CACHE) this.cache.clear();
      this.cache.set(ip, hit);
    }
    return hit;
  }

  matches(ip: string | null | undefined): boolean {
    return this.find(ip) !== null;
  }

  setEntries(entries: readonly KnownGoodEntry[], serverError: string | null = null): void {
    const parsed: Parsed[] = [];
    for (const e of entries) {
      const net = parseNet(e.cidr);
      if (net) parsed.push({ cidr: e.cidr, note: e.note ?? "", source: e.source, added_by: e.added_by, added_at: e.added_at, net });
    }
    const sig = JSON.stringify([parsed.map((p) => [p.cidr, p.note, p.source, p.added_by]), serverError, this.editable]);
    this.list = parsed;
    this.cache.clear();
    this.serverError = serverError;
    if (sig !== this.signature) {
      this.signature = sig;
      this.onChange?.();
    }
  }

  /** Re-reads the list. A failed fetch keeps the old list rather than un-muting the wall. */
  async refresh(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 3000);
    try {
      const resp = await fetchImpl("/api/known-good", { cache: "no-store", signal: ctl.signal });
      if (resp.status === 404) { // an older backend without the feature
        this.loadFailed = false;
        this.setEntries([]);
        return;
      }
      if (!resp.ok) throw new Error(String(resp.status));
      const body = (await resp.json()) as { entries?: KnownGoodEntry[]; error?: string | null; editable?: boolean };
      this.loadFailed = false;
      this.editable = body.editable === true;
      this.setEntries(Array.isArray(body.entries) ? body.entries : [], body.error ?? null);
    } catch {
      if (!this.loadFailed) {
        this.loadFailed = true;
        this.signature = ""; // so the UI hears about the failure
        this.onChange?.();
      }
    } finally {
      window.clearTimeout(timer);
    }
  }

  /** Adds a source from the screen. Resolves to an error message the analyst can read, or null on success. */
  async add(ip: string, note: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, "/api/known-good", { method: "POST", body: JSON.stringify({ ip, note }), headers: { "content-type": "application/json" } });
  }

  async remove(cidr: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, `/api/known-good?cidr=${encodeURIComponent(cidr)}`, { method: "DELETE" });
  }

  private async edit(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<string | null> {
    try {
      // The custom header is what the server checks to know the request came from this page.
      const resp = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-sightline-edit": "1" } });
      if (!resp.ok) {
        let detail = `The server said ${resp.status}.`;
        try {
          const j = (await resp.json()) as { detail?: unknown };
          if (typeof j.detail === "string") detail = j.detail;
        } catch { /* not JSON: keep the generic message */ }
        return detail;
      }
      await this.refresh(fetchImpl); // the change is live for this screen at once; other screens catch up within a minute
      return null;
    } catch {
      return "Couldn't reach the server. Nothing was changed.";
    }
  }

  /** Picks up edits to known_good.yaml without a page reload. */
  startPolling(everyMs = 60_000): void {
    this.stopPolling();
    this.timer = window.setInterval(() => void this.refresh(), everyMs);
  }

  stopPolling(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
