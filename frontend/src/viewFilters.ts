import { ChipBar, combineQueries } from "./filterChips";
import { EventGate } from "./gate";
import { BUILT_IN_FIELDS, tryCompile } from "./kql";
import { KnownGoodList } from "./knownGood";

const EXAMPLES: { q: string; what: string }[] = [
  { q: "severity:(critical or major)", what: "only the worst levels" },
  { q: "src_ip:203.0.113.0/24", what: "one source range" },
  { q: "source.ip:10.0.0.0/8 and not dst_port:443", what: "internal sources, not HTTPS" },
  { q: "signature:*scan*", what: "any signature containing \"scan\"" },
  { q: 'dst_asset:"Payment API"', what: "traffic aimed at one system" },
  { q: "dst_port >= 1024 and protocol:tcp", what: "numeric comparison" },
  { q: "10.50.0.0/16", what: "a bare address or range matches either side" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: queries, notes and names are untrusted
  return e;
}

/** The two on-screen controls over EventGate:
 *   - the KQL search bar over the map (also reads/writes ?q= in the URL)
 *   - the "Known-good sources" mute switch in the sidebar
 *  plus a badge at the bottom of the map that always says what is being
 *  hidden -- including in wall mode, where the controls themselves are
 *  hidden. A wall must never silently show a filtered or muted view. */
export class ViewFilters {
  private input = el("input", "fb-input");
  private clearBtn = el("button", "fb-clear", "×");
  private msg = el("div", "fb-msg");
  private help = el("div", "fb-help");
  private box = el("div", "fb-box");
  private muteBox = document.createElement("input");
  private muteInfo = el("div", "mute-info");
  private badge = el("div", "gate-badge");
  // The badge's chips are built once and updated in place: replacing them every second would drop the hover tooltip.
  private muteChip = el("span", "gate-chip mute");
  private filterChip = el("span", "gate-chip filter");
  private filterQuery = el("span", "gate-query");
  private filterCount = el("span", "gate-count");
  private muteInfoLine = el("div", "mute-line");
  private muteWarn1 = el("div", "mute-line warn");
  private muteWarn2 = el("div", "mute-line warn");
  private debounce = 0;
  private lastGoodText = "";
  private chips = new ChipBar();

  /** `hasExtraField` says whether an unmapped column of that name has been seen in live data (to flag typos). */
  constructor(
    private gate: EventGate,
    private knownGood: KnownGoodList,
    mapWrap: HTMLElement,
    private hasExtraField: (name: string) => boolean,
    sidebarAnchor: HTMLElement | null,
  ) {
    this.buildSearchBar(mapWrap);
    this.buildMutePanel(sidebarAnchor);
    this.badge.id = "gate-badge";
    this.filterChip.append(el("span", "gate-label", "FILTER"), this.filterQuery, this.filterCount);
    this.badge.append(this.muteChip, this.filterChip);
    mapWrap.append(this.badge);

    const params = new URLSearchParams(location.search);
    if (params.get("mute") === "0") this.setMute(false);
    const q = params.get("q");
    const chipIds = (params.get("chips") ?? "").split(",").filter(Boolean);
    if (chipIds.length > 0) this.chips.setActive(chipIds);
    if (q) this.input.value = q;
    if (q || chipIds.length > 0) this.apply();

    this.render();
    window.setInterval(() => this.render(), 1000);
  }

  /** Called whenever the gate's state or the list changed. */
  refresh(): void { this.render(); }

  // ---- search bar -----------------------------------------------------------------
  private buildSearchBar(mapWrap: HTMLElement): void {
    const bar = el("div");
    bar.id = "filter-bar";

    const icon = el("span", "fb-icon", "⌕");
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.placeholder = "Filter events…  e.g. src_ip:10.0.0.0/8 and severity:critical      ( / to search )";
    this.input.setAttribute("aria-label", "Filter events (KQL)");
    this.clearBtn.type = "button";
    this.clearBtn.title = "Clear filter (Esc)";
    this.clearBtn.setAttribute("aria-label", "Clear filter");
    this.clearBtn.hidden = true;
    const helpBtn = el("button", "fb-helpbtn", "?");
    helpBtn.type = "button";
    helpBtn.title = "Search help";
    helpBtn.setAttribute("aria-label", "Search help");
    this.box.append(icon, this.input, this.clearBtn, helpBtn);

    this.msg.hidden = true;
    this.msg.setAttribute("role", "status");
    this.buildHelp();
    this.help.hidden = true;
    this.chips.getSavable = () => {
      const t = this.input.value.trim();
      return t !== "" && tryCompile(t).ok ? t : "";
    };
    this.chips.onChange = () => this.apply();
    bar.append(this.box, this.chips.el, this.msg, this.help);
    mapWrap.append(bar);

    this.input.addEventListener("input", () => {
      this.clearBtn.hidden = this.input.value === "";
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => this.apply(), 150);
    });
    this.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        window.clearTimeout(this.debounce);
        this.apply();
        this.input.blur();
      } else if (ev.key === "Escape") {
        if (this.input.value !== "") this.setText("");
        this.input.blur();
        ev.stopPropagation();
      }
    });
    this.clearBtn.addEventListener("click", () => { this.setText(""); this.input.focus(); });
    helpBtn.addEventListener("click", () => { this.help.hidden = !this.help.hidden; });

    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target as HTMLElement | null;
      const typing = t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" ||
        (t.tagName === "INPUT" && !["range", "checkbox", "file"].includes((t as HTMLInputElement).type)));
      if (typing || document.body.classList.contains("kiosk")) return;
      ev.preventDefault();
      this.input.focus();
      this.input.select();
    });
  }

  private buildHelp(): void {
    this.help.append(
      el("div", "fb-help-title", "Filter the live events"),
      el("div", "fb-help-note",
        "Searches the events this screen has received (not Elastic's history). and / or / not, ( ), * wildcards, field:value."),
    );
    for (const ex of EXAMPLES) {
      const row = el("button", "fb-example");
      row.type = "button";
      row.append(el("code", undefined, ex.q), el("span", undefined, ex.what));
      row.addEventListener("click", () => { this.setText(ex.q); this.input.focus(); });
      this.help.append(row);
    }
    this.help.append(
      el("div", "fb-help-note", "Fields: " + BUILT_IN_FIELDS.join(", ") +
        ". Elastic-style names work too (source.ip, destination.port, rule.name…), and so does any unmapped column."),
    );
  }

  private setText(text: string): void {
    this.input.value = text;
    this.clearBtn.hidden = text === "";
    window.clearTimeout(this.debounce);
    this.apply();
  }

  private apply(): void {
    const text = this.input.value;
    const result = tryCompile(text);
    this.box.classList.remove("bad");
    this.chips.updateSave();

    if (!result.ok) {
      // Keep showing the last good filter while the text is mid-edit.
      this.box.classList.add("bad");
      const still = this.gate.hasQuery ? " \u2014 still showing the last valid search" : "";
      this.showMsg(result.error.message + still, "bad");
      return;
    }

    const unseen = result.query.unknownFields.filter((f) => !this.hasExtraField(f));
    if (unseen.length > 0) {
      this.showMsg(`No field named "${unseen[0]}" in the data so far \u2014 check the spelling (? lists the fields).`, "warn");
    } else {
      this.showMsg("", "warn");
    }

    // What is typed, ANDed with any chips that are switched on.
    const active = this.chips.activeChips();
    const combined = tryCompile(combineQueries(text, active));
    if (!combined.ok) { // shouldn't happen (each part compiled on its own); never blank the map over it
      this.showMsg(combined.error.message, "bad");
      return;
    }
    this.lastGoodText = text.trim();
    const shown = [...active.map((c) => c.label), text.trim()].filter(Boolean).join(" + ");
    this.gate.setQuery(combined.query, shown);
    this.writeUrl();
  }

  private showMsg(text: string, kind: "bad" | "warn"): void {
    this.msg.hidden = text === "";
    this.msg.textContent = text;
    this.msg.className = `fb-msg ${kind}`;
  }

  private writeUrl(): void {
    try {
      const url = new URL(location.href);
      if (this.lastGoodText) url.searchParams.set("q", this.lastGoodText);
      else url.searchParams.delete("q");
      const ids = this.chips.activeIds;
      if (ids.length > 0) url.searchParams.set("chips", ids.join(","));
      else url.searchParams.delete("chips");
      history.replaceState(null, "", url);
    } catch { /* a read-only location (some previews): the filter still works, it just isn't bookmarkable */ }
  }

  // ---- mute switch ------------------------------------------------------------------
  private buildMutePanel(anchor: HTMLElement | null): void {
    const section = el("div", "panel-section");
    section.id = "mute-section";
    section.append(el("h2", undefined, "Known-Good Sources"));

    const row = el("div", "row");
    const label = el("label", undefined, "Mute known-good sources");
    label.htmlFor = "mute-toggle";
    const sw = el("label", "switch");
    this.muteBox.type = "checkbox";
    this.muteBox.id = "mute-toggle";
    this.muteBox.checked = this.gate.muteEnabled;
    sw.append(this.muteBox, el("span", "slider-toggle"));
    row.append(label, sw);
    this.muteBox.addEventListener("change", () => this.setMute(this.muteBox.checked));

    this.muteInfo.append(this.muteInfoLine, this.muteWarn1, this.muteWarn2);
    section.append(row, this.muteInfo);
    if (anchor) anchor.before(section);
    else document.body.append(section);
  }

  private setMute(on: boolean): void {
    this.muteBox.checked = on;
    this.gate.setMute(on);
  }

  // ---- rendering ----------------------------------------------------------------------
  private render(): void {
    this.renderMuteInfo();
    this.renderBadge();
  }

  private renderMuteInfo(): void {
    const n = this.knownGood.size;
    if (n === 0) {
      this.muteInfoLine.textContent = "No sources listed. Add them in backend/known_good.yaml.";
    } else {
      const m = this.gate.mutedCount;
      const state = this.gate.muteEnabled
        ? `${m.toLocaleString()} event${m === 1 ? "" : "s"} muted this session`
        : "Muting is off \u2014 their traffic is shown";
      this.muteInfoLine.textContent = `${n} source${n === 1 ? "" : "s"} listed \u00b7 ${state}`;
    }
    const err = this.knownGood.serverError;
    this.muteWarn1.textContent = err ? `known_good.yaml: ${err}` : "";
    this.muteWarn1.hidden = !err;
    this.muteWarn2.textContent = "Couldn't reach the server for the list; using the last one.";
    this.muteWarn2.hidden = !this.knownGood.loadFailed;
  }

  private renderBadge(): void {
    const showMute = this.gate.muteEnabled && this.knownGood.size > 0;
    this.muteChip.hidden = !showMute;
    if (showMute) {
      this.muteChip.textContent = `\u{1F507} ${this.gate.mutedCount.toLocaleString()} muted`;
      const n = this.knownGood.size;
      const notes = this.knownGood.entries.filter((e) => e.note).slice(0, 8).map((e) => `${e.cidr} \u2014 ${e.note}`);
      this.muteChip.title = `Hiding traffic from ${n} known-good source${n === 1 ? "" : "s"}.` +
        (notes.length ? `\n${notes.join("\n")}` : "");
    }

    const showFilter = this.gate.hasQuery;
    this.filterChip.hidden = !showFilter;
    if (showFilter) {
      this.filterQuery.textContent = this.gate.activeQuery;
      this.filterCount.textContent = `\u00b7 ${this.gate.filteredCount.toLocaleString()} hidden`;
      this.filterChip.title = `Showing only events matching: ${this.gate.activeQuery}`;
    }

    this.badge.hidden = !showMute && !showFilter;
  }
}
