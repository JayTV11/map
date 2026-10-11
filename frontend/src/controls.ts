import { url } from "./base";
import { ArcEngine } from "./arcs";

/** Live toggle, CSV-intensity slider, and the dataset upload button.
 *  (The severity filter lives in severityUi.ts; picking a file hands it to
 *  the upload dialog, see ingestDialog.ts.) */
export function wireControls(engine: ArcEngine, onFile: (file: File) => void): void {
  const liveToggle = document.getElementById("live-toggle") as HTMLInputElement;
  liveToggle.addEventListener("change", () => engine.setPaused(!liveToggle.checked));

  const intensity = document.getElementById("intensity") as HTMLInputElement;
  const intensityLabel = document.getElementById("intensity-label")!;
  intensity.addEventListener("input", () => {
    intensityLabel.textContent = `${intensity.value} / 10`;
  });
  intensity.addEventListener("change", async () => {
    await fetch(url("/api/controls/intensity"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intensity: Number(intensity.value) }),
    });
  });

  const fileInput = document.getElementById("csv-file") as HTMLInputElement;
  fileInput.accept = ".csv,.tsv,.txt,.json,.ndjson,.jsonl"; // the page's own filter only allows .csv
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // so choosing the same file again still fires
    if (file) onFile(file);
  });
}
