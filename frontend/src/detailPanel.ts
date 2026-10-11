import { GroupSummary } from "./aggregator";
import { isPrivateIp, linksFor, LinkSpec } from "./links";
import { KnownGoodList } from "./knownGood";
import { openMuteConfirm } from "./muteConfirm";
import { PivotField } from "./pivot";
import { ReviewStore } from "./reviews";
import { SignatureNotes } from "./signatureNotes";
import { SourceHistory, SourceHistoryStore } from "./sourceHistory";
import { AssetRef, isKeyAsset, severityColor, severityLabel, severityLevels, TrafficEvent } from "./types";

function endpoint(ip: string | null, port: number | null): string {
  if (!ip) return "?";
  return port !== null ? `${ip}:${port}` : ip;
}

/** The YAML for one known-good entry, indented to paste under `sources:`. The IP is quoted-safe: it comes from the network. */
export function knownGoodEntry(ip: string, name: string | null): string {
  const safeIp = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(ip) ? ip : JSON.stringify(ip);
  const note = name ? `note: ${JSON.stringify(name)}` : "note: ";
  return `  - ip: ${safeIp}\n    ${note}`;
}

function assetText(a: AssetRef | null | undefined): string | null {
  return a ? `${a.name} (${a.criticality} priority)` : null;
}

const DIRECTION_TEXT = {
  inbound: "Inbound \u2014 from outside to one of our systems",
  outbound: "Outbound \u2014 from one of our systems to outside",
  internal: "Internal \u2014 between two of our systems",
} as const;

function formatPorts(ports: number[], limit = 8): string {
  const shown = ports.slice(0, limit).join(", ");
  return ports.length > limit ? `${shown} (+${ports.length - limit} more)` : shown;
}

/** What the pop-out needs from the log to step through events. Wired in main.ts. */
export interface DetailNav {
  position(): { index: number; total: number } | null;
  step(dir: -1 | 1): void;
  nextUnreviewed(): void;
}

export class DetailPanel {
  nav: DetailNav | null = null;
  /** The shared known-good list; with it (and editing turned on by an admin) a "Mute this source" button appears. */
  knownGood: KnownGoodList | null = null;
  /** Click a value to filter the screen to it (Shift-click adds it to the current search). Wired in main.ts. */
  onPivot: ((field: PivotField, value: string, and: boolean) => void) | null = null;
  /** What this server has seen from the source (asked of the backend; the details redraw when it arrives). */
  history: SourceHistoryStore | null = null;
  /** The admin's plain-English notes on alert types. */
  notes: SignatureNotes | null = null;
  /** Ticket and tool links from config.yaml. */
  links: readonly LinkSpec[] = [];
  private store: ReviewStore | null = null;

  get reviews(): ReviewStore | null { return this.store; }
  /** Marks and notes are shown and edited in the detail; a change made elsewhere (R in the log) redraws it. */
  set reviews(r: ReviewStore | null) {
    this.store = r;
    r?.subscribe((key) => { if (this.current?.key === key) this.redraw(); });
  }
  private section = document.getElementById("detail-section")!;
  private body = document.getElementById("detail-body")!;
  onClose?: () => void;
  private current: { e: TrafficEvent; summary?: GroupSummary; key?: string } | null = null;
  private overlay: HTMLElement | null = null;
  private lastFocus: HTMLElement | null = null;

