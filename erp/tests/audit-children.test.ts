import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { callsBareIdentifier, isLocalSpecifier, resolveLocalModule } from "./helpers/ts-parse";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import {
  AUDIT_CHILD_ENTITIES, AUDIT_PANEL_LIMIT, SNAPSHOT_INCLUDE, auditedUpdate, hopIds,
  readAudit, readAuditWithChildren,
} from "@/server/audit";
import { AUDIT_CHILDREN, auditChildLabel, auditChildrenOf } from "@/lib/audit-children";
import { GET as auditGet } from "@/app/api/admin/audit/route";
import { createPart, updatePart } from "@/server/parts";
import { addPartSpec, removePartSpec } from "@/server/part-specifications";
import { addPartInspection } from "@/server/part-inspections";
import { addPartPrice, addPriceBreak, deletePartPrice, deletePriceBreak } from "@/server/part-prices";
import { createPartFieldDef } from "@/server/part-field-defs";
import { setPartFieldValues } from "@/server/part-field-values";
import { addAttachment } from "@/server/attachments";
import { addStep } from "@/server/part-process-steps";
import { createCustomer, updateCustomer } from "@/server/customers";
import { addAddress, deleteAddress } from "@/server/customer-addresses";
import { addContact } from "@/server/customer-contacts";
import { createSurcharge, setCustomerSurcharge } from "@/server/surcharges";
import { assignTemplate } from "@/server/template-assignments";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The (entity, entityId) pairs of a union read, newest-first — what the panel actually renders. */
async function unionPairs(entity: string, entityId: string): Promise<[string, string][]> {
  const { rows } = await readAuditWithChildren(entity, entityId);
  return rows.map((r) => [r.entity, r.entityId] as [string, string]);
}

async function partFixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const { id: partId } = await asSystem(() =>
    createPart({ customerId: customer.id, partNumber: "12345", eachWeight: 1 }));
  return { customerId: customer.id, partId };
}

describe("#153 — the registry is the whole design", () => {
  beforeEach(truncateAll);

  it("every registered child entity is auditable, and the projection covers the whole registry", () => {
    const entities: string[] = [];
    for (const [parent, specs] of Object.entries(AUDIT_CHILDREN)) {
      for (const spec of specs) {
        // A child whose entity is not an AuditableModel could never have written a row under it —
        // the registry entry would be dead weight that silently resolves to nothing forever.
        expect(Object.hasOwn(SNAPSHOT_INCLUDE, spec.entity), `${parent} → ${spec.entity}`).toBe(true);
        expect(spec.paths.length, `${parent} → ${spec.entity} needs at least one path`)
          .toBeGreaterThan(0);
        entities.push(spec.entity);
      }
    }
    // AUDIT_CHILD_ENTITIES is what carries the COMPILE-TIME check (it is annotated
    // `AuditableModel[]`, which the client-safe registry cannot annotate itself). That guarantee
    // is only as wide as the projection, so pin that it still enumerates every entry.
    expect([...AUDIT_CHILD_ENTITIES].sort()).toEqual([...entities].sort());
  });

  it("executes EVERY registry hop against the real schema, and proves it covered them all", async () => {
    // Derived from the registry independently of the execution loop below. If the execution ever
    // stops reaching some hops — which is exactly what happened when this sweep walked whole
    // chains from a bogus parent id, short-circuiting after the first hop and never executing the
    // inner hop of `application → paymentId → payment → batchId` — `covered` shrinks while this
    // stays complete, and the final comparison fails.
    const expected = new Set<string>();
    for (const specs of Object.values(AUDIT_CHILDREN)) {
      for (const spec of specs) {
        for (const path of spec.paths) {
          for (const hop of path) expected.add(`${hop.model}.${hop.fk}`);
        }
      }
    }

    const covered = new Set<string>();
    for (const specs of Object.values(AUDIT_CHILDREN)) {
      for (const spec of specs) {
        for (const path of spec.paths) {
          // Each hop driven on its OWN, through the production `hopIds` — not a replica, and
          // never by walking the chain. A bogus id list is enough: the query has to COMPILE
          // against the real schema, which is what catches a typo'd model or column. The
          // registry names both as plain strings (it must stay browser-importable), so nothing
          // else can catch one.
          for (const hop of path) {
            await expect(hopIds(hop.model, hop.fk, ["no-such-id"]), `${hop.model}.${hop.fk}`)
              .resolves.toEqual([]);
            covered.add(`${hop.model}.${hop.fk}`);
          }
        }
      }
    }

    expect([...covered].sort()).toEqual([...expected].sort());
    expect(covered.size).toBeGreaterThan(0);
  });

  it("an unknown model name in a path fails loudly rather than resolving to nothing", async () => {
    // The other half of the guarantee above: a hop that does not compile must THROW, not answer
    // an empty list — an empty list is indistinguishable from a correct hop finding no children,
    // which is how a typo would ship green.
    await expect(hopIds("partPriceBreek", "partPriceId", ["x"])).rejects.toThrow(/no Prisma model/);
  });

  it("a parent with no rows reads empty end to end", async () => {
    for (const parent of Object.keys(AUDIT_CHILDREN)) {
      await expect(readAuditWithChildren(parent, "no-such-parent-id")).resolves.toEqual({
        rows: [], hasMore: false,
      });
    }
  });

  it("guards the lookup against prototype keys", async () => {
    expect(auditChildrenOf("__proto__")).toEqual([]);
    expect(auditChildrenOf("toString")).toEqual([]);
    expect(auditChildrenOf("constructor")).toEqual([]);
    expect(auditChildLabel("__proto__", "partPrice")).toBeNull();
    await expect(readAuditWithChildren("__proto__", "anything")).resolves.toEqual({ rows: [], hasMore: false });
  });

  it("labels a foreign row by its child section, and the parent's own rows not at all", () => {
    expect(auditChildLabel("part", "partPriceBreak")).toBe("Pricing break");
    expect(auditChildLabel("customer", "customerAddress")).toBe("Address");
    // Same child, two parents, two truthful labels — which is why the label is per-(parent, child).
    expect(auditChildLabel("customer", "customerSurcharge")).toBe("Surcharge override");
    expect(auditChildLabel("surcharge", "customerSurcharge")).toBe("Customer override");
    // The parent's own rows need no label, and an unregistered entity is never guessed at.
    expect(auditChildLabel("part", "part")).toBeNull();
    expect(auditChildLabel("part", "customerAddress")).toBeNull();
  });
});

/**
 * The FOURTH thing a registry entry implies (Codex round 1 on PR #156): the panel now displays
 * child rows, so the child's client mutations have to fire `invalidateHistory()` or the panel
 * advertises that history and then goes stale on exactly the edits it just started advertising.
 * `#14 item 1` wired only the PART sections, which was correct for the pre-#153 world.
 *
 * Entity -> the client file(s) whose mutations write it AND sit on a page mounting a panel that
 * registers it. A mutation whose page mounts no panel registering that entity is deliberately
 * absent: `ReceivablesSection.tsx` writes `application` rows, but it lives on the CUSTOMER page,
 * whose panel is `customer` — which does not register `application` — so there is no stale panel
 * to refresh there.
 *
 * The per-entity file list is BEST EFFORT and the check below requires only that ONE named file
 * wires the call — nothing here can derive "every file that writes this entity" from source, so
 * do not read the lists as complete. #158's page-keyed sweep further down is what IS complete,
 * over the files that mount a panel; it exists because a second writer slipped through exactly
 * this gap (`admin/surcharges/page.tsx`, added below after the fact).
 */
const INVALIDATION_SITES: Record<string, readonly string[]> = {
  partSpecification: ["src/app/parts/[id]/SpecsSection.tsx"],
  partInspection: ["src/app/parts/[id]/InspectionsSection.tsx"],
  partPrice: ["src/app/parts/[id]/PricingSection.tsx"],
  partPriceBreak: ["src/app/parts/[id]/PricingSection.tsx"],
  partFieldValue: ["src/app/parts/[id]/CustomFieldsSection.tsx"],
  partAttachment: ["src/components/AttachmentsSection.tsx"],
  partProcessRevision: ["src/app/parts/[id]/ProcessStepsSection.tsx"],
  customerAddress: ["src/app/customers/[id]/page.tsx"],
  customerContact: ["src/app/customers/[id]/page.tsx"],
  customerSurcharge: [
    "src/app/customers/[id]/SurchargeOverridesSection.tsx",
    // The surcharge admin page's "Clear override" (#158): a `customerSurcharge` write on a page
    // whose panel is `surcharge`, which registers that same child. It was live and unwired while
    // this map stayed green, because the check below is satisfied by the file above alone.
    "src/app/admin/surcharges/page.tsx",
  ],
  customerTemplateAssignment: ["src/app/customers/[id]/TemplateAssignmentsSection.tsx"],
  orderAttachment: ["src/components/AttachmentsSection.tsx"],
  payment: ["src/app/receivables/batches/[id]/BatchDetail.tsx"],
  application: ["src/app/receivables/batches/[id]/BatchDetail.tsx"],
};

