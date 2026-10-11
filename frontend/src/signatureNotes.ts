import { url } from "./base";
/** Plain-English notes on alert types, written once by an admin (backend/signatures.yaml) and shown to every analyst.
 *  Fetched from /api/signature-notes; matched here so a new note shows on screen within a minute, no reload. */

export interface SignatureNote {
  match?: string;
  id?: string;
  what: string;
  action?: string;
  link?: string;
}

function globToRegex(pattern: string): RegExp {
  const body = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
}
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

interface Compiled { note: SignatureNote; re?: RegExp; exact?: string; rank: number }

export class SignatureNotes {
  private list: Compiled[] = [];
  private timer: number | undefined;
  onChange?: () => void;
  private sig = "";

  get size(): number { return this.list.length; }

  setNotes(notes: readonly SignatureNote[]): void {
    const next: Compiled[] = [];
    for (const n of notes) {
      if (!n || typeof n.what !== "string" || n.what === "") continue;
      if (n.id) next.push({ note: n, exact: String(n.id), rank: 1000 }); // an id is the most specific thing there is
      if (n.match) {
        const wild = n.match.includes("*");
        // exact name beats any pattern; among patterns, more literal characters beat fewer
        next.push({ note: n, re: wild ? globToRegex(n.match) : undefined, exact: wild ? undefined : norm(n.match), rank: wild ? n.match.replace(/\*/g, "").length : 900 });
      }
    }
    next.sort((a, b) => b.rank - a.rank);
    const sig = JSON.stringify(notes);
    this.list = next;
    if (sig !== this.sig) { this.sig = sig; this.onChange?.(); }
  }

  /** The most specific note for an alert, or null. */
  find(signature: string | null | undefined, signatureId?: string | null): SignatureNote | null {
    const name = signature ? norm(signature) : "";
    for (const c of this.list) {
      if (c.exact !== undefined) {
        if (c.note.id !== undefined && c.exact === String(c.note.id) && c.rank === 1000) {
          if (signatureId && String(signatureId) === c.exact) return c.note;
          continue;
        }
        if (name && c.exact === name) return c.note;
      } else if (c.re && signature && c.re.test(signature.trim())) return c.note;
    }
    return null;
  }

  async refresh(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 3000);
    try {
      const resp = await fetchImpl(url("/api/signature-notes"), { cache: "no-store", signal: ctl.signal });
      if (!resp.ok) return; // an older backend, or a blip: keep what we have
      const body = (await resp.json()) as { notes?: SignatureNote[] };
      this.setNotes(Array.isArray(body.notes) ? body.notes : []);
    } catch { /* keep the last notes */ } finally { window.clearTimeout(t); }
  }

  startPolling(everyMs = 60_000): void {
    this.stopPolling();
    this.timer = window.setInterval(() => void this.refresh(), everyMs);
  }
  stopPolling(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
