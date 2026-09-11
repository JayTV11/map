import { TrafficEvent } from "./types";

export function connectTrafficSocket(onEvent: (e: TrafficEvent) => void): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as TrafficEvent);
    } catch (err) {
      console.error("bad event payload", err);
    }
  };
  ws.onclose = () => {
    setTimeout(() => connectTrafficSocket(onEvent), 1500); // fine for a local single-user tool
  };
  return ws;
}
