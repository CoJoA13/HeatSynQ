import { describe, expect, it } from "vitest";
import { rowsAfterSave } from "@/lib/field-drafts";

// The post-save merge behind CustomFieldsSection (src/app/parts/[id]/), extracted so it can be
// tested at all: the vitest environment is "node" with no DOM, so the component itself is out of
// reach — the step-drafts.ts precedent, adapted to that editor's snapshot-diff shape (#148).
//
// The regression this model exists for: the inputs stay editable during the PUT by design (the
// ProcessStepsSection editsAfterSave rule), and the success handler used to wholesale-replace
// `rows` with the follow-up fetch — wiping anything typed into ANOTHER field during the round
// trip. The merge keeps any field whose draft moved while the request was in flight, and takes
// the server's value everywhere else.

type Row = { fieldId: string; name: string; type: string; sort: number; active: boolean; value: string };
const row = (fieldId: string, value: string, extra: Partial<Omit<Row, "fieldId" | "value">> = {}): Row =>
  ({ fieldId, name: fieldId, type: "TEXT", sort: 0, active: true, ...extra, value });

describe("rowsAfterSave", () => {
  it("takes the server's value for every field untouched during the flight", () => {
    const atSave = [row("f1", "sent"), row("f2", "unchanged")];
    const server = [row("f1", "sent"), row("f2", "unchanged")];
    expect(rowsAfterSave(server, atSave, atSave)).toEqual(server);
  });

  // The wipe itself: f2 was typed into while f1's save was in flight. The old handler replaced
  // the whole array with the server's rows, discarding "typed during save".
  it("keeps a text value typed into another field while the request was in flight", () => {
    const atSave = [row("f1", "old"), row("f2", "")];
    const current = [row("f1", "old"), row("f2", "typed during save")];
    const server = [row("f1", "old"), row("f2", "")];
    expect(rowsAfterSave(server, atSave, current))
      .toEqual([row("f1", "old"), row("f2", "typed during save")]);
  });

  it("keeps a checkbox toggled while the request was in flight", () => {
    const atSave = [row("f1", "false", { type: "CHECKBOX" })];
    const current = [row("f1", "true", { type: "CHECKBOX" })];
    const server = [row("f1", "false", { type: "CHECKBOX" })];
    expect(rowsAfterSave(server, atSave, current)).toEqual(current);
  });

  // The H-added "clear" control stages "" the same way every other edit does — a mid-flight
  // clear is typing too, and "" must not be mistaken for "nothing typed".
  it("keeps a checkbox cleared to unset while the request was in flight", () => {
    const atSave = [row("f1", "true", { type: "CHECKBOX" })];
    const current = [row("f1", "", { type: "CHECKBOX" })];
    const server = [row("f1", "true", { type: "CHECKBOX" })];
    expect(rowsAfterSave(server, atSave, current)).toEqual(current);
  });

  it("keeps a date picked while the request was in flight", () => {
    const atSave = [row("f1", "2026-08-01", { type: "DATE" })];
    const current = [row("f1", "2026-08-19", { type: "DATE" })];
    const server = [row("f1", "2026-08-01", { type: "DATE" })];
    expect(rowsAfterSave(server, atSave, current)).toEqual(current);
  });

  it("keeps a number typed while the request was in flight", () => {
    const atSave = [row("f1", "1.5", { type: "NUMBER" })];
    const current = [row("f1", "2.75", { type: "NUMBER" })];
    const server = [row("f1", "1.5", { type: "NUMBER" })];
    expect(rowsAfterSave(server, atSave, current)).toEqual(current);
  });

  // The editsAfterSave rule's other half: typed during the flight and then typed BACK to what the
  // save submitted is no longer the user's — the server's copy shows through.
  it("takes the server's value for a field typed back to its at-save value", () => {
    const atSave = [row("f1", "sent")];
    const current = [row("f1", "sent")]; // typed away and back while in flight
    const server = [row("f1", "sent-normalized")];
    expect(rowsAfterSave(server, atSave, current)).toEqual(server);
  });

  // The step-drafts carry-forward lesson: an untouched field must adopt another user's
  // concurrent change instead of masking it with this user's stale clean copy.
  it("adopts another user's concurrent change to an untouched field", () => {
    const atSave = [row("f1", "mine"), row("f2", "theirs-before")];
    const server = [row("f1", "mine"), row("f2", "theirs-after")];
    expect(rowsAfterSave(server, atSave, atSave)).toEqual(server);
  });

  // Only the VALUE is ever the user's — name/active/sort/type are server metadata and must come
  // from the fresh fetch even on a row whose draft value is kept (e.g. a def renamed mid-flight).
  it("takes the server's metadata even on a row whose in-flight value is kept", () => {
    const atSave = [row("f1", "old", { name: "Old name" })];
    const current = [row("f1", "typed", { name: "Old name" })];
    const server = [row("f1", "old", { name: "New name", active: false, sort: 3 })];
    expect(rowsAfterSave(server, atSave, current))
      .toEqual([row("f1", "typed", { name: "New name", active: false, sort: 3 })]);
  });

  it("includes a row the server added since the save left, with the server's value", () => {
    const atSave = [row("f1", "a")];
    const server = [row("f1", "a"), row("f2", "fresh")];
    expect(rowsAfterSave(server, atSave, atSave)).toEqual(server);
  });

  it("drops a row the server no longer returns, even if it was typed into", () => {
    const atSave = [row("f1", "a"), row("f2", "b")];
    const current = [row("f1", "a"), row("f2", "typed")];
    const server = [row("f1", "a")];
    expect(rowsAfterSave(server, atSave, current)).toEqual([row("f1", "a")]);
  });

  it("handles an empty server list and an empty draft", () => {
    expect(rowsAfterSave([], [], [])).toEqual([]);
    expect(rowsAfterSave([row("f1", "x")], [], [])).toEqual([row("f1", "x")]);
  });
});
