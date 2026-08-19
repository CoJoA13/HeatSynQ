import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block in the schema, as [name, body] pairs. */
function models(): [string, string][] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/**
 * Columns declared unique only among live rows, e.g. @@unique([code], where: raw("…")) —
 * scoped per model (#35), so a call site whose receiver names a delegate is tested against
 * that one model's columns instead of a schema-wide union of every model's.
 */
function partialUniqueColumnsByModel(): Map<string, Set<string>> {
  const byModel = new Map<string, Set<string>>();
  for (const [name, body] of models()) {
    const cols = new Set<string>();
    for (const m of body.matchAll(/@@unique\(\[([^\]]+)\][^)]*\bwhere:/g)) {
      const parts = m[1].split(",").map((c) => c.trim());
      parts.forEach((c) => cols.add(c));
      // Prisma also generates a compound-key field on WhereUniqueInput for a multi-column
      // @@unique, e.g. @@unique([customerId, partNumber], where: …) produces
      // `customerId_partNumber` — a lookup keyed on that compound name hits the exact same
      // soft-deleted-row hole as a single column and must be covered too.
      if (parts.length > 1) cols.add(parts.join("_"));
    }
    if (cols.size > 0) byModel.set(name, cols);
  }
  return byModel;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("partial unique sweep", () => {
  // A partial unique index does NOT remove the column from the generated WhereUniqueInput —
  // verified against Prisma 7.9.1, where the type stays AtLeast<{…}, "id" | "code">. So
  // findUnique({ where: { code } }) compiles, and silently returns the SOFT-DELETED row
  // instead of the live one. upsert on the same column is state-dependent and its worst case
  // is silent too: with only a dead row it succeeds and quietly reuses that dead row (the row
  // stays deleted); with both a dead and a live row it throws P2039. Neither the silent reuse
  // nor the findUnique misread is caught by tsc, eslint, or any behavioural test that happens
  // not to have a deleted row lying around. This sweep is the only thing standing between
  // that and production.
  //
  // findUniqueOrThrow shares findUnique's misread — it throws only when NO row (live or dead)
  // matches, so a dead-only match returns the dead row instead of throwing. update and delete
  // are worse than either: keyed on a live-rows-only column, they silently write to, or
  // hard-delete, the archived row while the live row goes completely untouched — no exception
  // of any kind. updateMany/deleteMany are unaffected (they take a filter, not a
  // WhereUniqueInput) and stay excluded below by requiring "(" immediately after the method
  // name, so "updateMany(" and "deleteMany(" cannot match this alternation.
  it("no findUnique, findUniqueOrThrow, upsert, update, or delete is keyed on a live-rows-only unique column", () => {
    const byModel = partialUniqueColumnsByModel();
    const globalUnion = new Set([...byModel.values()].flatMap((s) => [...s]));
    expect(globalUnion.size).toBeGreaterThan(0); // the sweep is worthless if the parse silently fails

    // Call sites are scoped to the model their receiver names (#35): `prisma.orderDraft
    // .findUnique(...)` is tested against OrderDraft's partial-unique columns only. A Prisma
    // delegate is the model name with its first letter lowercased, so every model gets a
    // delegate entry — including models with NO partial columns, whose empty set is exactly what
    // clears them. That is what lets two unrelated models share a column name without a false
    // positive: SavedView's `@@unique([userId, name], where: ...)` contributes the bare name
    // "userId", which under the old schema-wide union (mis)matched OrderDraft.userId — a plain
    // `@unique` on a model with no `deletedAt` at all (OrderDraft is not soft-deletable, so it
    // cannot have this bug by construction) — and forced an exact-call-site allowlist here.
    //
    // The scoping is conservative in the only direction that matters: a call whose receiver is
    // NOT captured, or is captured but is no known delegate — a bare variable, a destructured
    // delegate, or a receiver split across lines (`prisma.orderDraft\n.findUnique(` captures
    // nothing; the accepted residual) — falls back to the GLOBAL union of every model's partial
    // columns, so detection strength never decreases; a genuinely ambiguous receiver still flags.
    const byDelegate = new Map<string, Set<string>>();
    for (const [model] of models()) {
      byDelegate.set(model[0].toLowerCase() + model.slice(1), byModel.get(model) ?? new Set());
    }

    const files = [...tsFiles(join(process.cwd(), "src")), join(process.cwd(), "prisma/seed.ts")];
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:\.(\w+))?\.(findUnique|findUniqueOrThrow|upsert|update|delete)\(\s*\{\s*where:\s*\{\s*(\w+)/g)) {
        const [, receiver, method, column] = m;
        const scope = receiver !== undefined && byDelegate.has(receiver) ? byDelegate.get(receiver)! : globalUnion;
        if (scope.has(column)) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}: .${method}({ where: { ${column} … } })`);
        }
      }
    }

    expect(offenders, `Use findFirst({ where: { <col>, deletedAt: null } }) instead — upsert on a
partially-unique column silently reuses a dead row when only a dead row exists (and throws
P2039 when both a dead and a live row exist); findUnique/findUniqueOrThrow return the
soft-deleted row; update/delete silently write to, or hard-delete, the archived row while the
live row goes untouched.`).toEqual([]);
  });

  // The invariant behind §5.18: if a model can be soft-deleted, a plain @unique on it means a
  // deleted row keeps occupying that value — which is exactly what forced revival-on-create,
  // and with it the audit-identity bug in issue #10.
  it("every soft-deletable model's unique columns are live-rows-only", () => {
    // User.username is deliberately excluded: nothing ever sets User.deletedAt — there is no
    // deleteUser in src/server/users.ts and no user DELETE route — so no row is ever soft-deleted
    // for a re-create to collide with. Recorded here rather than left as an unexplained gap. If a
    // deleteUser (or a user DELETE route) ever lands, this allowlist entry is exactly what would
    // hide the resulting regression — remove it and give User.username the same partial-unique
    // treatment as everything else the day that happens.
    //
    // Order.orderNumber is deliberately excluded too: voided orders keep their number forever;
    // numbers are allocation-only and never reused or re-entered (spec §4). Unlike every other
    // partial-unique candidate, a voided order's number must NOT free up for a later order to
    // claim — that reuse is exactly the double-billing adjacency the no-duplication rule exists
    // to prevent (design spec §4, HANDOFF §5.11's revival-on-create precedent, deliberately not
    // applied here). Do not "fix" this by giving orderNumber the partial-unique treatment.
    //
    // Order.clientRequestId sits beside it for the identical reason (fix-wave R4 finding 5). It is
    // the entry form's idempotency nonce: the whole point is that the request which created an
    // order owns that nonce PERMANENTLY, so a replay of it resolves to the order it already made
    // rather than making another. Freeing the value up when the order is voided would hand the
    // nonce back to a retry and re-create precisely the duplicate the column exists to stop — the
    // same no-revival rationale as orderNumber, one step earlier in the sequence. NULLs never
    // collide in a Postgres unique index, so historic rows and every caller that sends no nonce
    // are unaffected without needing the partial-index treatment at all.
    //
    // Shipper's three (Phase 4 §4.2) are the same no-reuse contract one document further along:
    //
    //   Shipper.shipperNumber   — a voided shipment keeps its packing-list number forever;
    //                             allocation-only, never reused or re-entered (§3.19). The number
    //                             is already printed on paper in a customer's hands, so freeing it
    //                             up for a later shipment to claim would put two different
    //                             shipments behind one packing-list number.
    //   Shipper.bolNumber       — allocated lazily at first BOL print and never reissued; a voided
    //                             shipment keeps it (§3.19). Same paper-in-hand reasoning, and a
    //                             BOL number additionally travels with a carrier.
    //   Shipper.clientRequestId — idempotency key; handing it back to a retry would recreate the
    //                             duplicate it exists to stop (P3 §4). Exactly Order.clientRequestId's
    //                             rationale, for the shipment save.
    //
    // Cert deliberately adds nothing here: it has no unique column at all (§3.19) — a cert carries
    // no number of its own, and its per-scope-instance uniqueness is service-enforced under
    // claimOrder because a partial index cannot express it (NULLs never collide, so two
    // (orderId, ORDER, NULL, NULL) rows would not conflict). Do not add one.
    //
    // Invoice's two (Phase 5A §7) are the same no-reuse contract one document further along again:
    //
    //   Invoice.creditNumber   — allocated from `credit_number_next` at credit creation and never
    //                            reissued; a discarded draft must never free a number a customer
    //                            holds on paper. Exactly Shipper.bolNumber's reasoning for a
    //                            document that travels to a customer's accounts-payable desk.
    //   Invoice.clientRequestId — idempotency key; handing it back to a retry would recreate the
    //                            duplicate it exists to stop (P3 §4). Order.clientRequestId's
    //                            rationale, for the invoice save.
    //
    // Invoice's LIVE-rows-only guard is a separate thing and is NOT exempted: the one-live-
    // invoice-per-order rule is @@unique([orderId], where: raw("… AND kind = 'INVOICE'")), a
    // proper partial index, and it must stay that way.
    //
    // ReceiptBatch.batchNumber (Phase 5B, Task 2 — the model doesn't exist yet, so this entry
    // sits unused until then): allocation-only, never reissued — a voided batch keeps its number.
    //
    // Quote.quoteNumber (Phase 6 §4.1) is Order.orderNumber's exact reasoning one document
    // earlier in the sequence: allocation-only from quote_number_next, never reused or
    // re-entered — a deleted quote keeps its number forever, because that number is already on
    // paper (and in a customer's purchasing files) as the standing agreement's identity, and
    // freeing it for a later quote to claim would put two different price agreements behind one
    // quote number. Do not "fix" this by giving quoteNumber the partial-unique treatment.
    const ALLOWED = new Set([
      "User.username", "Order.orderNumber", "Order.clientRequestId",
      "Shipper.shipperNumber", "Shipper.bolNumber", "Shipper.clientRequestId",
      "Invoice.creditNumber", "Invoice.clientRequestId",
      "ReceiptBatch.batchNumber",
      // Allocation-only from gl_export_batch_number_next, never reissued (a discarded/reversed export
      // must never free a number a batch already carries) — the creditNumber/batchNumber precedent.
      "GlExportBatch.exportNumber",
      "Quote.quoteNumber",
    ]);

    // [ \t]+ (not \s+) here too: \s+ would let this match bridge across a blank line the same
    // way the field-level match below used to (see comment there) — a schema reformat that
    // happened to break this specific pattern must fail the assertion right below it, not
    // silently evaluate zero models and pass.
    const softDeletable = models().filter(([, body]) => /^[ \t]*deletedAt[ \t]+DateTime\?/m.test(body));
    expect(softDeletable.length).toBeGreaterThan(0); // a broken parse must not silently empty this sweep

    const offenders: string[] = [];
    for (const [name, body] of softDeletable) {
      // [ \t]+ (not \s+) and a negative lookbehind on the `@` keep this match on a single field
      // declaration line. `\s+` matches newlines too, so with the schema's blank line before a
      // model's own `@@unique([...], where: ...)` block, `\s+` bridges straight through the field
      // line, the blank line, and the leading `@` of `@@unique` — and "@@unique" contains
      // "@unique" as a substring, so the block-level constraint itself was being misread as a
      // field-level `@unique` on whatever field happened to be declared last. Caught by running
      // this test for real: it flagged Role.permissions, GlAccount.processStepCodes,
      // ProcessStepCode.fields, InspectionScale.codes, Terms.customers, and Customer.contacts —
      // none of which carry `@unique` at all.
      for (const m of body.matchAll(/^[ \t]*(\w+)[ \t]+\S+[ \t]+.*(?<!@)@unique/gm)) {
        const key = `${name}.${m[1]}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }

      // Block-level compound uniques are the same hole in a different shape: a bare
      // @@unique([a, b]) on a soft-deletable model isn't a field-level @unique at all (so the
      // loop above never sees it), but a deleted row still occupies the compound value forever,
      // and the generated WhereUniqueInput still exposes the compound key (a_b) for a lookup to
      // misread — e.g. a Part model's @@unique([customerId, partNumber]) without `where:`. Skip
      // blocks that *do* carry `where:`; that's the correct partial-unique pattern already used
      // 13 times over in this schema.
      for (const m of body.matchAll(/@@unique\(\[([^\]]+)\][^)]*\)/g)) {
        if (!m[0].includes("where:")) {
          offenders.push(`${name}.@@unique([${m[1].split(",").map((c) => c.trim()).join(", ")}])`);
        }
      }
    }

    expect(offenders, `These columns are @unique (or a bare @@unique([...]) block) on a
soft-deletable model. A deleted row will occupy the value forever, forcing revival-on-create
back into existence (handoff §5.18). Use @@unique([col], where: raw("\\"deletedAt\\" IS NULL"))
instead — for a compound block, @@unique([a, b], where: raw("\\"deletedAt\\" IS NULL")).`).toEqual([]);
  });
});
