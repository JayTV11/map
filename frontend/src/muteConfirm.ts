/** The "Mute this source" confirmation. Muting hides a source's events from every analyst's screen, so it
 *  asks first, says exactly what will happen, and warns when the event in front of the analyst is serious.
 *  A modal (not inline) so the detail panel redrawing underneath, as repeats arrive, can't wipe it. */

export interface MuteRequest {
  /** The address, or (for kind "signature") the signature name. */
  ip: string;
  kind?: "source" | "signature";
  /** A name for the source, when it is a known system, to pre-fill the note. */
  defaultNote: string;
  /** Plain-text warnings (e.g. "this event is Critical"), shown above the buttons. */
  warnings: string[];
  /** Does the change. Resolves to an error message, or null on success. */
  submit(note: string): Promise<string | null>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: addresses and names come from the network
  return e;
}

export function openMuteConfirm(req: MuteRequest): void {
  if (document.querySelector(".mute-confirm")) return;
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el("div", "mute-confirm popout-overlay");
  const dialog = el("div", "mc-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Mute this source");

  const isSig = req.kind === "signature";
  dialog.setAttribute("aria-label", isSig ? "Mute this signature" : "Mute this source");
  const title = el("h2", undefined, isSig ? `Mute every “${req.ip}” alert?` : `Mute ${req.ip}?`);
  const what = el("p", "mc-text", isSig
    ? "Every event with this signature, from ANY source to ANY target, will be hidden from every analyst's screen and from the wall: " +
      "not drawn, not in the log, not counted. That includes a real attack that happens to trigger it. " +
      "The “muted” badge still counts them, and Elastic is untouched. You can undo this in the Known-Good panel."
    : "Its events will be hidden from every analyst's screen and from the wall: not drawn on the map, not in the log, not counted. " +
      "The “muted” badge still counts them, and Elastic is untouched. You can undo this in the Known-Good Sources panel.");
  const warn = el("div", "mc-warn");
  for (const w of req.warnings) warn.append(el("div", undefined, w));
  warn.hidden = req.warnings.length === 0;

  const label = el("label", "mc-label", isSig ? "Why is it safe to hide? (required, shown to the next analyst)" : "What is it? (so the next analyst knows)");
  const note = el("input", "mc-note");
  note.type = "text";
  note.maxLength = 120;
  note.value = req.defaultNote;
  note.placeholder = isSig ? "e.g. Noisy rule, tuned in Suricata on the 12th" : "e.g. Nessus scanner, backup server";
  label.append(note);

  const msg = el("div", "mc-msg");
  msg.setAttribute("role", "alert");
  const ok = el("button", "btn mc-ok", isSig ? "Mute this signature" : "Mute this source");
  ok.type = "button";
  const cancel = el("button", "btn mc-cancel", "Cancel");
  cancel.type = "button";
  const row = el("div", "mc-actions");
  row.append(cancel, ok);
  dialog.append(title, what, warn, label, msg, row);
  overlay.append(dialog);

  const close = (): void => { overlay.remove(); returnTo?.focus?.(); };
  cancel.addEventListener("click", close);
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  dialog.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    else if (ev.key === "Enter" && ev.target === note) { ev.preventDefault(); ok.click(); }
    ev.stopPropagation(); // typing here must not trigger the page's single-key shortcuts
  });
  ok.addEventListener("click", async () => {
    if (isSig && note.value.trim().length < 5) { msg.textContent = "Please give a reason (at least 5 characters)."; note.focus(); return; }
    ok.disabled = true;
    msg.textContent = "";
    const err = await req.submit(note.value.trim());
    if (err === null) { close(); return; }
    msg.textContent = err;
    ok.disabled = false;
  });
  document.body.append(overlay);
  note.focus();
  note.select();
}
