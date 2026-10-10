import { ipInNet, IpNet, parseNet } from "./ipmatch";

/** The known-good source list (backend/known_good.yaml), as the browser
 *  sees it: fetched from /api/known-good, matched against each event's
 *  SOURCE address. No DOM here -- viewFilters.ts shows it. */

export interface KnownGoodEntry {
  cidr: string;
  note: string;
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
  get entries(): readonly KnownGoodEntry[] { return this.list.map(({ cidr, note }) => ({ cidr, note })); }

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
      if (net) parsed.push({ cidr: e.cidr, note: e.note ?? "", net });
    }
    const sig = JSON.stringify([parsed.map((p) => [p.cidr, p.note]), serverError]);
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
      const body = (await resp.json()) as { entries?: KnownGoodEntry[]; error?: string | null };
      this.loadFailed = false;
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
