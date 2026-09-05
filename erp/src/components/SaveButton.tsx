"use client";
import type { Gate } from "@/lib/permission-ui";
import { useUnsavedSection } from "@/lib/use-unsaved-section";

/**
 * The one Save-button shape every EXPLICIT-SAVE grid shares — the four order-hub sections
 * (Containers, Serials, Charges, Loads) and the three on a shipment, which had hand-rolled five
 * copies of the same markup between them.
 *
 * It also declares the section to the unsaved-edit guard. A detail page runs two save models at
 * once: the fields at the top of the order hub save on BLUR, while these grids need this button
 * clicked, and nothing on screen said which was which. Registering from inside the button means a
 * section that USES this button cannot acquire an explicit Save without also announcing what is at
 * risk when someone navigates away.
 *
 * That is not, by itself, a guarantee about the app — and #272 originally claimed it was. It binds
 * only the editors that adopt this button, and several explicit-save editors did not: the invoice
 * lines grid, the template editor, cert results, process steps, the process-template boilerplate,
 * the quote page, custom fields and the receivables apply panel all held a draft while
 * `unsavedLabels()` stayed empty. The census that actually holds the line is
 * tests/unsaved-registration-sweep.test.ts, which fails on any explicit-save editor that does not
 * register; those that cannot use this button call `useUnsavedSection` directly.
 *
 * `section` is the human name the prompt uses ("Containers has unsaved changes…"), so it is a
 * separate prop from `label`: the button reads "Save containers", the sentence needs "Containers".
 */
export function SaveButton({ label, section, gate, dirty, onSave, alsoUnsaved = false }: {
  label: string;
  /** Human name of the section for the navigation prompt — capitalised, e.g. "Containers". */
  section: string;
  gate: Gate;
  dirty: boolean;
  onSave: () => void;
  /**
   * Work held in this section that this button CANNOT save — a value typed into an entry field but
   * not yet committed into the grid. It arms the navigation guard without enabling Save, because
   * the two questions are different: "is anything at risk if we leave" and "is there anything this
   * click would write". Serials' "Add serial(s)" range box is the case that found this (Codex P1 on
   * #272): the text is real work, reloading loses it, and a blur during unload cannot arm the
   * listener in time — but Save has nothing to send until the range is expanded into rows.
   */
  alsoUnsaved?: boolean;
}) {
  useUnsavedSection(dirty || alsoUnsaved, section);
  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={onSave} disabled={!gate.allowed || !dirty} title={gate.title}
              className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400">
        {label}
      </button>
      {/* Shown only while dirty, which is exactly when the difference between the two save models
          matters. The blur-save fields above never reach this state — they are already committed
          by the time focus leaves them — so the badge's presence IS the distinction.
          Deliberately NOT `alsoUnsaved`: that work is still sitting visible in its own input, and
          a badge beside a Save this click cannot enable reads as a broken control. */}
      {dirty && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
          Unsaved changes
        </span>
      )}
    </span>
  );
}
