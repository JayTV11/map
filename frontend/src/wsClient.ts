import { TrafficEvent } from "./types";

/** `onState` reports whether the socket is currently up, so the UI can say
 *  so out loud: a dead connection must never look like a quiet network. */
export function connectTrafficSocket(
  onEvent: (e: TrafficEvent) => void,
  onState?: (connected: boolean) => void,
): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => onState?.(true);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as TrafficEvent);
    } catch (err) {
      console.error("bad event payload", err);
    }
  };
  ws.onclose = () => {
    onState?.(false);
    setTimeout(() => connectTrafficSocket(onEvent, onState), 1500); // fine for a local single-user tool
  };
  return ws;
}
