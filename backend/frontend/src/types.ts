/** A level id from the configured scale (backend/config.yaml `severity.levels`), or "unknown". */
export type Severity = string;

export interface SeverityLevel {
  id: string;
  label: string;
  color: string;
}

const UNKNOWN_LEVEL: SeverityLevel = { id: "unknown", label: "Unknown", color: "#4f8cff" };
const DEFAULT_LEVELS: SeverityLevel[] = [
  { id: "critical", label: "Critical", color: "#ff3868" },
  { id: "major", label: "Major", color: "#ff9f2e" },
  { id: "high", label: "High", color: "#ffe066" },
];

// The scale comes from the backend at startup (config.ts calls setSeverityLevels);
// until then, and if the backend is an older one without /api/config, this default applies.
let levels: SeverityLevel[] = DEFAULT_LEVELS;

export function setSeverityLevels(next: SeverityLevel[]): void {
  if (next.length > 0) levels = next;
}
/** The scale's levels, most severe first (never includes "unknown"). */
export function severityLevels(): SeverityLevel[] {
  return levels;
}
export function severityInfo(id: string): SeverityLevel {
  return levels.find((l) => l.id === id) ?? UNKNOWN_LEVEL;
}
export function severityColor(id: string): string {
  return severityInfo(id).color;
}
export function severityLabel(id: string): string {
  return severityInfo(id).label;
}
/** Higher = more severe; 0 = unknown. */
export function severityRank(id: string): number {
  const i = levels.findIndex((l) => l.id === id);
  return i < 0 ? 0 : levels.length - i;
}

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

/** How unusual an event is compared with what this network has seen before (backend/app/anomaly.py). */
export interface Anomaly {
  score: number; // 0-100, higher = rarer
  level: "usual" | "uncommon" | "unusual";
  reasons: string[];
  /** Not enough history yet to trust the score. */
  learning: boolean;
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
  /** Fields in the source data that weren't mapped to anything above. */
  extra: Record<string, string>;
  /** Set when a location was filled in from the home site because the data had none. */
  geo_note: string | null;
  /** Present when the backend scored the event. */
  anomaly?: Anomaly | null;
  source: "csv" | "elastic";
  is_replay: boolean;
}