  constructor() {
    document.getElementById("detail-close")!.addEventListener("click", () => this.hide());
    document.getElementById("detail-expand")!.addEventListener("click", () => this.expand());
    // Capture phase: with the large window open, Esc closes just that window
    // (not also the panel and the pin behind it).
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".mute-confirm")) return; // that dialog closes itself
      if (this.overlay) { e.stopPropagation(); e.preventDefault(); this.collapse(); return; }
      if (!this.section.hidden) this.hide();
    }, true);
    // In the large window: left/right step through the log, R marks reviewed. Not while typing a note.
    window.addEventListener("keydown", (e) => {
      if (!this.overlay || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); this.nav?.step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); this.nav?.step(1); }
      else if ((e.key === "r" || e.key === "R") && this.current?.key && this.reviews) {
        e.preventDefault();
        this.reviews.set(this.current.key, { reviewed: !this.reviews.isReviewed(this.current.key) });
      }
    });

  }

  get isExpanded(): boolean { return this.overlay !== null; }

  /** Opens the pinned event in a large window with every field, the extra source
   *  fields and the raw record. Stays in step as more repeats join the group. */
  expand(): void {
    if (!this.current || this.overlay) return;
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.className = "popout-overlay";
    overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) this.collapse(); });
    const dialog = document.createElement("div");
    dialog.className = "popout-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Alert details");
    overlay.append(dialog);
    document.body.append(overlay);
    this.overlay = overlay;
    this.renderPopout();
    dialog.querySelector<HTMLElement>(".popout-x")?.focus();
  }

  collapse(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.lastFocus?.focus?.();
    this.lastFocus = null;
  }

  private renderPopout(): void {
    const dialog = this.overlay?.querySelector<HTMLElement>(".popout-dialog");
    if (!dialog || !this.current) return;
    const { e, summary } = this.current;
    const head = document.createElement("div");
    head.className = "popout-head";
    const title = document.createElement("h2");
    title.textContent = "Alert Detail";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "popout-x";
    x.setAttribute("aria-label", "Close");
    x.textContent = "\u00d7";
    x.addEventListener("click", () => this.collapse());
    const pos = this.nav?.position() ?? null;
    if (pos) {
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "popout-step";
      prev.textContent = "\u2039";
      prev.title = "Previous event in the log (\u2190)";
      prev.setAttribute("aria-label", "Previous event");
      prev.addEventListener("click", () => this.nav?.step(-1));
      const next = document.createElement("button");
      next.type = "button";
      next.className = "popout-step";
      next.textContent = "\u203a";
      next.title = "Next event in the log (\u2192)";
      next.setAttribute("aria-label", "Next event");
      next.addEventListener("click", () => this.nav?.step(1));
      const where = document.createElement("span");
      where.className = "popout-pos";
      where.textContent = `${pos.index} of ${pos.total}`;
      head.append(title, prev, where, next, x);
    } else head.append(title, x);
    const body = document.createElement("div");
    body.className = "popout-body";
    const scroll = dialog.querySelector<HTMLElement>(".popout-body")?.scrollTop ?? 0;
    this.render(body, e, summary, true, this.current.key);
    dialog.replaceChildren(head, body);
    body.scrollTop = scroll;
    if (document.activeElement === document.body || !dialog.contains(document.activeElement)) {
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true }); // a redraw (stepping) must not drop keyboard focus onto the page behind
    }
  }

  /** Hides the panel. `notify` is false when the caller (FocusController)
   *  is itself the one clearing selection, so onClose doesn't call back
   *  into it. The x button and Esc use the default and DO notify, which
   *  is how closing the panel also unpins the event on the map. */
  hide(notify = true): void {
    const wasOpen = !this.section.hidden;
    this.section.hidden = true;
    this.current = null;
    this.collapse();
    if (notify && wasOpen) this.onClose?.();
  }

  /** A value that filters the screen to itself when clicked. */
  private pivotEl(tag: "span" | "div", text: string, field: PivotField, value: string, cls = ""): HTMLElement {
    const b: HTMLElement = document.createElement(tag);
    b.className = `pivot ${cls}`.trim();
    b.textContent = text;
    if (!this.onPivot) return b;
    b.tabIndex = 0;
    b.setAttribute("role", "button");
    b.title = `Show only ${field.replace("_", " ")} ${value}  (Shift-click: add to the current search)`;
    const go = (and: boolean): void => { if (this.overlay) this.collapse(); this.onPivot?.(field, value, and); };
    b.addEventListener("click", (ev) => { ev.stopPropagation(); go(ev.shiftKey); });
    b.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); go(ev.shiftKey); }
    });
    return b;
  }

  private noteBlock(e: TrafficEvent): HTMLElement | null {
    const n = this.notes?.find(e.signature, e.signature_id);
    if (!n) return null;
    const box = document.createElement("div");
    box.className = "detail-signote";
    const head = document.createElement("div");
    head.className = "sn-head";
    head.textContent = "What this alert means";
    const what = document.createElement("div");
    what.textContent = n.what;
    box.append(head, what);
    if (n.action) {
      const h2 = document.createElement("div");
      h2.className = "sn-head";
      h2.textContent = "What to do";
      const act = document.createElement("div");
      act.textContent = n.action;
      box.append(h2, act);
    }
    if (n.link && /^https?:\/\//i.test(n.link)) {
      const a = document.createElement("a");
      a.href = n.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Runbook \u2197";
      box.append(a);
    }
    return box;
  }

  private historyBlock(e: TrafficEvent): HTMLElement | null {
    if (!this.history || !e.src_ip) return null;
    const st = this.history.get(e.src_ip);
    const box = document.createElement("div");
    box.className = "detail-history";
    const head = document.createElement("div");
    head.className = "dh-head";
    head.textContent = "Seen from this source before";
    box.append(head);
    const line = (t: string): void => { const d = document.createElement("div"); d.className = "dh-line"; d.textContent = t; box.append(d); };
    if (st.state === "loading") line("Checking\u2026");
    else if (st.state === "error") line("Couldn\u2019t reach the server for the history.");
    else if (st.state === "none") line("Nothing recorded for this address yet.");
    else {
      const h: SourceHistory = st.history;
      const when = (iso: string): string => new Date(iso).toLocaleString();
      line(`${h.events.toLocaleString()} event${h.events === 1 ? "" : "s"} \u00b7 first ${when(h.first_seen)} \u00b7 last ${when(h.last_seen)}`);
      line(`${h.distinct_targets.toLocaleString()} different target${h.distinct_targets === 1 ? "" : "s"} \u00b7 ${h.distinct_signatures.toLocaleString()} different alert type${h.distinct_signatures === 1 ? "" : "s"}${st.feed === "simulated" ? " (demo data)" : ""}`);
      const tops = (label: string, items: { name: string; n: number }[], field?: PivotField): void => {
        if (items.length === 0) return;
        const row = document.createElement("div");
        row.className = "dh-line";
        row.append(`${label}: `);
        items.slice(0, 3).forEach((it, i) => {
          if (i > 0) row.append(", ");
          row.append(field ? this.pivotEl("span", it.name, field, it.name) : it.name, ` (${it.n.toLocaleString()})`);
        });
        box.append(row);
      };
      tops("Top alerts", h.top_signatures, "signature");
      tops("Top targets", h.top_targets);
      tops("Top ports", h.top_ports, "dst_port");
    }
    return box;
  }

  private anomalyBlock(a: NonNullable<TrafficEvent["anomaly"]>): HTMLElement {
    const box = document.createElement("div");
    box.className = `detail-anomaly an-${a.level}${a.learning ? " an-learning" : ""}`;
    const head = document.createElement("div");
    head.className = "an-head";
    const label = { usual: "Usual", uncommon: "Uncommon", unusual: "Unusual" }[a.level];
    head.textContent = `Unusualness ${a.score}/100 \u00b7 ${label}${a.learning ? " (provisional, still learning this network)" : ""}`;
    const list = document.createElement("ul");
    for (const r of a.reasons) {
      const li = document.createElement("li");
      li.textContent = r;
      list.append(li);
    }
    box.append(head, list);
    return box;
  }

  private reviewBlock(key: string, large: boolean): HTMLElement {
    const store = this.store!;
    const box = document.createElement("div");
    box.className = "detail-review";
    const row = document.createElement("label");
    row.className = "dr-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = store.isReviewed(key);
    cb.addEventListener("change", () => store.set(key, { reviewed: cb.checked }));
    const lbl = document.createElement("span");
    lbl.textContent = "Reviewed";
    row.append(cb, lbl);
    const note = document.createElement("textarea");
    note.className = "dr-note";
    note.rows = large ? 3 : 2;
    note.maxLength = 500;
    note.placeholder = "Note (kept in this browser only)";
    note.value = store.get(key)?.note ?? "";
    let timer = 0;
    const save = (): void => {
      window.clearTimeout(timer);
      if (note.value !== (store.get(key)?.note ?? "")) store.set(key, { note: note.value });
    };
    note.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(save, 500); });
    note.addEventListener("blur", save);
    box.append(row, note);
    if (large && this.nav) {
      const next = document.createElement("button");
      next.type = "button";
      next.className = "btn dr-next";
      next.textContent = "Mark reviewed & next \u203a";
      next.addEventListener("click", () => { save(); store.set(key, { reviewed: true }); this.nav?.nextUnreviewed(); });
      box.append(next);
    }
    return box;
  }

  /** `summary` is present when the event stands for a group of repeats
   *  (see aggregator.ts); it adds the count, first/last seen and the
   *  distinct destination ports hit. */
  show(e: TrafficEvent, summary?: GroupSummary, key?: string): void {
    const wasHidden = this.section.hidden;
    this.current = { e, summary, key };
    this.section.hidden = false;
    if (wasHidden) this.section.scrollIntoView({ block: "nearest" }); // the column may be scrolled; an opened detail must be seen
    this.redraw();
  }

  /** True while a note is being typed in `root`: redrawing then would wipe the text and the cursor. */
  private typingIn(root: HTMLElement | null): boolean {
    const a = document.activeElement;
    return !!root && a instanceof HTMLTextAreaElement && root.contains(a);
  }

  /** Redraw because something the details show (history, notes) arrived. */
  refresh(): void { this.redraw(); }

  private redraw(): void {
    if (!this.current) return;
    const { e, summary, key } = this.current;
    const same = this.drawnKey === key;
    if (!(same && this.typingIn(this.body))) this.render(this.body, e, summary, false, key);
    if (this.overlay && !(same && this.typingIn(this.overlay))) this.renderPopout();
    this.drawnKey = key;
  }
  private drawnKey: string | undefined;

  /** Draws one event into `target`. `large` adds the full source record for the pop-out window. */
  private render(target: HTMLElement, e: TrafficEvent, summary: GroupSummary | undefined, large: boolean, key?: string): void {
    target.replaceChildren();
    const body = target;
    target.classList.toggle("detail-large", large);

    const sig = e.signature ? this.pivotEl("div", e.signature, "signature", e.signature, "detail-sig") : document.createElement("div");
    if (!e.signature) { sig.className = "detail-sig"; sig.textContent = "(no signature)"; }
    const badge = this.pivotEl("span", severityLabel(e.severity), "severity", e.severity, "detail-badge");
    badge.style.background = severityColor(e.severity);
    body.append(badge, sig);
    const sigNote = this.noteBlock(e);
    if (sigNote) body.append(sigNote);
    if (e.anomaly) body.append(this.anomalyBlock(e.anomaly));
    const hist = this.historyBlock(e);
    if (hist) body.append(hist);
    if (key && this.store) body.append(this.reviewBlock(key, large));

    const grouped = summary !== undefined && summary.count > 1;
    const rows: [string, string | null, PivotField?, string?][] = [
      ["Flow", `${endpoint(e.src_ip, e.src_port)} \u2192 ${endpoint(e.dst_ip, e.dst_port)}`],
      ["Source system", assetText(e.src_asset), "src_asset", e.src_asset?.name],
      ["Target system", assetText(e.dst_asset), "dst_asset", e.dst_asset?.name],
      ["Direction", e.direction ? DIRECTION_TEXT[e.direction] : null, "direction", e.direction ?? undefined],
      ["Count", grouped ? `${summary!.count.toLocaleString()} events` : null],
      ["Dest ports", grouped && summary!.dstPorts.length > 1 ? formatPorts(summary!.dstPorts) : null],
      ["Protocol", e.protocol ? e.protocol.toUpperCase() : null, "protocol", e.protocol ?? undefined],
      ["Action", e.action, "action", e.action ?? undefined],
      ["Category", e.category, "category", e.category ?? undefined],
      ["Rule ID", e.signature_id, "signature_id", e.signature_id ?? undefined],
      ["Time", grouped ? null : new Date(e.alert_time ?? e.timestamp).toLocaleString()],
      ["First seen", grouped ? new Date(summary!.firstSeen).toLocaleString() : null],
      ["Last seen", grouped ? new Date(summary!.lastSeen).toLocaleString() : null],
      ["Source geo", `${e.src_lat.toFixed(2)}, ${e.src_lon.toFixed(2)}`],
      ["Dest geo", `${e.dst_lat.toFixed(2)}, ${e.dst_lon.toFixed(2)}`],
      ["Location note", e.geo_note],
      ["Feed", e.source === "elastic" ? "Live (Elastic)" : "Simulated (uploaded data)"],
    ];
    const dl = document.createElement("dl");
    dl.className = "detail-grid";
    for (const [k, v, pf, pv] of rows) {
      if (v === null || v === "") continue;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd");
      if (k === "Flow") {
        // Each address is its own pivot; the ports are plain text.
        const part = (ip: string | null, port: number | null, f: PivotField): void => {
          if (ip) dd.append(this.pivotEl("span", ip, f, ip), port !== null ? `:${port}` : "");
          else dd.append("?");
        };
        part(e.src_ip, e.src_port, "src_ip");
        dd.append(" \u2192 ");
        part(e.dst_ip, e.dst_port, "dst_ip");
      } else if (pf && pv) dd.append(this.pivotEl("span", v, pf, pv));
      else dd.textContent = v;
      dl.append(dt, dd);
    }
    body.append(dl);

    // Anything in the source data that didn't map to a field above (collapsed by default).
    const extraKeys = Object.keys(e.extra ?? {});
    if (extraKeys.length > 0) {
      const details = document.createElement("details");
      details.className = "detail-extra";
      details.open = large;
      const summaryEl = document.createElement("summary");
      summaryEl.textContent = `Other fields in the data (${extraKeys.length})`;
      const extraGrid = document.createElement("dl");
      extraGrid.className = "detail-grid";
      for (const k of extraKeys) {
        const dt = document.createElement("dt"); dt.textContent = k; dt.title = k;
        const dd = document.createElement("dd"); dd.textContent = e.extra[k];
        extraGrid.append(dt, dd);
      }
      details.append(summaryEl, extraGrid);
      body.append(details);
    }

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const link = (label: string, href: string) => {
      const a = document.createElement("a");
      a.className = "btn";
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      actions.append(a);
    };
    if (e.kibana_url) link("Open in Kibana ↗", e.kibana_url);
    for (const l of linksFor(this.links, e)) link(`${l.label} \u2197`, l.href);
    // The built-in lookups are the default; an admin who configures links: gets exactly their own list.
    if (this.links.length === 0 && e.src_ip && !isPrivateIp(e.src_ip)) {
      link("VirusTotal (source IP) ↗", `https://www.virustotal.com/gui/ip-address/${encodeURIComponent(e.src_ip)}`);
      link("AbuseIPDB (source IP) ↗", `https://www.abuseipdb.com/check/${encodeURIComponent(e.src_ip)}`);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn";
    copy.textContent = "Copy flow";
    copy.addEventListener("click", async () => {
      const text = `${e.signature ?? "alert"} | ${endpoint(e.src_ip, e.src_port)} -> ${endpoint(e.dst_ip, e.dst_port)} | ${severityLabel(e.severity)} | ${e.alert_time ?? e.timestamp}${grouped ? ` | x${summary!.count}` : ""}`;
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy flow"; }, 1200);
    });
    actions.append(copy);

    // A ready-to-paste line for backend/known_good.yaml, for sources that turn out to be harmless.
    if (e.src_ip) {
      const kg = document.createElement("button");
      kg.type = "button";
      kg.className = "btn";
      kg.textContent = "Copy as known-good entry";
      kg.title = "Copies a line to paste under sources: in backend/known_good.yaml";
      kg.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(knownGoodEntry(e.src_ip!, e.src_asset?.name ?? null)); kg.textContent = "Copied"; }
        catch { kg.textContent = "Copy failed"; }
        setTimeout(() => { kg.textContent = "Copy as known-good entry"; }, 1400);
      });
      actions.append(kg);

      const list = this.knownGood;
      if (list?.editable) {
        const mute = document.createElement("button");
        mute.type = "button";
        mute.className = "btn";
        const already = list.find(e.src_ip);
        mute.textContent = already ? "Source is muted \u2713" : "Mute this source\u2026";
        mute.disabled = !!already;
        mute.title = already ? `Already on the known-good list (${already.cidr ?? already.signature})` : "Hide this source's traffic from every screen (asks first)";
        mute.addEventListener("click", () => {
          const warnings: string[] = [];
          if (e.severity === severityLevels()[0]?.id) warnings.push(`This event is ${severityLabel(e.severity)}. Muting hides everything from this source, including future events like it.`);
          if (isKeyAsset(e.dst_asset)) warnings.push(`It is aimed at a key system (${e.dst_asset!.name}).`);
          if (e.anomaly && e.anomaly.level === "unusual" && !e.anomaly.learning) warnings.push("It is flagged as unusual for this network.");
          openMuteConfirm({
            ip: e.src_ip!,
            defaultNote: e.src_asset?.name ?? "",
            warnings,
            submit: async (note) => {
              const err = await list.add(e.src_ip!, note);
              if (err === null) this.redraw(); // the button now says "muted"
              return err;
            },
          });
        });
        actions.append(mute);
      }
    }
    // Muting by signature is a separate, stricter switch: it hides a rule's alerts for everyone, from any source.
    const sigList = this.knownGood;
    if (e.signature && sigList?.editable && sigList.signatureMute) {
      const m = document.createElement("button");
      m.type = "button";
      m.className = "btn";
      const already = sigList.findSignature(e.signature);
      m.textContent = already ? "Signature is muted \u2713" : "Mute this signature\u2026";
      m.disabled = !!already;
      m.title = already ? "Already muted" : "Hide every alert with this signature, from any source, on every screen (asks first)";
      m.addEventListener("click", () => {
        const warnings = ["This hides the signature everywhere, so it would also hide a real attack that triggers it."];
        if (e.severity === severityLevels()[0]?.id) warnings.push(`This event is ${severityLabel(e.severity)}.`);
        if (isKeyAsset(e.dst_asset)) warnings.push(`It is aimed at a key system (${e.dst_asset!.name}).`);
        openMuteConfirm({
          ip: e.signature!, kind: "signature", defaultNote: "", warnings,
          submit: async (note) => {
            const err = await sigList.addSignature(e.signature!, note);
            if (err === null) this.redraw();
            return err;
          },
        });
      });
      actions.append(m);
    }
    body.append(actions);

    if (large) {
      const raw = document.createElement("details");
      raw.className = "detail-extra detail-raw";
      raw.open = true;
      const rs = document.createElement("summary");
      rs.textContent = "Raw event (JSON)";
      const pre = document.createElement("pre");
      const json = JSON.stringify(e, null, 2);
      pre.textContent = json;
      const rc = document.createElement("button");
      rc.type = "button";
      rc.className = "btn";
      rc.textContent = "Copy JSON";
      rc.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(json); rc.textContent = "Copied"; }
        catch { rc.textContent = "Copy failed"; }
        setTimeout(() => { rc.textContent = "Copy JSON"; }, 1200);
      });
      raw.append(rs, pre, rc);
      body.append(raw);
    }
  }
}
