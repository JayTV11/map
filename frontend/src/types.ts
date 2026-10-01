export type Severity = "critical" | "major" | "high" | "unknown";

export type Criticality = "low" | "normal" | "high" | "critical";
export type Direction = "inbound" | "outbound" | "internal";

/** A named business system an IP belongs to (backend/assets.yaml). */
export interface AssetRef {
  name: string;
  criticality: Criticality;
}

/** The systems whose compromise matters most: flagged in the log and counted in the wall headline. */
export function isKeyAsset(a: AssetRef | null | undefined): boolean {
  return a?.criticality === "high" || a?.criticality === "critical";
}

export interface TrafficEvent {
  id: string;
  timestamp: string; // ISO 8601, assigned by the backend at emission time
  src_lat: number;
  src_lon: number;
  dst_lat: number;
  dst_lon: number;
  severity: Severity;
  count: number;
  src_ip: string | null;
  dst_ip: string | null;
  signature: string | null;
  signature_id: string | null;
  category: string | null;
  protocol: string | null;
  src_port: number | null;
  dst_port: number | null;
  action: string | null;
  alert_time: string | null;
  kibana_url: string | null;
  src_asset: AssetRef | null;
  dst_asset: AssetRef | null;
  direction: Direction | null;
  source: "csv" | "elastic";
  is_replay: boolean;
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#ff3868",
  major: "#ff9f2e",
  high: "#ffe066",
  unknown: "#6b7f93",
};