describe("#153 — a registered child implies invalidation wiring", () => {
  // WHAT THIS DOES NOT PIN, stated plainly rather than papered over (the Task 2 precedent this
  // group set): there is no DOM test environment here, so nothing below proves the call sits on
  // the SUCCESS path of the right mutation, nor that a mounted panel actually refetches. The
  // listener contract itself is pinned in tests/history-invalidation.test.ts, and the panel
  // subscribes through that same export. What this sweep does pin is the pair that actually
  // rots: a registry entry added with no wiring at all, and a wired file that later loses the
  // call. Both are silent failures — the panel keeps rendering, just stale.

  it("every registered child entity names a client file that invalidates", () => {
    const registered = new Set<string>();
    for (const specs of Object.values(AUDIT_CHILDREN)) {
      for (const spec of specs) registered.add(spec.entity);
    }
    // Coverage both ways: a new registry entry with no manifest row fails here, and a manifest
    // row left behind by a deleted registry entry fails too.
    expect([...Object.keys(INVALIDATION_SITES)].sort()).toEqual([...registered].sort());
  });

  it("every named file imports and calls invalidateHistory", () => {
    const files = new Set(Object.values(INVALIDATION_SITES).flat());
    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, `${file} must import invalidateHistory`)
        .toMatch(/import \{[^}]*invalidateHistory[^}]*\} from "@\/components\/HistoryPanel"/);
      expect(callsInvalidate(src), `${file} must call invalidateHistory()`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// #158 — the PAGE-keyed sweep. Read the two sweeps as a pair; the division is stated below.
// ---------------------------------------------------------------------------------------------

const SRC_ROOT = join(process.cwd(), "src");
const readRepoFile = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/**
 * Every file under `src/` with this extension, repo-relative and slash-separated. `".ts"` really
 * does exclude `.tsx` — `"CertDetail.tsx".endsWith(".ts")` is false, the last three characters
 * being `tsx` — which is what lets the barrel guard below ask about `.ts` modules alone.
 */
function srcFiles(ext: ".ts" | ".tsx"): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(ext))
    .map((rel) => `src/${rel.split(sep).join("/")}`)
    .sort();
}

/**
 * Every `.tsx` under `src/`. The single enumeration the mount scan and the import graph below both
 * run over, so neither can be looking at a different tree.
 */
const allTsxFiles = (): string[] => srcFiles(".tsx");

/**
 * Every `.tsx` under `src/` that MOUNTS a History panel, enumerated from the tree rather than
 * hand-listed (the `manual-capture` route-enumeration precedent). A hand list is precisely how a
 * census silently omits the one file nobody remembered — which is the defect this sweep exists to
 * catch, so it must not commit that defect itself.
 */
function panelMountingFiles(): string[] {
  return allTsxFiles().filter((file) => /<HistoryPanel[\s/>]/.test(readRepoFile(file)));
}

/**
 * Every module specifier a file imports FOR ITS VALUE — parsed, never pattern-matched (#188's
 * whole point: `const s = "./CertDetail"` is text, not an import, and the parser knows).
 *
 * **TYPE-ONLY IMPORTS ARE EXCLUDED, and that exclusion is load-bearing** (#188 part 2). A type
 * import is erased before anything runs, so it can never render the component it names — and in
 * this tree the type edge points the WRONG WAY: every `orders/[id]/*Section.tsx` carries
 * `import type { OrderLine } from "./page"`, and `parts/[id]/IdentitySection.tsx`,
 * `certs/[id]/RequirementBlock.tsx` and `shipping/[id]/ShipmentOrderPanel.tsx` do the same to
 * their own panel-mounting parent. Counting those edges folded TEN CHILD SECTIONS into the census
 * as though they wrapped the page that renders them (measured while building this — the naive
 * graph answered 16 consumers, six of them real). A child section is the entity-keyed sweep's
 * business, not this one's.
 *
 * A side-effect import (`import "./x"`) and a namespace import both count as value edges: neither
 * is erased, and over-counting an edge only ever ADDS a file to the census, which is the closed
 * direction.
 *
 * THE SCRIPT KIND IS TAKEN FROM THE FILENAME, and that matters as soon as a `.ts` file is asked
 * about — which the barrel guard below does. `const id = <T>(x: T) => x;` is a generic arrow in a
 * `.ts` file and an unclosed JSX element in a `.tsx` one, and the TSX reading SWALLOWS every import
 * after it: measured, `<T>(x: T) => x` above two imports answers `["./a", "./b"]` as TS and `[]` as
 * TSX. That is a fail-QUIET in a guard, so the kind is chosen rather than assumed. No `.ts` in this
 * tree parses differently either way today (369 files, zero specifier-list differences, zero parse
 * diagnostics) — this is closing the shape, not fixing a live miss.
 */
export function valueModuleSpecifiers(src: string, fileName = "candidate.tsx"): string[] {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const bringsValue = (clause: ts.ImportClause | undefined): boolean => {
    if (!clause) return true;                                  // `import "./x"` — a side effect
    if (clause.isTypeOnly) return false;                       // `import type { X } from "./x"`
    if (clause.name) return true;                              // a default binding
    const bindings = clause.namedBindings;
    if (!bindings) return true;
    if (ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((el) => !el.isTypeOnly);     // `import { type A, B }` still B
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (bringsValue(node.importClause)) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly
    ) {
      out.push(node.moduleSpecifier.text);                     // a value re-export is a value edge
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);                        // `await import("./x")`
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return out;
}

/**
 * The real file a LOCAL module specifier names, repo-relative, or `null` if nothing is there.
 *
 * The resolver itself is `tests/helpers/ts-parse.ts`, shared with the archival-gate sweep (#277);
 * its docstring enumerates the shapes it drops silently, and guard (a) below is where THIS sweep
 * asserts the two that would matter here are empty. Only the root is bound: `process.cwd()` is
 * `erp/` under vitest, which is what makes both `SRC_ROOT` and the answers repo-relative.
 */
function resolveLocal(fromFile: string, spec: string): string | null {
  return resolveLocalModule(process.cwd(), fromFile, spec);
}

/**
 * Resolve one module specifier to a real `.tsx` under `src/`, or `null` — the graph's edge test.
 * Anything landing outside `src/` or on a non-`.tsx` file is dropped: a panel is rendered from
 * JSX, so a panel-mounting file is always a `.tsx`.
 *
 * WHAT THIS DROPS SILENTLY, enumerated rather than summarised — the first version of this comment
 * said "the one shape" and named only the first, which is the same over-claim this round exists to
 * remove. Each of the four takes a consumer out of the census with NO failure:
 *
 *  1. a re-export BARREL written as `.ts` that forwards a `.tsx` — the barrel resolves fine and is
 *     then dropped by the `.tsx` filter, so guard (a) below cannot see it; the `.ts`-forwards-`.tsx`
 *     guard beside it is the one that can;
 *  2. a SECOND tsconfig path alias — only `@/` is hardcoded, and any other non-relative specifier
 *     answers `null` as though it were a package; guard (a) asserts `@/` is still the only one;
 *  3. an EXTENSION-CARRYING specifier — `"./CertDetail.js"`, which `moduleResolution: "bundler"`
 *     accepts and `tsc` does not red. `"./X.tsx"` now resolves (the trailing candidate above);
 *     a `.js` spelling of a `.tsx` file still does not, and guard (a) names it;
 *  4. `require()` or a dynamic `import(variable)` — no string literal, so `valueModuleSpecifiers`
 *     never yields a specifier to resolve. NOTHING guards this one: it is stated and left, these
 *     being ESM client components (`grep -rn "require(" src` is empty, measured).
 *
 * All four are empty on this tree today, and 1–3 are empty BY ASSERTION rather than by belief.
 */
function resolveToTsx(fromFile: string, spec: string): string | null {
  const rel = resolveLocal(fromFile, spec);
  return rel !== null && rel.startsWith("src/") && rel.endsWith(".tsx") ? rel : null;
}

/** file -> the `src/**.tsx` files it value-imports. The whole `.tsx` tree, one pass. */
function tsxImportGraph(files: string[]): Map<string, Set<string>> {
  return new Map(files.map((file) => [
    file,
    new Set(valueModuleSpecifiers(readRepoFile(file), file)
      .map((spec) => resolveToTsx(file, spec))
      .filter((r): r is string => r !== null)),
  ]));
}

/**
 * The files that CONSUME a panel-mounting component — TRANSITIVELY, so a wrapper of a wrapper is a
 * panel page too. A fixpoint: seed with the mounts, then keep adding any file that value-imports
 * something already reached, until a round adds nothing.
 *
 * One level was enough for this tree (no consumer is itself imported: all six are Next route entry
 * points, which the router reaches by file convention rather than by an import edge) and the first
 * version of this walk shipped that way, with an assertion that said so the day it stopped being
 * true. The closure costs five lines and covers the case instead of reporting it — a check that
 * says "I do not cover this, but I will tell you when it matters" is the weaker of the two.
 *
 * It terminates because `reached` only ever grows and is bounded by the graph, so an import CYCLE
 * is fine (pinned below).
 */
function panelConsumers(graph: Map<string, Set<string>>, mounts: readonly string[]): string[] {
  const reached = new Set<string>(mounts);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, deps] of graph) {
      if (reached.has(file)) continue;
      if ([...deps].some((dep) => reached.has(dep))) { reached.add(file); grew = true; }
    }
  }
  const mounted = new Set(mounts);
  return [...reached].filter((file) => !mounted.has(file)).sort();
}

