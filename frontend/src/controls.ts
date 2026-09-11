import { ArcEngine } from "./arcs";

export function wireControls(engine: ArcEngine): void {
  const liveToggle = document.getElementById("live-toggle") as HTMLInputElement;
  liveToggle.addEventListener("change", () => engine.setPaused(!liveToggle.checked));

  const sevIds = ["critical", "major", "high"] as const;
  function readSeverities(): Set<string> {
    const set = new Set<string>(["unknown"]); // always show unclassified events
    for (const s of sevIds) {
      const box = document.getElementById(`sev-${s}`) as HTMLInputElement;
      if (box.checked) set.add(s);
    }
    return set;
  }
  for (const s of sevIds) {
    document.getElementById(`sev-${s}`)!.addEventListener("change", () => {
      engine.setEnabledSeverities(readSeverities());
    });
  }

  const intensity = document.getElementById("intensity") as HTMLInputElement;
  const intensityLabel = document.getElementById("intensity-label")!;
  intensity.addEventListener("input", () => {
    intensityLabel.textContent = `${intensity.value} / 10`;
  });
  intensity.addEventListener("change", async () => {
    await fetch("/api/controls/intensity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intensity: Number(intensity.value) }),
    });
  });

  const fileInput = document.getElementById("csv-file") as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    const resp = await fetch("/api/upload", { method: "POST", body });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({ detail: resp.statusText }));
      alert(`Upload failed: ${detail.detail}`);
      return;
    }
    const result = await resp.json();
    alert(`Loaded ${result.rows} rows from ${result.filename}. The simulated feed will start firing from it.`);
  });
}
