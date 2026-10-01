import { TalkerStats } from "./talkers";
import { SEVERITY_COLOR } from "./types";

const CELLS = [
  { key: "critical", name: "Critical" },
  { key: "major", name: "Major" },
  { key: "high", name: "High" },
] as const;

/** Big severity counts across the top of the map for wall mode ("last 5
 *  min: 12 critical, 40 major, ..."). Hidden outside wall mode by CSS. */
export class Headline {
  private nums = new Map<string, HTMLElement>();
  private total = document.createElement("div");
  private keyCell = document.createElement("div");
  private keyNum = document.createElement("div");
  private timer: number;

  constructor(private stats: TalkerStats, windowSec: number, parent: HTMLElement, private hasAssets: () => boolean = () => false) {
    const root = document.createElement("div");
    root.id = "headline";

    const label = document.createElement("div");
    label.className = "hl-label";
    label.textContent = `LAST ${Math.round(windowSec / 60)} MIN`;
    root.append(label);

    for (const { key, name } of CELLS) {
      const cell = document.createElement("div");
      cell.className = "hl-cell";
      const num = document.createElement("div");
      num.className = "hl-num";
      num.style.color = SEVERITY_COLOR[key];
      const nm = document.createElement("div");
      nm.className = "hl-name";
      nm.textContent = name;
      cell.append(num, nm);
      root.append(cell);
      this.nums.set(key, num);
    }

    // Only meaningful once asset names are configured, so it stays hidden until then.
    this.keyCell.className = "hl-cell hl-key";
    this.keyNum.className = "hl-num";
    const kn = document.createElement("div");
    kn.className = "hl-name";
    kn.textContent = "Key assets hit";
    this.keyCell.append(this.keyNum, kn);
    root.append(this.keyCell);

    const totalCell = document.createElement("div");
    totalCell.className = "hl-cell hl-total";
    this.total.className = "hl-num";
    const tn = document.createElement("div");
    tn.className = "hl-name";
    tn.textContent = "Total";
    totalCell.append(this.total, tn);
    root.append(totalCell);

    parent.append(root);
    this.render();
    this.timer = window.setInterval(() => this.render(), 2000);
  }

  render(now = Date.now()): void {
    const t = this.stats.severityTotals(now);
    for (const { key } of CELLS) this.nums.get(key)!.textContent = t[key].toLocaleString();
    this.total.textContent = t.total.toLocaleString();
    this.keyCell.hidden = !this.hasAssets();
    this.keyNum.textContent = this.stats.keyAssetHits(now).toLocaleString();
  }

  dispose(): void { window.clearInterval(this.timer); }
}