/**
 * WHAT COUNTS AS "ISSUES A MUTATING REQUEST" (design call 1, recorded here rather than improvised).
 *
 * Deliberately an OVER-match: the bare, word-bounded token, anywhere in the file — not
 * `method: "POST"` specifically. A precise regex is the failure mode being fixed one level up; a
 * mutation built from a variable (`method: del ? "DELETE" : "PUT"`), assembled in a helper defined
 * in the same file, or written in a shape nobody has invented yet still carries one of these four
 * words, and over-matching fails CLOSED — the file is called mutating and must wire the call.
 * The cost of over-matching is a false positive, and design call 2's allowlist is where a false
 * positive gets written down with a reason instead of quietly exempting the file.
 *
 * `PUT` inside `INPUT`/`OUTPUT` and `POST` inside `POSTED` are excluded by the word boundaries;
 * lowercase prose ("Delete", "post") never matches, which is why the match is case-sensitive.
 */
const MUTATING_TOKEN = /\b(?:POST|PUT|PATCH|DELETE)\b/;

/**
 * Every `method:` value in a file, as raw source text. Used by the loud guard below and by
 * `issuesMutatingRequest`.
 *
 * The optional quotes matter: `fetch(url, { "method": "POST" })` is a perfectly valid object key,
 * and the unquoted-only form missed it — so an allowlisted file could start writing that way and
 * `issuesMutatingRequest` would still call it read-only (Codex P2 on PR #187). `\bmethod\b` stays
 * case-sensitive and word-bounded, so `someMethod:` does not match.
 */
const METHOD_VALUE = /["']?\bmethod\b["']?\s*:\s*([^,}\n]+)/g;

/** The HTTP method literals this sweep knows how to classify. Anything else is a loud failure. */
const KNOWN_METHOD_LITERALS = new Set(
  ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].map((m) => `"${m}"`),
);

/**
 * Request transports whose mutations this sweep would NOT see: they carry no HTTP-method literal
 * at all. None is used anywhere in this codebase today (every client write goes through `api()`
 * or `fetch()` with a literal method), so their appearance in a panel-mounting file means the
 * detection above has gone blind and must be extended before the file can be judged.
 */
const OPAQUE_TRANSPORT = /\bsendBeacon\b|\bXMLHttpRequest\b|\bformAction\b|\buseActionState\b|\buseFormState\b|<form[^>]*\saction=/;

/**
 * A `method` the `method: <literal>` form cannot read: ES6 SHORTHAND in an object literal
 * (`fetch(url, { method })`) or a COMPUTED KEY (`init["method"]`). Either carries no
 * `POST|PUT|PATCH|DELETE` token and trips no other guard, so the file reads as non-mutating and
 * drops out of the census silently — the exact failure shape #158 is about (reviewer-caught).
 *
 * DELIBERATELY NARROW, unlike `MUTATING_TOKEN`. The first attempt was `\bmethod\b(?!\s*:)`, which
 * fired twice on one file: once on the word in a prose comment, once on `init.method ?? "GET"` — a
 * property READ, not a request shape. A guard whose failures are usually noise gets silenced, so
 * over-matching is the wrong trade HERE even though it is the right one for the token detector.
 *
 * The third arm is a dot-property ASSIGNMENT (`init.method = verb`, Codex P2 on PR #187): the verb
 * can come from an import and carry no uppercase literal at all, so nothing else here sees it. The
 * `(?!=)` is what separates it from the READ that made the first attempt noisy — `init.method ??
 * "GET"` and `init.method === x` are not assignments and must stay quiet.
 *
 * Still invisible, and not claimed otherwise: an init object arriving as a PROP, and a mutation
 * issued through an imported helper. Nothing static sees either.
 */
