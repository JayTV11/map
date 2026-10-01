import { SEVERITY_COLOR, TrafficEvent } from "./types";

const MAX_ENTRIES = 60;

function span(className: string, text?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  // textContent, never innerHTML: IPs and signatures are untrusted data.
  if (text !== undefined) el.textContent = text;
  return el;
}

/** `onSelect` fires on click (or Enter/Space) -- the row itself doesn't
 *  know what "selected" means, that's FocusController's job (see
 *  focus.ts). We just report the interaction and hand back the element so
 *  the caller can toggle a `.selected` class on it. */
export function appendLogEntry(list: HTMLElement, event: TrafficEvent, onSelect: (el: HTMLElement) => void): void {
  const el = document.createElement("div");
  el.className = "log-entry";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  const hint = "Click to pin this event on the map";
  el.title = event.signature ? `${event.signature}\n${hint}` : hint;

  const dot = span("log-sev");
  dot.style.background = SEVERITY_COLOR[event.severity];

  const ips = span("log-ips");
  ips.append(event.src_ip ?? "?", span("arrow", "\u2192"), event.dst_ip ?? "?");

  el.append(dot, ips, span("log-sevlabel", event.severity));

  el.addEventListener("click", () => onSelect(el));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(el);
    }
  });
  list.appendChild(el);
  while (list.children.length > MAX_ENTRIES) list.removeChild(list.firstChild!);
  list.scrollTop = list.scrollHeight;
}
