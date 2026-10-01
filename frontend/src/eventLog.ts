import { EventGroup } from "./aggregator";
import { AssetRef, isKeyAsset, SEVERITY_COLOR } from "./types";

const MAX_ENTRIES = 60;

function span(className: string, text?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  // textContent, never innerHTML: IPs, names and signatures are untrusted data.
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A known system shows by name (coloured if it's a key asset); anything else shows its IP. */
function endpointLabel(ip: string | null, asset: AssetRef | null | undefined): Node {
  if (!asset) return document.createTextNode(ip ?? "?");
  const cls = isKeyAsset(asset) ? `asset-name key-${asset.criticality}` : "asset-name";
  return span(cls, asset.name);
}

const DIRECTION_TAG = { outbound: "OUT", internal: "INT" } as const;

export interface LogRow {
  el: HTMLElement;
  /** Refresh the row after its group received more events. */
  update(group: EventGroup): void;
}

/** One row per GROUP (see aggregator.ts), not per event: repeats update
 *  the existing row's count instead of adding new rows.
 *
 *  `onSelect` fires on click (or Enter/Space) -- the row itself doesn't
 *  know what "selected" means, that's FocusController's job (see
 *  focus.ts). We just report the interaction and hand back the element so
 *  the caller can toggle a `.selected` class on it. */
export function appendLogEntry(list: HTMLElement, group: EventGroup, onSelect: (el: HTMLElement) => void): LogRow {
  const el = document.createElement("div");
  el.className = "log-entry";
  el.tabIndex = 0;
  el.setAttribute("role", "button");

  const e = group.event;
  const dot = span("log-sev");
  const ips = span("log-ips");
  ips.append(endpointLabel(e.src_ip, e.src_asset), span("arrow", "\u2192"), endpointLabel(e.dst_ip, e.dst_asset));
  const tagText = e.direction && e.direction !== "inbound" ? DIRECTION_TAG[e.direction] : null;
  const dirTag = tagText ? span(`log-dir dir-${e.direction}`, tagText) : null;
  const badge = span("log-count");
  const sevLabel = span("log-sevlabel");
  el.append(dot, ips);
  if (dirTag) el.append(dirTag);
  el.append(badge, sevLabel);

  const update = (g: EventGroup): void => {
    dot.style.background = SEVERITY_COLOR[g.severity];
    sevLabel.textContent = g.severity;
    badge.hidden = g.count <= 1;
    badge.textContent = `\u00d7${g.count.toLocaleString()}`;
    const hint = "Click to pin this event on the map";
    const head = g.event.signature ? `${g.event.signature}\n` : "";
    const addrs = g.event.src_asset || g.event.dst_asset ? `${g.event.src_ip ?? "?"} \u2192 ${g.event.dst_ip ?? "?"}\n` : "";
    const times = g.count > 1 ? `${g.count} events, last ${new Date(g.lastSeen).toLocaleTimeString()}\n` : "";
    el.title = `${head}${addrs}${times}${hint}`;
  };
  update(group);

  el.addEventListener("click", () => onSelect(el));
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onSelect(el);
    }
  });
  list.appendChild(el);
  while (list.children.length > MAX_ENTRIES) list.removeChild(list.firstChild!);
  list.scrollTop = list.scrollHeight;

  return { el, update };
}