const OPAQUE_METHOD = /[{,]\s*method\s*[,}]|\[\s*["']method["']\s*\]|\.method\s*=(?!=)/;

/**
 * Does this file REALLY call `invalidateHistory()` — as CODE, not as text that spells one?
 *
 * The detector is `callsBareIdentifier` in `tests/helpers/ts-parse.ts`, shared with the
 * archival-gate sweep (#277); its docstring carries the #188 record of the three hand-rolled
 * comment strippers that were each wrong in a different direction, and of why a property access
 * (`x.invalidateHistory()`) and an uncalled reference deliberately do NOT count. This wrapper binds
 * the name, so the self-tests below — which are this repo's audit of that detector, not merely of
 * this sweep — go on exercising the shared implementation unchanged.
 */
export function callsInvalidate(src: string): boolean {
  return callsBareIdentifier(src, "invalidateHistory");
}

/**
 * Does this file issue a mutating REQUEST — as opposed to merely containing the word?
 *
 * `MUTATING_TOKEN` is deliberately broad and fails CLOSED: it screens which files must be wired or
 * allowlisted. But validating an allowlist ENTRY with that same broad token made the allowlist
 * self-defeating (Codex P2 on PR #187): a genuinely read-only page that renders `<code>POST</code>`
 * in prose is flagged as mutating, and then its allowlist entry is rejected for "mutating" — so the
 * false positive the allowlist is documented to absorb had no valid representation anywhere.
 *
 * The two checks want different precisions, which is the whole point: broad to decide "this needs a
 * decision", precise to decide "the decision recorded is honest".
 */
function issuesMutatingRequest(src: string): boolean {
  for (const [, value] of src.matchAll(METHOD_VALUE)) {
    if (/^"(?:POST|PUT|PATCH|DELETE)"$/.test(value.trim())) return true;
  }
  return OPAQUE_TRANSPORT.test(src) || OPAQUE_METHOD.test(src);
}

/**
 * The pure rule behind the allowlist check, lifted out so it can be exercised against synthetic
 * entries while the real allowlist is empty. An empty `Record` makes a `for…of` body unreachable,
 * and a test whose body never runs passes with zero assertions — which is the defect this whole
 * file exists to prevent, committed by the file itself.
 */
function allowlistProblems(
  entries: Record<string, string>, panelFiles: string[], read: (f: string) => string,
): string[] {
  const problems: string[] = [];
  for (const [file, reason] of Object.entries(entries)) {
    if (reason.trim().length <= 10) problems.push(`${file}: the reason is too short to be a reason`);
    if (!panelFiles.includes(file)) {
      problems.push(`${file}: not a panel page — remove the allowlist entry`);
      continue; // cannot read a mutation verdict off a file that is not in the census
    }
    if (issuesMutatingRequest(read(file))) problems.push(`${file}: mutates — remove the allowlist entry`);
  }
  return problems;
}

/**
 * Panel pages that issue NO mutating request (design call 2). An exclusion is an ENTRY WITH A
 * REASON, never a silent absence — a file that drops out of the census by being forgotten looks
 * identical to a file that is genuinely read-only, and the checks below refuse both an entry that
 * is not actually mutation-free and an entry naming a file outside the census.
 *
 * Every entry today is a CONSUMER folded in by #188 part 2, and they share one shape: a thin route
 * shell whose whole body is `<XDetail key={id} id={id} />`. That is not a coincidence — it is the
 * idiom this repo writes every keyed detail route in (the §5.12 remount lesson), and it is exactly
 * the shape that was invisible to the census while the comment above claimed no wrapper existed.
 * Add a mutating control to any of them and the entry stops being valid: the check below refuses
 * it, and the file has to wire `invalidateHistory()` like any other panel page.
 */
const NON_MUTATING_PANEL_PAGES: Record<string, string> = {
  "src/app/admin/reference/page.tsx":
    "Kind-picker shell around <ReferenceTable>; every reference write is issued inside the table, "
    + "which mounts the panel and wires the call itself.",
  "src/app/certs/[id]/page.tsx":
    "Thin keyed route shell around <CertDetail>; reads the id from the route and renders. All "
    + "cert writes and the panel wiring live in CertDetail.tsx.",
  "src/app/invoicing/[id]/page.tsx":
    "Thin keyed route shell around <InvoiceDetail>; reads the id from the route and renders. All "
    + "invoice writes and the panel wiring live in InvoiceDetail.tsx.",
  "src/app/quotes/[id]/page.tsx":
    "Thin keyed route shell around <QuoteDetail>; reads the id from the route and renders. All "
    + "quote writes and the panel wiring live in QuoteDetail.tsx.",
  "src/app/receivables/batches/[id]/page.tsx":
    "Thin keyed route shell around <BatchDetail>; reads the id from the route and renders. All "
    + "batch writes and the panel wiring live in BatchDetail.tsx.",
  "src/app/shipping/[id]/page.tsx":
    "Thin keyed route shell around <ShipmentDetail>; reads the id from the route and renders. All "
    + "shipment writes and the panel wiring live in ShipmentDetail.tsx.",
};

describe("#158 — a page with a panel that mutates must invalidate", () => {
  /**
   * WHY A SECOND SWEEP RATHER THAN A WIDER ONE (design call 3). `INVALIDATION_SITES` above is
   * keyed by registered CHILD entity and asserts exact key equality with the registry, so it
   * cannot grow parent keys; and its file check requires AT LEAST ONE named file, never all of
   * them. The two sit beside each other with this division:
   *
   *  - This sweep is complete over the PANEL PAGES — the files that mount a panel, plus (since
   *    #188 part 2) the files that render one of those. Both sets are derived from the tree, so
   *    there is no list to under-fill. It catches the parent-own gap (#158's title:
   *    a page whose panel entity has no registered children at all — `cert`, `shipper`, `quote`,
   *    `processTemplate`, `processStepCode`, the reference kinds — was invisible to the entity
   *    map entirely) and it catches a SECOND page writing an already-covered child entity, which
   *    the "at least one file" rule cannot see (`admin/surcharges/page.tsx` clearing a
   *    `customerSurcharge` was live and unwired, and the entity map was green throughout).
   *
   *  - The entity map catches what this one cannot: a file that mounts NO panel but writes a
   *    registered child of a panel mounted elsewhere — every `parts/[id]/*Section.tsx`, and
   *    `customers/[id]/SurchargeOverridesSection.tsx`. Nothing here looks at those files.
   *
   * WHAT NEITHER SWEEP PINS, stated plainly rather than papered over (the same statement the
   * entity-keyed describe above carries, and for the same reason): there is no DOM test
   * environment here, so nothing below proves the call sits on the SUCCESS path of the right
   * mutation, nor that a mounted panel actually refetches. The listener contract is pinned in
   * tests/history-invalidation.test.ts, and the panel subscribes through that same export. And
   * neither sweep can see a mutation issued by an imported helper that carries none of the tokens
   * below in the calling file — the `OPAQUE_TRANSPORT` guard covers the transports, not that.
   */

  const read = readRepoFile;
  const mountFiles = panelMountingFiles();
  const importGraph = tsxImportGraph(allTsxFiles());
  const consumerFiles = panelConsumers(importGraph, mountFiles);
  /** THE CENSUS: what mounts a panel, and what renders something that does. */
  const panelFiles = [...mountFiles, ...consumerFiles].sort();

  it("finds the panel-mounting files by walking the tree", () => {
    // A broken walk would answer an empty list and every check below would pass vacuously.
    expect(mountFiles.length).toBeGreaterThan(5);
    expect(mountFiles).toContain("src/app/parts/[id]/page.tsx"); // the wired precedent
    expect(mountFiles).toContain("src/components/ReferenceTable.tsx"); // a shared component, not a page
    // The census is the union, and nothing is in it twice.
    expect(panelFiles).toEqual([...new Set([...mountFiles, ...consumerFiles])].sort());
    expect(mountFiles.filter((f) => consumerFiles.includes(f))).toEqual([]);
  });

  it("sees a panel mount two independent ways, so neither can miss one silently", () => {
    // The MUTATION side of this sweep has two loud guards; the MOUNT side had none, and a page that
    // drops out of the census is exactly as invisible as an unwired one (reviewer-caught). The tag
    // regex misses an ALIASED IMPORT (`HistoryPanel as Panel`), which the import set still sees, so
    // asserting the two agree turns that silent miss into a named failure.
    //
    // This pair is about the MOUNT set only. It cannot see a CONSUMER — a file rendering a
    // component that mounts the panel — because neither the tag nor the import appears in the
    // consumer at all; that is the next test's job, and it was the second half of #188.
    const importers = allTsxFiles()
      .filter((file) => /^import\s*\{[^}]*\bHistoryPanel\b/m.test(read(file)))
      .sort();
    expect(importers).toEqual(mountFiles);
  });

  it("folds a panel component's CONSUMERS into the census, so a wrapper cannot hide one", () => {
    // #188 part 2. The comment this replaces said "No wrapper exists today — every one of the
    // twelve mounts the panel directly", and DEFERRED the import-graph walk on that premise. The
    // premise was false: SIX files render a panel-mounting component and were invisible to the
    // census, sitting in exactly the blind spot the comment described as hypothetical. Benign only
    // because all six are 13–25 line shells that issue no request — add one mutating control to
    // any of them and nothing would ever have required it to invalidate.
    //
    // The fix is deliberately the smallest correct one: a consumer is treated as a panel page, and
    // then EVERY existing rule applies to it unchanged — mutating means wire the call, non-mutating
    // means an allowlist entry with a reason.
    expect(consumerFiles).toEqual([
      "src/app/admin/reference/page.tsx",          // via the `@/` alias
      "src/app/certs/[id]/page.tsx",               // via a relative specifier
      "src/app/invoicing/[id]/page.tsx",
      "src/app/quotes/[id]/page.tsx",
      "src/app/receivables/batches/[id]/page.tsx",
      "src/app/shipping/[id]/page.tsx",
    ]);
    // Both resolution branches really resolved, against real files. A resolver that answered null
    // for everything would leave `consumerFiles` empty and every check over the census would go
    // back to being blind to exactly these six.
    expect(importGraph.get("src/app/admin/reference/page.tsx"))
      .toContain("src/components/ReferenceTable.tsx");
    expect(importGraph.get("src/app/certs/[id]/page.tsx"))
      .toContain("src/app/certs/[id]/CertDetail.tsx");
  });

  it("follows a consumer OF a consumer — the walk is a transitive closure, not one level", () => {
    // THE PROPERTY, pinned rather than believed. The first version of this walk went one level and
    // carried a tripwire saying "no consumer is itself imported today, and I will red when one
    // is". That was honest and it was weaker: covering the case beats reporting it. This tree
    // still answers the same six files either way (nothing imports a `page.tsx` — the router
    // reaches route entry points by file convention), so the closure has to be exercised on a
    // synthetic graph, exactly as the allowlist and the detector are.
    const chain = new Map<string, Set<string>>([
      ["src/x/Detail.tsx", new Set()],                       // mounts the panel
      ["src/x/page.tsx", new Set(["src/x/Detail.tsx"])],      // level 1 — the shipped walk saw this
      ["src/x/Wrapper.tsx", new Set(["src/x/page.tsx"])],     // level 2 — and dropped this
      ["src/x/Outer.tsx", new Set(["src/x/Wrapper.tsx"])],    // level 3
      ["src/x/Elsewhere.tsx", new Set(["src/lib/format.tsx"])], // reaches no panel at all
    ]);
    expect(panelConsumers(chain, ["src/x/Detail.tsx"])).toEqual([
      "src/x/Outer.tsx", "src/x/Wrapper.tsx", "src/x/page.tsx",
    ]);

    // A CYCLE must not hang the fixpoint, and must not invent a consumer out of nothing.
    const cyclic = new Map<string, Set<string>>([
      ["src/y/Detail.tsx", new Set()],
      ["src/y/a.tsx", new Set(["src/y/b.tsx"])],
      ["src/y/b.tsx", new Set(["src/y/a.tsx"])],
    ]);
    expect(panelConsumers(cyclic, ["src/y/Detail.tsx"]), "a cycle reaching nothing").toEqual([]);
    cyclic.set("src/y/a.tsx", new Set(["src/y/b.tsx", "src/y/Detail.tsx"]));
    expect(panelConsumers(cyclic, ["src/y/Detail.tsx"]), "a cycle reaching the panel")
      .toEqual(["src/y/a.tsx", "src/y/b.tsx"]);

    // A mount is never listed as its own consumer, however it is reached.
    expect(panelConsumers(chain, ["src/x/Detail.tsx", "src/x/page.tsx"]))
      .toEqual(["src/x/Outer.tsx", "src/x/Wrapper.tsx"]);
  });

  it("resolves every local import in the tree, so a new alias cannot go quiet", () => {
    // GUARD (a) for shapes 2 and 3 of `resolveToTsx`'s enumeration. An unresolvable specifier is
    // DROPPED, not reported, so a consumer would leave the census in silence — the failure mode
    // this whole sweep is about, committed by the sweep's own resolver.
    //
    // The alias assertion is what makes the resolution assertion complete: `isLocalSpecifier` calls
    // anything non-relative and non-`@/` a package and never asks where it lives, which is only
    // true while `@/` is the only path alias.
    const tsconfig = JSON.parse(readRepoFile("tsconfig.json")) as
      { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(Object.keys(tsconfig.compilerOptions?.paths ?? {}), "add the new alias to resolveLocal")
      .toEqual(["@/*"]);

    const unresolved: string[] = [];
    for (const file of [...allTsxFiles(), ...srcFiles(".ts")]) {
      for (const spec of valueModuleSpecifiers(read(file), file)) {
        if (!isLocalSpecifier(spec)) continue;               // a package, never a file in this tree
        if (resolveLocal(file, spec) === null) unresolved.push(`${file} → ${spec}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("has no `.ts` module forwarding a `.tsx`, the shape the graph genuinely cannot follow", () => {
    // GUARD (b) for shape 1 — the re-export barrel. Guard (a) does NOT catch it: `index.ts`
    // resolves perfectly well and is then dropped by the `.tsx` filter, so the edge from the
    // barrel's importer to the panel-mounting component disappears with nothing said. This is the
    // check that turns that into a named failure, and it is the reason the enumeration above can
    // claim all four shapes are empty here rather than merely asserting it.
    const forwards: string[] = [];
    for (const file of srcFiles(".ts")) {
      for (const spec of valueModuleSpecifiers(read(file), file)) {
        const target = resolveLocal(file, spec);
        if (target?.endsWith(".tsx")) {
          forwards.push(`${file} → ${target}: a .ts module carrying a .tsx; teach the graph about it`);
        }
      }
    }
    expect(forwards).toEqual([]);
  });

  it("understands every request shape in the panel pages", () => {
    // The loud half of design call 1. A `method:` this sweep cannot classify, or a transport that
    // carries no method at all, means the detector has gone blind — fail here rather than let the
    // census quietly shrink.
    const unclassified: string[] = [];
    for (const file of panelFiles) {
      const src = read(file);
      for (const [, value] of src.matchAll(METHOD_VALUE)) {
        if (!KNOWN_METHOD_LITERALS.has(value.trim())) unclassified.push(`${file}: method: ${value.trim()}`);
      }
      if (OPAQUE_TRANSPORT.test(src)) unclassified.push(`${file}: mutation transport with no HTTP method literal`);
      if (OPAQUE_METHOD.test(src)) unclassified.push(`${file}: a \`method\` this sweep cannot read (shorthand, computed key, or a prop)`);
    }
    expect(unclassified).toEqual([]);
  });

  it("every panel page that mutates imports and calls invalidateHistory", () => {
    const unwired: string[] = [];
    for (const file of panelFiles) {
      const src = read(file);
      if (Object.hasOwn(NON_MUTATING_PANEL_PAGES, file)) continue; // judged below, not here
      if (!MUTATING_TOKEN.test(src)) {
        // NOT a silent skip (Codex P2 on PR #187). The stated design is that a panel page which
        // genuinely does not mutate is an allowlist ENTRY WITH A REASON, never an absence — and the
        // first implementation just `continue`d, so a new read-only panel page would drop out of the
        // census with no review point, and could later start mutating through a shape the detector
        // does not see with nothing recorded. Non-mutating now MEANS allowlisted.
        unwired.push(`${file} mutates nothing — add a NON_MUTATING_PANEL_PAGES entry with a reason`);
        continue;
      }
      if (!/import \{[^}]*invalidateHistory[^}]*\} from "@\/components\/HistoryPanel"/.test(src)) {
        unwired.push(`${file} must import invalidateHistory`);
      } else if (!callsInvalidate(src)) {
        unwired.push(`${file} must call invalidateHistory()`);
      }
    }
    expect(unwired).toEqual([]);
  });

  it("every allowlisted page really is a panel page and really does not mutate", () => {
    // The allowlist cannot rot into a blanket exemption: an entry that starts mutating, or that
    // names a file no longer in the census, fails here. Every entry today is one of the six
    // consumers #188 part 2 folded in, so this now runs over real data as well as the synthetic
    // cases below — and it is the check that catches the day one of those shells grows a control.
    expect(allowlistProblems(NON_MUTATING_PANEL_PAGES, panelFiles, read)).toEqual([]);
  });

  it("...and that check is not vacuous, whatever the allowlist happens to hold", () => {
    // THE POINT OF THIS TEST, and it OUTLIVED the condition it was written for. It was added
    // (reviewer-caught, #158) because `NON_MUTATING_PANEL_PAGES` was `{}`, so the check above
    // iterated nothing and passed with ZERO assertions — vitest is not configured to reject that.
    // #188 part 2 populated the allowlist with six real entries, so the check above is no longer
    // vacuous and this test is no longer load-bearing for THAT reason.
    //
    // It stays anyway, and the reason is the general one: this exercises the RULE, not the current
    // data. Each of the three failure shapes below is a shape no real entry has — that is what
    // makes them worth pinning, and it is why emptying the allowlist again (perfectly possible: a
    // shell grows a control and gets wired instead) must not silently take the evidence with it.
    const stub = "src/app/parts/[id]/page.tsx";          // really mounts a panel, really mutates
    expect(allowlistProblems({ [stub]: "too short" }, panelFiles, read))
      .toContain(`${stub}: the reason is too short to be a reason`);
    expect(allowlistProblems({ [stub]: "a properly stated reason for the exclusion" }, panelFiles, read))
      .toContain(`${stub}: mutates — remove the allowlist entry`);
    expect(allowlistProblems(
      { "src/app/login/page.tsx": "a properly stated reason for the exclusion" }, panelFiles, read))
      .toContain("src/app/login/page.tsx: not a panel page — remove the allowlist entry");
    // And the shape that must PASS, or the three above would prove nothing — a VALID entry, not an
    // empty record. `allowlistProblems({})` iterates nothing and answers `[]` for the same reason
    // this test exists at all, so it demonstrated exactly nothing about a valid entry (reviewer-
    // caught, and in a test whose subject is claims matching assertions). A real census member that
    // issues no mutating request, with a reason long enough to be one, has to clear all three.
    const shell = "src/app/certs/[id]/page.tsx";  // a real consumer; every cert write is in CertDetail
    expect(allowlistProblems({ [shell]: "a properly stated reason for the exclusion" }, panelFiles, read))
      .toEqual([]);
  });

  it("lets a detector FALSE POSITIVE be allowlisted, which is what the allowlist is for", () => {
    // The contradiction this fixes (Codex P2 on PR #187): a read-only page rendering `POST` in
    // prose is flagged by the broad screen, and validating its allowlist entry with that SAME
    // broad token rejected it for "mutating" — so the case the allowlist exists to absorb could
    // not be written down at all. Broad to decide "needs a decision", precise to judge it.
    const prose = `<code>POST</code> and <code>DELETE</code> are shown here as documentation.`;
    expect(MUTATING_TOKEN.test(prose), "the broad screen still flags it").toBe(true);
    expect(issuesMutatingRequest(prose), "but it issues no request").toBe(false);
    expect(issuesMutatingRequest(`api("/x", { method: "POST" })`), "a real request").toBe(true);
    expect(issuesMutatingRequest(`api("/x", { method: "GET" })`), "a read").toBe(false);
    expect(issuesMutatingRequest(`fetch(url, { method })`), "an opaque shape").toBe(true);
    expect(issuesMutatingRequest(`fetch(url, { "method": "POST" })`), "a QUOTED key").toBe(true);
    expect(issuesMutatingRequest(`fetch(url, { 'method': 'GET' })`.replace(/'/g, '"')), "quoted read")
      .toBe(false);
    expect(issuesMutatingRequest(`const someMethod: string = "POST";`), "a lookalike key").toBe(false);
  });

  it("the mutation detector matches every shape it claims to, and no prose", () => {
    // The detector is the load-bearing part of the census, and today's allowlist is empty, so
    // these synthetic cases are the only place its behaviour is actually exercised.
    for (const src of [
      `api("/x", { method: "POST" })`,
      `api("/x", { method: "PUT", body })`,
      `fetch("/x", { method: "PATCH" })`,
      `api("/x", { method: "DELETE" })`,
      `const method = hard ? "DELETE" : "PUT"; fetch("/x", { method })`, // built from a variable
      `const init: RequestInit = { method: "POST" }; fetch("/x", init)`, // init hoisted out
    ]) expect(MUTATING_TOKEN.test(src), src).toBe(true);

    for (const src of [
      `api("/x")`,
      `<button>Delete</button>`,
      `<input value={x} />`, // INPUT must not read as PUT
      `const output = post(x);`,
      `// posted, deleted, patched`,
    ]) expect(MUTATING_TOKEN.test(src), src).toBe(false);

    expect(OPAQUE_TRANSPORT.test(`navigator.sendBeacon("/x", b)`)).toBe(true);
    expect(OPAQUE_TRANSPORT.test(`<form action={save}>`)).toBe(true);
    expect(OPAQUE_TRANSPORT.test(`<form onSubmit={submit}>`)).toBe(false);

    // The narrowed method guard: the two shapes that hide a mutation, and the two that are noise.
    expect(OPAQUE_METHOD.test(`fetch(url, { method })`), "shorthand").toBe(true);
    expect(OPAQUE_METHOD.test(`fetch(url, { method, body })`), "shorthand, then more").toBe(true);
    expect(OPAQUE_METHOD.test(`fetch(url, { body, method })`), "shorthand, trailing").toBe(true);
    expect(OPAQUE_METHOD.test(`init["method"] = verb`), "computed key").toBe(true);
    expect(OPAQUE_METHOD.test(`api(url, { method: "PUT" })`), "the readable form").toBe(false);
    expect(OPAQUE_METHOD.test(`const key = init.method ?? "GET";`), "a property READ").toBe(false);
    expect(OPAQUE_METHOD.test(`// keyed by path+method`), "prose").toBe(false);
    expect(OPAQUE_METHOD.test(`init.method = verb;`), "dot assignment").toBe(true);
    expect(OPAQUE_METHOD.test(`if (init.method === "GET") return;`), "a comparison, not an assignment")
      .toBe(false);
  });

  it("sees a real invalidateHistory call, and no comment that merely mentions one", () => {
    // THE REGRESSION RECORD (#188). These seven cases predate the parser and are kept verbatim:
    // they are the shapes two hand-rolled comment strippers got wrong, and they must keep passing
    // whatever the detector is built from. The parser removes the ORDERING trap as a mechanism —
    // there is no strip order any more — but the evidence that these shapes are answered correctly
    // is the point, not the mechanism that answers them.
    expect(callsInvalidate(`await save(); invalidateHistory();`), "a real call").toBe(true);
    expect(callsInvalidate(`// invalidateHistory();`), "line comment").toBe(false);
    expect(callsInvalidate(`/* invalidateHistory(); */`), "block comment").toBe(false);
    expect(callsInvalidate(`/** calls invalidateHistory() on the success path */`), "a docblock")
      .toBe(false);
    expect(callsInvalidate(`/**\n * calls invalidateHistory() here\n */\nconst x = 1;`), "multi-line")
      .toBe(false);
    // The trap: a `/*` INSIDE a line comment must not open a block that eats the real call below.
    expect(callsInvalidate(`// see /* the note\ninvalidateHistory();`), "slash-star in a line comment")
      .toBe(true);
    // ...and a real call must survive a docblock that also mentions it.
    expect(callsInvalidate(`/** calls invalidateHistory() */\ninvalidateHistory();`), "both")
      .toBe(true);
  });

  it("tells a call from TEXT that spells one — strings, templates, JSX, a regex", () => {
    // #188's headline defect: the string literal that read as a call. The regex detector stripped
    // comments and tested the remainder, so ANY text surviving that strip counted — and a literal
    // is text the strip never touched. A file could lose its only real call, keep a `const hint =
    // "invalidateHistory()"`, and both sweeps stayed green while the mounted panel went stale.
    expect(callsInvalidate(`const hint = "invalidateHistory()";`), "a string literal").toBe(false);
    expect(callsInvalidate(`const hint = 'invalidateHistory()';`), "a single-quoted string")
      .toBe(false);
    expect(callsInvalidate(`const hint = \`invalidateHistory()\`;`), "a template literal").toBe(false);
    expect(callsInvalidate(`const el = <p>invalidateHistory()</p>;`), "JSX text").toBe(false);
    expect(callsInvalidate(`const re = /invalidateHistory()/;`), "a regex literal").toBe(false);

    // ...and the other direction: a template SUBSTITUTION is code, not text, so the call in it is
    // real. Nothing textual can draw that line; the parser draws it for free.
    expect(callsInvalidate(`const s = \`\${invalidateHistory()}\`;`), "a template substitution")
      .toBe(true);
  });

  it("counts the imported BINDING called as a function, and nothing else named alike", () => {
    // DESIGN CALL (#188): `x.invalidateHistory()` does NOT count, and neither does a bare
    // reference that is never called.
    //
    // The sweep above separately asserts the file carries
    // `import { … invalidateHistory … } from "@/components/HistoryPanel"` — a NAMED import, whose
    // binding is used as a bare identifier. A property access is therefore some OTHER function
    // that happens to share the name: a prop, a mock, a namespace object from an import shape the
    // paired assertion already rejects. Counting it would let an unrelated method satisfy the
    // census, which is the same fail-OPEN shape as the string literal.
    //
    // Both exclusions fail CLOSED — a file wired only that way is reported as unwired, loudly, at
    // a review point — which is the safe direction for a guard and the direction the regex
    // detector already took (it required the `()` too). If a wrapper object or a passed-callback
    // shape ever becomes the real idiom, this is the line to revisit, deliberately.
    expect(callsInvalidate(`x.invalidateHistory();`), "a property call").toBe(false);
    expect(callsInvalidate(`this.invalidateHistory();`), "a method call").toBe(false);
    expect(callsInvalidate(`H.invalidateHistory();`), "a namespace-import call").toBe(false);
    expect(callsInvalidate(`onSaved={invalidateHistory}`), "a reference, never called").toBe(false);

    // The shapes that DO count: the plain call anywhere in the tree, and the optional call.
    expect(callsInvalidate(`<button onClick={() => save().then(() => invalidateHistory())} />`),
      "nested deep inside a handler").toBe(true);
    expect(callsInvalidate(`invalidateHistory?.();`), "an optional call").toBe(true);
  });

  it("is not fooled by punctuation inside a string, which the strip-and-test detector was", () => {
    // Two live FALSE NEGATIVES in the regex detector, kept as cases because they are the other
    // half of #188: a guard that reports a correctly wired file as broken teaches people to work
    // around it, and the workaround is an allowlist entry that then hides a real one.
    //
    // `//` inside a string ended the line for the line-comment strip, taking the real call with it.
    expect(callsInvalidate(`const url = "https://x"; invalidateHistory();`), "a URL, then the call")
      .toBe(true);
    // `/*` inside a string opened a block that ran to the next real `*/`, eating the call between.
    expect(callsInvalidate(`const a = "/*"; invalidateHistory(); /* note */`), "slash-star in a string")
      .toBe(true);
  });

  it("counts a VALUE import as an edge and a type-only import as none", () => {
    // The load-bearing half of the consumer walk (#188 part 2), exercised as a pure rule the way
    // the allowlist and the detector are — the real graph is one snapshot of this tree, and these
    // are the shapes it has to keep answering.
    //
    // MEASURED, not reasoned: a graph that counts type edges answers SIXTEEN consumers here, not
    // six. The ten extras are `orders/[id]/*Section.tsx`, `parts/[id]/IdentitySection.tsx`,
    // `certs/[id]/RequirementBlock.tsx` and `shipping/[id]/ShipmentOrderPanel.tsx`, every one of
    // which does `import type { … } from` its own panel-mounting PARENT. That edge points the
    // wrong way — those are child sections, and folding them in would have demanded an allowlist
    // entry per section for a wrapper relationship that does not exist.
    expect(valueModuleSpecifiers(`import { CertDetail } from "./CertDetail";`)).toEqual(["./CertDetail"]);
    expect(valueModuleSpecifiers(`import Detail from "./CertDetail";`)).toEqual(["./CertDetail"]);
    expect(valueModuleSpecifiers(`import * as D from "./CertDetail";`)).toEqual(["./CertDetail"]);
    expect(valueModuleSpecifiers(`import "./side-effect";`)).toEqual(["./side-effect"]);
    expect(valueModuleSpecifiers(`export { X } from "./X";`)).toEqual(["./X"]);
    expect(valueModuleSpecifiers(`const D = await import("./D");`)).toEqual(["./D"]);
    // `import { type A, B }` still brings B, so the module is still a value dependency.
    expect(valueModuleSpecifiers(`import { type A, B } from "./x";`)).toEqual(["./x"]);

    expect(valueModuleSpecifiers(`import type { OrderLine } from "./page";`), "type-only").toEqual([]);
    expect(valueModuleSpecifiers(`import { type A } from "./x";`), "all specifiers type-only").toEqual([]);
    expect(valueModuleSpecifiers(`export type { X } from "./X";`), "a type re-export").toEqual([]);
    // And the #188 lesson once more, free from the parser: a path-shaped STRING is not an import.
    expect(valueModuleSpecifiers(`const p = "./CertDetail";`), "a string that looks like one")
      .toEqual([]);

    // The SCRIPT KIND, which starts mattering the moment a `.ts` file is asked about (the barrel
    // guard asks about 369 of them). A generic arrow is an unclosed JSX element to a TSX parse, and
    // it swallows every import BELOW it — the specifier list comes back empty and the guard goes
    // quiet. Reading the kind off the filename is what makes these two answers differ.
    const generic = `const id = <T>(x: T) => x;\nimport { a } from "./a";\nimport { b } from "./b";\n`;
    expect(valueModuleSpecifiers(generic, "src/lib/x.ts"), "a .ts generic arrow above its imports")
      .toEqual(["./a", "./b"]);
    expect(valueModuleSpecifiers(generic, "src/lib/x.tsx"), "the same text read as TSX").toEqual([]);
  });
});

describe("#153 — the part panel sees every child section", () => {
  beforeEach(truncateAll);

  it("an edit in each of the part's seven sections lands in the part's history", async () => {
    const { partId } = await partFixture();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const code = await prisma.inspectionCode.create({ data: { name: "Hardness" } });
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const field = await asSystem(() => createPartFieldDef({ name: "Drawing #", type: "TEXT", sort: 0 }));

    const specLink = await asSystem(() => addPartSpec(partId, spec.id));
    const insp = await asSystem(() => addPartInspection(partId, { inspectionCodeId: code.id, sort: 0 }));
    const price = await asSystem(() => addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1.5 }));
    const brk = await asSystem(() => addPriceBreak(partId, price.id, { threshold: 100, price: 1.25 }));
    await asSystem(() => setPartFieldValues(partId, [{ fieldId: field.id, value: "DWG-100" }]));
    const att = await asSystem(() =>
      addAttachment("part", partId, { filename: "n.txt", mimeType: "text/plain", data: Buffer.from("hi") }));
    await asSystem(() => addStep(partId, { codeId: stepCode.id }));

    const { rows, hasMore } = await readAuditWithChildren("part", partId);
    expect(hasMore).toBe(false);
    const byEntity = new Map(rows.map((r) => [r.entity, r.entityId]));

    // Every section the parts page renders — none of which had ever appeared here.
    expect(byEntity.get("part")).toBe(partId);
    expect(byEntity.get("partSpecification")).toBe(specLink.id);
    expect(byEntity.get("partInspection")).toBe(insp.id);
    expect(byEntity.get("partPrice")).toBe(price.id);
    expect(byEntity.get("partPriceBreak")).toBe(brk.id);
    expect(byEntity.get("partAttachment")).toBe(att.id);
    expect(byEntity.has("partFieldValue")).toBe(true);
    expect(byEntity.has("partProcessRevision")).toBe(true);

    // Every foreign row can be named by the same registry the read walked.
    for (const row of rows) {
      if (row.entity === "part") continue;
      expect(auditChildLabel("part", row.entity), row.entity).toBeTruthy();
    }
  });

  it("orders newest-first ACROSS the union, not parent rows then child rows", async () => {
    const { partId } = await partFixture();
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });

    const price = await asSystem(() => addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));
    await asSystem(() => updatePart(partId, { name: "Housing" }));
    const specLink = await asSystem(() => addPartSpec(partId, spec.id));

    expect(await unionPairs("part", partId)).toEqual([
      ["partSpecification", specLink.id],
      ["part", partId],
      ["partPrice", price.id],
      ["part", partId], // the part's own create, oldest
    ]);
  });

  it("keeps a soft-deleted child's DELETE row — the row the panel most needs", async () => {
    const { partId } = await partFixture();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const { id: linkId } = await asSystem(() => addPartSpec(partId, spec.id));
    await asSystem(() => removePartSpec(partId, linkId));
    expect((await prisma.partSpecification.findUnique({ where: { id: linkId } }))!.deletedAt).not.toBeNull();

    const { rows } = await readAuditWithChildren("part", partId);
    // Asserted on the DELETE ROW specifically, never on a count: a `deletedAt: null` filter in
    // the id walk still finds the row's earlier CREATE entry through the live parent, so a count
    // assertion would pass while the deletion — the whole point — stayed invisible.
    const del = rows.find((r) => r.entity === "partSpecification" && r.action === "delete");
    expect(del).toBeDefined();
    expect(del!.entityId).toBe(linkId);
  });

  it("resolves a break through its price row, including a price soft-deleted since", async () => {
    const { partId } = await partFixture();
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const price = await asSystem(() => addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));
    const brk = await asSystem(() => addPriceBreak(partId, price.id, { threshold: 100, price: 0.9 }));

    // Live-parent arm.
    expect((await unionPairs("part", partId)))
      .toContainEqual(["partPriceBreak", brk.id]);

    // Deleting the priced operation deletes the whole section from the live UI. Its history must
    // not go with it: the break's own entries reach the part only through a row that is now
    // soft-deleted, so an intermediate `deletedAt: null` filter would erase them here.
    await asSystem(() => deletePartPrice(partId, price.id));
    expect((await prisma.partPrice.findUnique({ where: { id: price.id } }))!.deletedAt).not.toBeNull();

    const { rows } = await readAuditWithChildren("part", partId);
    expect(rows.filter((r) => r.entity === "partPriceBreak").map((r) => r.entityId)).toContain(brk.id);
    const priceDelete = rows.find((r) => r.entity === "partPrice" && r.action === "delete");
    expect(priceDelete?.entityId).toBe(price.id);
  });

  it("keeps a break's own delete row after its price row is deleted too", async () => {
    const { partId } = await partFixture();
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const price = await asSystem(() => addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));
    const brk = await asSystem(() => addPriceBreak(partId, price.id, { threshold: 100, price: 0.9 }));
    await asSystem(() => deletePriceBreak(partId, price.id, brk.id));
    await asSystem(() => deletePartPrice(partId, price.id));

    const { rows } = await readAuditWithChildren("part", partId);
    const del = rows.find((r) => r.entity === "partPriceBreak" && r.action === "delete");
    expect(del?.entityId).toBe(brk.id);
  });

  it("never shows part A's child rows under part B", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const a = await asSystem(() => createPart({ customerId: customer.id, partNumber: "A-1", eachWeight: 1 }));
    const b = await asSystem(() => createPart({ customerId: customer.id, partNumber: "B-1", eachWeight: 1 }));
    const priceA = await asSystem(() => addPartPrice(a.id, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));
    const breakA = await asSystem(() => addPriceBreak(a.id, priceA.id, { threshold: 50, price: 0.8 }));

    const underB = await readAuditWithChildren("part", b.id);
    expect(underB.rows.map((r) => r.entityId)).not.toContain(priceA.id);
    expect(underB.rows.map((r) => r.entityId)).not.toContain(breakA.id);
    expect(underB.rows.every((r) => r.entity === "part" && r.entityId === b.id)).toBe(true);

    const underA = await readAuditWithChildren("part", a.id);
    expect(underA.rows.map((r) => r.entityId)).toContain(breakA.id);
  });
});

