import { SeverityLevel, setSeverityLevels } from "./types";

export interface AppConfig {
  severity: { levels: SeverityLevel[]; unknown: SeverityLevel };
  home: { lat: number; lon: number; label: string };
}

const DEFAULT_CONFIG: AppConfig = {
  severity: {
    levels: [
      { id: "critical", label: "Critical", color: "#ff3868" },
      { id: "major", label: "Major", color: "#ff9f2e" },
      { id: "high", label: "High", color: "#ffe066" },
    ],
    unknown: { id: "unknown", label: "Unknown", color: "#4f8cff" },
  },
  home: { lat: 36.0104, lon: -84.2696, label: "Oak Ridge, TN" },
};

/** Loads the severity scale and home site from the backend and applies the
 *  scale. If the backend is older (no /api/config) or unreachable, the
 *  built-in defaults are used so the page still comes up. */
export async function loadConfig(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<AppConfig> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 3000);
  try {
    const resp = await fetchImpl("/api/config", { cache: "no-store", signal: ctl.signal });
    if (!resp.ok) throw new Error(String(resp.status));
    const cfg = (await resp.json()) as AppConfig;
    if (!Array.isArray(cfg.severity?.levels) || cfg.severity.levels.length === 0) throw new Error("no levels");
    setSeverityLevels(cfg.severity.levels);
    return { severity: cfg.severity, home: cfg.home ?? DEFAULT_CONFIG.home };
  } catch {
    return DEFAULT_CONFIG;
  } finally {
    window.clearTimeout(timer);
  }
}
