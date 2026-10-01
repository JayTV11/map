import { SEVERITY_COLOR, TrafficEvent } from "./types";

const MAX_ENTRIES = 60;

/** `onSelect` fires on click (or Enter/Space) -- the row itself doesn't
 *  know what "selected" means, that's FocusController's job (see
 *  focus.ts). We just report the interaction and hand back the element so
 *  the caller can toggle a `.selected` class on it. */
export function appendLogEntry(list: HTMLElement, event: TrafficEvent, onSelect: (el: HTMLElement) => void): void {
  const el = document.createElement("div");
  el.className = "log-entry";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.title = "Click to pin this event on the map";
  el.innerHTML = `<span class="log-sev" style="background:${SEVERITY_COLOR[event.severity]}"></span>
    <span class="log-ips">${event.src_ip ?? "?"}<span class="arrow">→</span>${event.dst_ip ?? "?"}</span>
    <span class="log-sevlabel">${event.severity}</span>`;
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