describe("#153 — the customer panel sees every child section", () => {
  beforeEach(truncateAll);

  it("addresses, contacts, surcharge overrides and template assignments all land", async () => {
    const { id: customerId } = await asSystem(() => createCustomer({ code: "ACME", name: "Acme" }));
    const addr = await asSystem(() => addAddress(customerId, { kind: "SHIP_TO", name: "Dock 1" }));
    const contact = await asSystem(() => addContact(customerId, { name: "Dana" }));
    const sur = await asSystem(() => createSurcharge({ name: "Energy", kind: "PERCENT", rate: 0.05, position: 0 }));
    await asSystem(() => setCustomerSurcharge(customerId, sur.id, { optOut: true }));
    const template = await prisma.documentTemplate.findFirst({ where: { docType: "TRAVELER" } });
    const assignment = await asSystem(() => assignTemplate(customerId, "TRAVELER", template!.id));

    const { rows } = await readAuditWithChildren("customer", customerId);
    const ids = rows.map((r) => r.entityId);
    expect(ids).toContain(customerId);
    expect(ids).toContain(addr.id);
    expect(ids).toContain(contact.id);
    expect(ids).toContain(assignment.id);
    expect(rows.some((r) => r.entity === "customerSurcharge")).toBe(true);
    for (const row of rows) {
      if (row.entity === "customer") continue;
      expect(auditChildLabel("customer", row.entity), row.entity).toBeTruthy();
    }
  });

  it("keeps a deleted address's DELETE row and scopes to the right customer", async () => {
    const x = await asSystem(() => createCustomer({ code: "X", name: "X Co" }));
    const y = await asSystem(() => createCustomer({ code: "Y", name: "Y Co" }));
    const addr = await asSystem(() => addAddress(x.id, { kind: "SHIP_TO", name: "Dock 1" }));
    await asSystem(() => deleteAddress(x.id, addr.id));
    await asSystem(() => updateCustomer(y.id, { name: "Y Company" }));

    const underX = await readAuditWithChildren("customer", x.id);
    const del = underX.rows.find((r) => r.entity === "customerAddress" && r.action === "delete");
    expect(del?.entityId).toBe(addr.id);

    const underY = await readAuditWithChildren("customer", y.id);
    expect(underY.rows.map((r) => r.entityId)).not.toContain(addr.id);
  });
});

