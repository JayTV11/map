import { url } from "./base";
/** What this server has seen from one source address: asked of the backend (/api/source-history), cached briefly,
 *  and announced when it arrives so the details can redraw. */

export interface Counted { name: string; n: number }
export interface SourceHistory {
  ip: string;
  first_seen: string;
  last_seen: string;
  events: number;
  distinct_targets: number;
  distinct_signatures: number;
  top_signatures: Counted[];
  top_targets: Counted[];
  top_ports: Counted[];
  severities: Record<string, number>;
}
export type HistoryState = { state: "loading" } | { state: "none" } | { state: "error" } | { state: "ready"; history: SourceHistory; feed: "live" | "simulated" };

const TTL_MS = 15_000;

export class SourceHistoryStore {
  private cache = new Map<string, { at: number; value: HistoryState }>();
  private inflight = new Set<string>();
  onChange?: (ip: string) => void;

  constructor(private now: () => number = () => Date.now(), private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  /** What is known right now; starts a fetch when there is nothing fresh. Never blocks. */
  get(ip: string): HistoryState {
    const hit = this.cache.get(ip);
    const fresh = hit !== undefined && this.now() - hit.at < TTL_MS;
    if (!fresh && !this.inflight.has(ip)) void this.load(ip);
    return hit?.value ?? { state: "loading" };
  }

  async load(ip: string): Promise<void> {
    this.inflight.add(ip);
    let value: HistoryState;
    try {
      const resp = await this.fetchImpl(url(`/api/source-history?ip=${encodeURIComponent(ip)}`), { cache: "no-store" });
      if (resp.status === 404) value = { state: "none" }; // an older backend
      else if (!resp.ok) throw new Error(String(resp.status));
      else {
        const body = (await resp.json()) as { source: "live" | "simulated" | null; history: SourceHistory | null };
        value = body.history && body.source ? { state: "ready", history: body.history, feed: body.source } : { state: "none" };
      }
    } catch {
      value = { state: "error" };
    } finally {
      this.inflight.delete(ip);
    }
    if (this.cache.size > 200) this.cache.clear();
    const before = this.cache.get(ip)?.value;
    this.cache.set(ip, { at: this.now(), value });
    // Redraw only when the answer actually changed, so repeats of an event don't keep rebuilding the details.
    if (JSON.stringify(before) !== JSON.stringify(value)) this.onChange?.(ip);
  }
}
