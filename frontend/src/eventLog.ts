import { SEVERITY_COLOR, TrafficEvent } from "./types";

const MAX_ENTRIES = 60;

export function appendLogEntry(list: HTMLElement, event: TrafficEvent): void {
  const el = document.createElement("div");
  el.className = "log-entry";
  el.innerHTML = `<span class="log-sev" style="background:${SEVERITY_COLOR[event.severity]}"></span>
    <span class="log-ips">${event.src_ip ?? "?"}<span class="arrow">→</span>${event.dst_ip ?? "?"}</span>
    <span class="log-sevlabel">${event.severity}</span>`;
  list.appendChild(el);
  while (list.children.length > MAX_ENTRIES) list.removeChild(list.firstChild!);
  list.scrollTop = list.scrollHeight;
}