describe("#153 — the receipt batch panel reaches its payments and their applications", () => {
  beforeEach(truncateAll);

  /** The one two-hop chain with no behavioural coverage until review round 1: an application
   *  reaches the batch only THROUGH its payment. The hop sweep above proves the pair compiles;
   *  this proves the chain actually resolves with rows at both levels. */
  it("an application resolves to the batch through its payment", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const type = await prisma.paymentType.create({ data: { name: "Check" } });
    const order = await prisma.order.create({
      data: {
        orderNumber: 2001, customerId: customer.id,
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-10"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: { orderId: order.id, customerId: customer.id, invoiceDate: new Date("2026-08-01") },
    });
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 501, depositDate: new Date("2026-08-03") },
    });
    const payment = await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: customer.id, paymentTypeId: type.id,
        amount: 100, receivedDate: new Date("2026-08-03"),
      },
    });
    const app = await prisma.application.create({
      data: {
        invoiceId: invoice.id, paymentId: payment.id, amount: 100, type: "PAYMENT",
        appliedDate: new Date("2026-08-03"),
      },
    });
    await prisma.$transaction(async (tx) => {
      await auditedUpdate("payment", payment.id, () =>
        tx.payment.update({ where: { id: payment.id }, data: { notes: "posted" } }), { tx });
      await auditedUpdate("application", app.id, () =>
        tx.application.update({ where: { id: app.id }, data: { reason: "applied" } }), { tx });
    });

    const { rows } = await readAuditWithChildren("receiptBatch", batch.id);
    expect(rows.filter((r) => r.entity === "payment").map((r) => r.entityId)).toEqual([payment.id]);
    expect(rows.filter((r) => r.entity === "application").map((r) => r.entityId)).toEqual([app.id]);
    expect(auditChildLabel("receiptBatch", "payment")).toBe("Payment");
    expect(auditChildLabel("receiptBatch", "application")).toBe("Application");

    // Scoped: a second batch sees neither.
    const other = await prisma.receiptBatch.create({
      data: { batchNumber: 502, depositDate: new Date("2026-08-04") },
    });
    const underOther = await readAuditWithChildren("receiptBatch", other.id);
    expect(underOther.rows).toEqual([]);
  });
});

