import { ipInNet, IpNet, parseNet } from "./ipmatch";

/** The known-good source list (backend/known_good.yaml), as the browser
 *  sees it: fetched from /api/known-good, matched against each event's
 *  SOURCE address. No DOM here -- viewFilters.ts shows it. */

export interface KnownGoodEntry {
  /** "source" (an address or range, the default) or "signature" (every event with this signature name). */
  kind?: "source" | "signature";
  cidr?: string;
  signature?: string;
  note: string;
  /** "file" = known_good.yaml (admin); "analyst" = added from the screen. */
  source?: "file" | "analyst";
  added_by?: string;
  added_at?: string;
}

interface Parsed extends KnownGoodEntry {
  net?: IpNet;
}

/** Same normalisation the server uses: case-insensitive, whitespace collapsed. */
export function normSignature(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface KnownGoodMatcher {
  readonly size: number;
  matches(ip: string | null | undefined): boolean;
  /** True when the event's source OR its signature is on the list. */
  matchesEvent(e: { src_ip?: string | null; signature?: string | null }): boolean;
}

const MAX_CACHE = 5_000;

export class KnownGoodList implements KnownGoodMatcher {
  private list: Parsed[] = [];
  private cache = new Map<string, Parsed | null>();
  private sigs = new Set<string>();
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
  /** True when analysts may also mute a whole signature (known_good: allow_signature_mute). */
  signatureMute = false;

  get entries(): readonly KnownGoodEntry[] { return this.list.map(({ net: _net, ...entry }) => entry); }

  find(ip: string | null | undefined): KnownGoodEntry | null {
    if (!ip || this.list.length === 0) return null;
    let hit = this.cache.get(ip);
    if (hit === undefined) {
      hit = this.list.find((p) => p.net !== undefined && ipInNet(ip, p.net)) ?? null;
      if (this.cache.size >= MAX_CACHE) this.cache.clear();
      this.cache.set(ip, hit);
    }
    return hit;
  }

  matches(ip: string | null | undefined): boolean {
    return this.find(ip) !== null;
  }

  /** The entry that mutes this signature, if any. */
  findSignature(signature: string | null | undefined): KnownGoodEntry | null {
    const n = normSignature(signature);
    if (!n || this.sigs.size === 0 || !this.sigs.has(n)) return null;
    return this.list.find((p) => p.kind === "signature" && normSignature(p.signature) === n) ?? null;
  }

  matchesEvent(e: { src_ip?: string | null; signature?: string | null }): boolean {
    return this.matches(e.src_ip) || this.sigs.has(normSignature(e.signature));
  }

  setEntries(entries: readonly KnownGoodEntry[], serverError: string | null = null): void {
    const parsed: Parsed[] = [];
    const sigs = new Set<string>();
    for (const e of entries) {
      if (e.kind === "signature") {
        const n = normSignature(e.signature);
        if (!n) continue;
        sigs.add(n);
        parsed.push({ kind: "signature", signature: e.signature, note: e.note ?? "", source: e.source, added_by: e.added_by, added_at: e.added_at });
        continue;
      }
      const net = e.cidr ? parseNet(e.cidr) : null;
      if (net) parsed.push({ kind: "source", cidr: e.cidr, note: e.note ?? "", source: e.source, added_by: e.added_by, added_at: e.added_at, net });
    }
    this.sigs = sigs;
    const sig = JSON.stringify([parsed.map((p) => [p.kind, p.cidr, p.signature, p.note, p.source, p.added_by]), serverError, this.editable, this.signatureMute]);
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
      const body = (await resp.json()) as { entries?: KnownGoodEntry[]; error?: string | null; editable?: boolean; signature_mute?: boolean };
      this.loadFailed = false;
      this.editable = body.editable === true;
      this.signatureMute = body.signature_mute === true;
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

  async addSignature(signature: string, note: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, "/api/known-good", { method: "POST", body: JSON.stringify({ signature, note }), headers: { "content-type": "application/json" } });
  }

  async remove(cidr: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, `/api/known-good?cidr=${encodeURIComponent(cidr)}`, { method: "DELETE" });
  }

  async removeSignature(signature: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
    return this.edit(fetchImpl, `/api/known-good?signature=${encodeURIComponent(signature)}`, { method: "DELETE" });
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