describe("#153 — a child reachable by two FKs is listed once", () => {
  beforeEach(truncateAll);

  async function invoicePair() {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const order = await prisma.order.create({
      data: {
        orderNumber: 1001, customerId: customer.id,
        receivedDate: new Date("2026-08-01"), requestDate: new Date("2026-08-10"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: { orderId: order.id, customerId: customer.id, invoiceDate: new Date("2026-08-01") },
    });
    const credit = await prisma.invoice.create({
      data: {
        kind: "CREDIT", orderId: order.id, customerId: customer.id,
        invoiceDate: new Date("2026-08-02"), creditNumber: 9001,
      },
    });
    return { invoice, credit };
  }

  /** One audited edit against an application, so a duplicated union path shows as two rows. */
  async function auditOnce(id: string, reason: string) {
    await prisma.$transaction((tx) =>
      auditedUpdate("application", id, () =>
        tx.application.update({ where: { id }, data: { reason } }), { tx }));
  }

  it("reaches an application from BOTH ends of a credit application, once from each", async () => {
    const { invoice, credit } = await invoicePair();
    // The ordinary shape: credit C spent against invoice I. It is a child section of BOTH — of I
    // as the cash-equivalent that reduced it, of C as where C went — and each FK is one path.
    const app = await prisma.application.create({
      data: {
        invoiceId: invoice.id, creditInvoiceId: credit.id, amount: 10, type: "CREDIT",
        appliedDate: new Date("2026-08-03"),
      },
    });
    await auditOnce(app.id, "applied");

    for (const parent of [invoice.id, credit.id]) {
      const { rows } = await readAuditWithChildren("invoice", parent);
      const appRows = rows.filter((r) => r.entity === "application");
      expect(appRows.map((r) => r.entityId)).toEqual([app.id]);
    }
    expect(auditChildLabel("invoice", "application")).toBe("Application");
  });

  it("lists an application reachable under ONE invoice by both FKs exactly once", async () => {
    const { credit } = await invoicePair();
    // Both FKs pointing at the same invoice is the only shape that makes the dedupe observable:
    // two registry paths resolve the same child id, and a naive concatenation would list every
    // one of its audit rows twice. Written directly, deliberately — the service layer has no
    // reason to produce this, but the READ must not double-count whatever it finds.
    const app = await prisma.application.create({
      data: {
        invoiceId: credit.id, creditInvoiceId: credit.id, amount: 10, type: "CREDIT",
        appliedDate: new Date("2026-08-03"),
      },
    });
    await auditOnce(app.id, "first");
    await auditOnce(app.id, "second");

    const { rows } = await readAuditWithChildren("invoice", credit.id);
    const appRows = rows.filter((r) => r.entity === "application");
    expect(appRows).toHaveLength(2);
    expect(new Set(appRows.map((r) => r.id)).size).toBe(appRows.length); // no duplicated audit row
    // Honest about what this pins: the PRIMARY guarantee is the SQL shape — one `findMany` with
    // an `OR` of `entityId: { in: [...] }` cannot return a row twice — so this passes with or
    // without the id `Set` in `readAuditWithChildren`. The `Set` is belt (it also keeps the `IN`
    // list from doubling), and the contract "a child reachable twice is listed once" is worth
    // pinning against a future rewrite that resolves each path as its own query and concatenates.
  });

  it("does not pull one invoice's applications under another", async () => {
    const { invoice, credit } = await invoicePair();
    const app = await prisma.application.create({
      data: {
        invoiceId: credit.id, creditInvoiceId: credit.id, amount: 10, type: "CREDIT",
        appliedDate: new Date("2026-08-03"),
      },
    });
    await auditOnce(app.id, "only the credit's");

    const underInvoice = await readAuditWithChildren("invoice", invoice.id);
    expect(underInvoice.rows.map((r) => r.entityId)).not.toContain(app.id);
  });
});

describe("#153 — the cap is stated, never silent", () => {
  beforeEach(truncateAll);

  it("caps at the limit and reports hasMore", async () => {
    const { partId } = await partFixture();
    // One parent create entry + four child entries = five rows.
    for (let i = 0; i < 4; i++) {
      const step = await prisma.processStepCode.create({ data: { code: `S${i}`, name: `Step ${i}` } });
      await asSystem(() => addPartPrice(partId, { processStepCodeId: step.id, position: i, unitPrice: 1 }));
    }

    const capped = await readAuditWithChildren("part", partId, 3);
    expect(capped.rows).toHaveLength(3);
    expect(capped.hasMore).toBe(true);

    const exact = await readAuditWithChildren("part", partId, 5);
    expect(exact.rows).toHaveLength(5);
    expect(exact.hasMore).toBe(false);

    const roomy = await readAuditWithChildren("part", partId, 50);
    expect(roomy.rows).toHaveLength(5);
    expect(roomy.hasMore).toBe(false);
  });

  it("defaults to the panel limit", () => {
    expect(AUDIT_PANEL_LIMIT).toBe(200);
  });
});

describe("#153 — readAudit stays the exact-match primitive", () => {
  beforeEach(truncateAll);

  it("readAudit is unchanged: parent rows only, no envelope", async () => {
    const { partId } = await partFixture();
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    await asSystem(() => addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));

    const exact = await readAudit("part", partId);
    expect(Array.isArray(exact)).toBe(true);
    expect(exact.every((r) => r.entity === "part" && r.entityId === partId)).toBe(true);
    expect(exact).toHaveLength(1);
    // 40+ call sites pin this shape; the union is a separate function precisely so they don't move.
    expect((await readAuditWithChildren("part", partId)).rows.length).toBeGreaterThan(exact.length);
  });
});

describe("#153 — the audit route returns the envelope", () => {
  beforeEach(truncateAll);

  const ctx = { params: Promise.resolve({}) };
  const get = (url: string, cookie: string) => new Request(url, { headers: { cookie } });

  it("exact-match reads answer { rows, hasMore } including child sections", async () => {
    const cookie = await signInWith(["admin.view"]);
    const { partId } = await partFixture();
    const stepCode = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const price = await asSystem(() =>
      addPartPrice(partId, { processStepCodeId: stepCode.id, position: 0, unitPrice: 1 }));

    const res = await auditGet(get(`http://t/api/admin/audit?entity=part&entityId=${partId}`, cookie), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.rows.map((r: { entityId: string }) => r.entityId)).toContain(price.id);
  });

  it("a prototype key answers empty rather than crashing", async () => {
    const cookie = await signInWith(["admin.view"]);
    const res = await auditGet(get("http://t/api/admin/audit?entity=__proto__&entityId=x", cookie), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], hasMore: false });
  });

  it("the search branch still answers a bare array", async () => {
    const cookie = await signInWith(["admin.view"]);
    const res = await auditGet(get("http://t/api/admin/audit?entity=part", cookie), ctx);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
