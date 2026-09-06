import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { callsBareIdentifier, isLocalSpecifier, resolveLocalModule } from "./helpers/ts-parse";

// THE CENSUS BEHIND THE ARCHIVAL/REPLACE RULE (#277).
//
// CLAUDE.md carries the rule — "a control that ARCHIVES paper or REPLACES server rows must consult
// `useUnsavedPresent()` and REFUSE while an editor is dirty" — and then admits, in the same
// paragraph, that the list of such controls "was assembled one review round at a time and is a
// census by hand, not by test". Four successive review rounds each found another path, which is the
// signature of an incomplete enumeration rather than a converging one, and a hand list cannot report
// the entry nobody remembered: a control that drops out of it looks exactly like a control that was
// never dangerous.
//
// This sweep replaces the list. It derives the dangerous SERVER entry points from the code, walks
// them out to the API routes that expose them, joins those routes to the CLIENT call sites through
// the only thing that actually connects the two halves — the URL string — and requires every
// resulting (file, route) pair to carry a verdict: a named gate this file proves, or a written
// exemption. Nothing may be absent.
//
// TWO HALVES, AND THEY ARE NOT EQUALLY MECHANICAL. Saying so plainly is the point:
//
//   ARCHIVES PAPER is fully derived. `storeDocument` (src/server/documents.ts) is the only writer of
//   a `StoredDocument` row anywhere in `src/`, and this file ASSERTS that rather than believing it —
//   so "does this route file permanent paper" reduces to "does its handler reach that function",
//   which a call graph answers exactly.
//
//   REPLACES SERVER ROWS is NOT derivable, and no signal was found that comes close. The write that
//   destroys an overlay looks identical to the write that SAVES one: `replaceInvoiceLines` and
//   `recalculateInvoice` are the same delete-then-create on the same model, and only one is a
//   hazard. The discriminator is whether the operator's own click IS that write — a fact about the
//   UI, not about the query. So hazards are SEEDED by hand (`REPLACE_SEEDS`) and pushed through the
//   identical machinery, and what stops the seeds rotting is `REPLACE_CANDIDATES` below: every
//   function in `src/server` that destroys rows wholesale must be classified, WITH the routes that
//   reach it, so neither a new destroyer nor a new caller of an old one can arrive in silence.
//
// THE RESIDUALS, stated rather than implied away:
//
//   1. A destroyer that issues no request is invisible here, because the subject of this sweep is a
//      REQUEST. The receivables apply-panel collapse and the new-shipment customer switch are both
//      correctly gated today and neither could ever be seen from a URL; nothing static can watch a
//      `setState` unmount a child holding a draft. That pair stays prose, in use-unsaved-section.ts.
//   2. A `confirmDiscard()` verdict is proved only at FILE scope — the call sits in a JSX handler,
//      not in the function that issues the request, and pairing the two would need a renderer. A
//      `useUnsavedPresent` verdict IS proved per control, by the taint below, which is why the two
//      claim shapes are kept apart instead of being folded into "the file calls something".
//   3. A replace expressed as a status or flag FLIP rather than a delete — `reverseShipper` un-ships
//      by clearing `lineComplete` — produces no candidate. It is seeded by hand and says so.
//
// Doctrine cloned from `tests/audit-children.test.ts` and `tests/unsaved-registration-sweep.test.ts`:
// parse rather than pattern-match, match the CALL and not the import (#188), over-match so a
// detector fails CLOSED, assert a non-vacuous floor so a bad glob cannot pass silently, and exercise
// every rule against sources written to break it.

/** `erp/`. From `import.meta.url` rather than `process.cwd()` — the package is `"type": "module"`,
 *  and this is the idiom the other repo-path tests here already use. */
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SRC = join(ROOT, "src");

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** Every source under `src/` with this extension, root-relative and slash-separated. One
 *  enumeration, so the server graph and the client scan cannot be looking at different trees. */
function srcFiles(ext: ".ts" | ".tsx"): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(ext))
    .map((rel) => `src/${rel.split(sep).join("/")}`)
    .sort();
}

const parseSource = (file: string, src = read(file)): ts.SourceFile =>
  ts.createSourceFile(
    file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

// ---------------------------------------------------------------------------------------------
// THE SERVER CALL GRAPH — which routes reach a dangerous function
// ---------------------------------------------------------------------------------------------

/** A function addressed across the tree: `"src/server/traveler.ts#printTraveler"`. */
type FnKey = string;
const fnKey = (file: string, name: string): FnKey => `${file}#${name}`;

type ModuleFacts = {
  /** local binding name -> the function it names elsewhere. `import * as X` records `X#*`. */
  imports: Map<string, FnKey>;
  /** `export { a } from "./b"` — this module's `a` IS `./b`'s `a`, with no declaration of its own.
   *  A missed re-export is fail-OPEN, and this is not hypothetical: `src/server/orders.ts` is a
   *  barrel forwarding `createOrder`, `listOrders` and more from four sibling modules. */
  reexports: Map<string, FnKey>;
  /** top-level declaration name -> every identifier reached from inside it. */
  calls: Map<string, Set<string>>;
  /** local specifiers that resolved to nothing — asserted empty, since each is a lost edge. */
  unresolved: string[];
};

/**
 * Everything the graph needs from one module, in a single parse.
 *
 * DECLARATIONS ARE READ AT TOP LEVEL ONLY, and every call in the subtree beneath one is attributed
 * to it. That is what makes `export const POST = handle(async (req) => …)` work — the callees sit
 * two closures deep inside a higher-order wrapper, and a rule that read only the initializer's head
 * would see `handle` and stop. It also means a nested `const doc = await storeDocument(…)` is
 * attributed to its enclosing function rather than becoming a phantom function named `doc`.
 *
 * AN IDENTIFIER PASSED AS AN ARGUMENT COUNTS AS A CALL. `handle(printCert)` is point-free: the
 * dangerous function is never syntactically called, so a callee-only rule loses the edge and the
 * route silently stops being archival. Counting arguments over-matches — a callback that is never
 * invoked reads as reached — and over-matching marks MORE routes dangerous, which is the closed
 * direction. Measured on this tree it changes nothing: the archival route set is the same eight
 * either way.
 */
function moduleFacts(file: string, src = read(file)): ModuleFacts {
  const sf = parseSource(file, src);
  const facts: ModuleFacts = { imports: new Map(), reexports: new Map(), calls: new Map(), unresolved: [] };

  const resolve = (spec: string): string | null => {
    if (!isLocalSpecifier(spec)) return null;                 // a package: not ours to follow
    const target = resolveLocalModule(ROOT, file, spec);
    if (target === null) facts.unresolved.push(spec);
    return target;
  };

  const calleesIn = (node: ts.Node): Set<string> => {
    const out = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression)) out.add(n.expression.text);
        else if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
          out.add(`${n.expression.expression.text}.${n.expression.name.text}`);
        }
        for (const arg of n.arguments) if (ts.isIdentifier(arg)) out.add(arg.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return out;
  };

  const declare = (name: string, body: ts.Node): void => {
    const prev = facts.calls.get(name) ?? new Set<string>();
    for (const callee of calleesIn(body)) prev.add(callee);
    facts.calls.set(name, prev);
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (!clause || clause.isTypeOnly) continue;             // a type import is erased; it calls nothing
      const target = resolve(stmt.moduleSpecifier.text);
      if (target === null) continue;
      if (clause.name) facts.imports.set(clause.name.text, fnKey(target, "default"));
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) facts.imports.set(bindings.name.text, fnKey(target, "*"));
      else if (bindings) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue;
          facts.imports.set(el.name.text, fnKey(target, (el.propertyName ?? el.name).text));
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)
    ) {
      const target = resolve(stmt.moduleSpecifier.text);
      if (target === null) continue;
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        facts.reexports.set(el.name.text, fnKey(target, (el.propertyName ?? el.name).text));
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      declare(stmt.name.text, stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (d.initializer && ts.isIdentifier(d.name)) declare(d.name.text, d.initializer);
      }
    }
  }
  return facts;
}

/**
 * Every function that reaches one of `seeds`, transitively.
 *
 * A fixpoint: keep adding any declaration that reaches something already reached, until a round adds
 * nothing. It terminates because `reached` only grows and is bounded by the graph, so a call CYCLE —
 * routine in these services — is fine. A re-export is followed as an alias, bounded so a re-export
 * cycle cannot hang either.
 */
function functionsReaching(graph: Map<string, ModuleFacts>, seeds: readonly FnKey[]): Set<FnKey> {
  const alias = (key: FnKey): FnKey => {
    for (let hop = 0; hop < 10; hop++) {
      const [file, name] = key.split("#");
      const next = graph.get(file)?.reexports.get(name);
      if (next === undefined) return key;
      key = next;
    }
    return key;
  };
  const reached = new Set<FnKey>(seeds.map(alias));
  for (const seed of seeds) reached.add(seed);

  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, facts] of graph) {
      for (const [name, callees] of facts.calls) {
        const key = fnKey(file, name);
        if (reached.has(key)) continue;
        for (const callee of callees) {
          const [receiver, member] = callee.includes(".") ? callee.split(".") : [callee, null];
          if (member === null && facts.calls.has(callee) && reached.has(fnKey(file, callee))) {
            reached.add(key); grew = true; break;             // a sibling in this same module
          }
          const imported = facts.imports.get(receiver);
          if (imported === undefined) continue;
          const [target, exported] = imported.split("#");
          const wanted = fnKey(target, member ?? exported);    // `X.f()` on `import * as X`
          if (reached.has(wanted) || reached.has(alias(wanted))) { reached.add(key); grew = true; break; }
        }
      }
    }
  }
  return reached;
}

// ---------------------------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------------------------

/** `src/app/api/orders/[id]/traveler/route.ts` -> `/api/orders/{}/traveler`. Every dynamic segment
 *  collapses to one placeholder, because a client URL can never say which id it holds. */
const DYNAMIC = "{}";
const routePattern = (file: string): string =>
  "/" + file.slice("src/app/".length, -"/route.ts".length)
    .split("/").map((seg) => (seg.startsWith("[") ? DYNAMIC : seg)).join("/");

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const MUTATING_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

// ---------------------------------------------------------------------------------------------
// CLIENT REQUEST SITES
// ---------------------------------------------------------------------------------------------

type RequestSite = { file: string; line: number; url: string; method: string };

/**
 * The URL argument as a PATTERN, or `null` when it cannot be read.
 *
 * Every template interpolation becomes `*` — a hole of unknown text WITHIN one path segment, not a
 * whole segment. `` `/api/orders/${id}/traveler${query}` `` ends with an interpolation that is
 * either empty or a query string, and reading that last segment as "traveler plus something" is what
 * lets it still match the `/traveler` route; reading it as an extra segment silently unmatched the
 * traveler print, measured, on the first draft of this file.
 *
 * A bare IDENTIFIER is folded against the file's own `const` initializers, and `a + b` is folded
 * left-first with an unreadable tail becoming a hole. Both exist because hoisting the URL out of the
 * call — `const path = ...; fetch(path, { method: "POST" })` — is an ordinary edit, and without
 * folding it moves the file out of the routed census and into the opaque exemption below, which is a
 * permanent amnesty rather than a check. Folding is what keeps `LogoPanel`, `AttachmentsSection` and
 * `UserSignatureControl` inside the routed half.
 */
function foldUrl(node: ts.Expression | undefined, consts: Map<string, string>): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `*${s.literal.text}`).join("");
  }
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldUrl(node.left, consts);
    if (left === null) return null;
    const right = foldUrl(node.right, consts);
    return left + (right ?? "*");
  }
  return null;
}

/**
 * The HTTP method of a request, read from the init object.
 *
 * `"UNKNOWN"` is returned for every shape that cannot be read — a spread, a shorthand `{ method }`,
 * a computed key, a ternary, an init arriving as a variable — and every caller treats UNKNOWN as
 * mutating. That is the fail-CLOSED direction; guessing GET would drop the site out of the census
 * with no failure of its own.
 */
function methodOf(node: ts.Expression | undefined): string {
  if (node === undefined) return "GET";                       // `fetch(url)` — a plain read
  if (!ts.isObjectLiteralExpression(node)) return "UNKNOWN";
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return "UNKNOWN";         // `{ ...init }` may carry any method
    const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ? prop.name.text : null;
    if (name !== "method") continue;
    if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text;
    return "UNKNOWN";                                          // shorthand, computed, or an expression
  }
  return "GET";
}

/** An init object that names a `method` at all — the signal that a call IS a request even when its
 *  callee is neither `fetch` nor `api`. Deliberately NOT satisfied by a bare spread: `{ ...a, ...b }`
 *  is an object-merge idiom this codebase uses everywhere, and counting it reported three `Map.set`
 *  and `setState` calls as unroutable requests. */
const namesAMethod = (node: ts.Expression | undefined): boolean =>
  node !== undefined && ts.isObjectLiteralExpression(node)
  && node.properties.some((p) => !!p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    && p.name.text === "method");

/** The client tree: everything under `src/` that is not a route handler or a service. */
const clientFiles = (): string[] =>
  [...srcFiles(".tsx"), ...srcFiles(".ts")]
    .filter((f) => !f.startsWith("src/app/api/") && !f.startsWith("src/server/"))
    .sort();

/**
 * Every request this file issues, split into the ones whose URL could be read and the ones whose
 * could not.
 *
 * A ROUTED site is ANY `CallExpression` whose first argument folds to a URL beginning `/api/` — the
 * callee name is deliberately not part of the test. `fetch` and `api()` are not the only two ways a
 * request leaves this app: `customers/[id]/page.tsx` wraps them in a local `call(path, init)` for
 * in-flight de-duplication, and a name-keyed detector would have to know about that wrapper and
 * about every future one. Anchoring on the URL covers a new wrapper the day it is written.
 *
 * An OPAQUE site is one this sweep cannot route: a call to `fetch` or `api`, or any call whose init
 * names a `method`, whose URL did not fold. Reported rather than skipped — a print built on a
 * prop-supplied path would otherwise be invisible to every check here.
 */
function requestSites(file: string, src = read(file)): { routed: RequestSite[]; opaque: RequestSite[] } {
  const sf = parseSource(file, src);
  // Constants are collected by NAME across the whole file, with no scope analysis — so a name
  // declared twice with DIFFERENT values would otherwise fold to whichever came last, and a request
  // could be attributed to a route it never calls or, worse, away from one it does. An ambiguous
  // name therefore folds to nothing, which drops its call sites into the opaque bucket below and
  // makes them an exemption somebody has to write. Nine names collide on this tree today (all of
  // them `key`, none a URL), so this is closing the shape rather than fixing a live misfold.
  const consts = new Map<string, string>();
  const ambiguous = new Set<string>();
  const collectConsts = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const value = foldUrl(n.initializer, new Map());
      const name = n.name.text;
      if (value !== null) {
        const prior = consts.get(name);
        if (prior !== undefined && prior !== value) ambiguous.add(name);
        consts.set(name, value);
      }
    }
    ts.forEachChild(n, collectConsts);
  };
  ts.forEachChild(sf, collectConsts);
  for (const name of ambiguous) consts.delete(name);

  const routed: RequestSite[] = [];
  const opaque: RequestSite[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : null;
      const url = foldUrl(n.arguments[0], consts);
      const method = methodOf(n.arguments[1]);
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (url !== null && url.startsWith("/api/")) routed.push({ file, line, url, method });
      else if (callee === "fetch" || callee === "api" || namesAMethod(n.arguments[1])) {
        opaque.push({ file, line, url: "", method });
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return { routed, opaque };
}

const isMutating = (site: RequestSite): boolean =>
  MUTATING_METHODS.includes(site.method) || site.method === "UNKNOWN";

/**
 * Could this client URL denote this route?
 *
 * Segment-wise, on equal segment counts. A route's dynamic segment matches anything; otherwise the
 * client segment — regex-escaped, with each `*` hole widened to `[^/]*` — must match the route's
 * literal segment exactly. A client segment that is only a hole therefore matches any route literal,
 * which over-matches in the safe direction: it claims MORE routes for a call site, so a dangerous
 * one cannot slip out of the census by being written with an interpolated path segment. A hole never
 * spans a separator, or `/api/*` would claim every route in the app.
 */
function urlMatchesRoute(url: string, pattern: string): boolean {
  const client = url.split(/[?#]/)[0].split("/");
  const route = pattern.split("/");
  if (client.length !== route.length) return false;
  return client.every((seg, i) => {
    if (route[i] === DYNAMIC) return true;
    const re = new RegExp(`^${seg.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return re.test(route[i]);
  });
}

// ---------------------------------------------------------------------------------------------
// THE GATE, PROVED PER CONTROL
// ---------------------------------------------------------------------------------------------

/**
 * Which of this file's bindings carry the unsaved-edit answer, and how often each name is used.
 *
 * THE REASON THIS EXISTS. A file-scoped "does it call a gate primitive" is not a census of controls:
 * `InvoiceDetail.tsx` calls `useUnsavedPresent()` ONCE and feeds it to three separate gates — finalize,
 * recalculate and print. Delete the unsaved branch out of the recalculate gate alone and the file
 * still calls the primitive, so a file-scoped rule stays green while a replace goes ungated. So the
 * answer is TAINTED forward instead: the binding of a `useUnsavedPresent(...)` result is a seed, and
 * any `const` whose initializer mentions a tainted name is tainted too. `recalcGate` is tainted only
 * while it still reads `unsavedLines`, which makes that exact deletion red by name.
 *
 * THE SECOND HALF IS THE REFUSAL SITE, and the first version of this shipped without it. Tainting
 * proves the gate still ASKS the guard; it says nothing about whether any control still READS the
 * gate. A reviewer disconnected the cert print from its gate — `disabled={printGate.disabled ||
 * printing || unsavedReadings}` reduced to `disabled={printGate.disabled || printing}` — and this
 * sweep stayed green, because `unsavedReadings` was still computed and still mentioned in the
 * button's `title`. A `uses >= 2` floor is satisfied by a tooltip. So a claimed name must also
 * appear where a control is actually REFUSED: inside a `disabled={…}` attribute, or in an `if`
 * condition (an early return refuses too). That is syntax, needs no renderer, and reds the moment a
 * button stops consulting the gate it is claimed to be gated by.
 *
 * THE TAINT IS BY NAME, with no scope analysis, and that is a stated limitation rather than an
 * oversight. Two components in one file that both declare `printGate` share one verdict here, and a
 * PROP named like a tainted binding would taint the declaration that reads it. Both directions
 * over-approximate coverage, so this is the one part of the sweep that does not fail closed — which
 * is why a `gate` verdict names the binding explicitly instead of being inferred: a reviewer reading
 * the entry can see which control is being claimed, and the pinned (file, route) census means a new
 * control cannot arrive under an existing claim.
 */
function gateBindings(file: string, src = read(file)):
{ tainted: Set<string>; uses: Map<string, number>; refusals: Set<string> } {
  const sf = parseSource(file, src);
  const decls: { name: string; init: ts.Expression }[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      decls.push({ name: n.name.text, init: n.initializer });
    }
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(sf, collect);

  const tainted = new Set<string>();
  const mentions = (node: ts.Node, pred: (n: ts.Node) => boolean): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => { if (pred(n)) hit = true; ts.forEachChild(n, walk); };
    walk(node);
    return hit;
  };
  for (const d of decls) {
    if (mentions(d.init, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
      && n.expression.text === "useUnsavedPresent")) tainted.add(d.name);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of decls) {
      if (tainted.has(d.name)) continue;
      if (mentions(d.init, (n) => ts.isIdentifier(n) && tainted.has(n.text))) { tainted.add(d.name); grew = true; }
    }
  }

  const uses = new Map<string, number>();
  const count = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) uses.set(n.text, (uses.get(n.text) ?? 0) + 1);
    ts.forEachChild(n, count);
  };
  ts.forEachChild(sf, count);

  // Names read where a control is REFUSED. `disabled={…}` is how every gate on this tree reaches its
  // button; an `if` condition is included because an early return refuses just as effectively, and
  // leaving it out would push a correct file onto the exemption list.
  const refusals = new Set<string>();
  const namesIn = (node: ts.Node): void => {
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) refusals.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
  };
  const findRefusals = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === "disabled" && n.initializer) {
      namesIn(n.initializer);
    } else if (ts.isIfStatement(n)) namesIn(n.expression);
    ts.forEachChild(n, findRefusals);
  };
  ts.forEachChild(sf, findRefusals);

  return { tainted, uses, refusals };
}

/** Does this file ask before discarding — as a CALL, never as an import or a mention (#188)? */
const callsConfirmDiscard = (file: string): boolean =>
  callsBareIdentifier(read(file), "confirmDiscard", file);

// ---------------------------------------------------------------------------------------------
// THE SEEDS
// ---------------------------------------------------------------------------------------------

/** The one function that files permanent paper. Its uniqueness is asserted, not assumed. */
const ARCHIVE_SEED: FnKey = "src/server/documents.ts#storeDocument";

/** The Prisma writes that would create a `StoredDocument` outside `storeDocument`. If one of these
 *  ever appears in a second file, the archival half has silently narrowed and this sweep says so. */
const STORED_DOCUMENT_WRITE = /\bstoredDocument\.(create|createMany|createManyAndReturn|upsert)\b/;

/**
 * Exported service functions that REPLACE a row set a client may be holding as an unsaved overlay,
 * where the operator's own click is NOT that write. Seeded by hand — see the header — and kept
 * complete by `REPLACE_CANDIDATES` below.
 */
const REPLACE_SEEDS: Map<FnKey, string> = new Map([
  ["src/server/invoices.ts#recalculateInvoice",
    "Rebuilds every derived invoice line from the order, so a typed-but-unsaved line in the invoice "
    + "grid is discarded as an orphan."],
  ["src/server/order-loads.ts#resplitLoads",
    "Recomputes the whole load set from the part's caps and writes it, taking no rows from the "
    + "caller — so a pending load quantity, weight, addition or removal is replaced rather than "
    + "saved. That 'rewrites a collection it did not receive' test is what separates it from "
    + "`replaceLoads`, the Loads grid's own Save, which reaches the same private `applyLoads`."],
  ["src/server/part-process-steps.ts#loadTemplate",
    "Replaces every process step on the part's working revision with a template's blank skeleton, so "
    + "every step draft on the page is an orphan."],
  ["src/server/shippers.ts#reverseShipper",
    "Creates the negative-of-everything reversal shipment and reopens the order, and the page "
    + "navigates to the reversal — so any unsaved line, container or serial grid on the shipment "
    + "being reversed is gone. NOT rediscoverable by the tripwire: it un-ships by clearing "
    + "`lineComplete`, a flag flip with no delete in it (residual 3 in the header)."],
  ["src/server/order-edit.ts#removeLine",
    "Hard-deletes every `OrderSerial` of the line, which is exactly the row set `SerialsSection` "
    + "holds in a registered `useBulkGrid` overlay while the operator types into it."],
  ["src/server/shippers.ts#removeOrderFromShipper",
    "Deletes that order's shipper lines, containers and serials — the three grids the shipment page "
    + "mounts for it."],
  ["src/server/invoices.ts#finalizeInvoice",
    "FREEZES rather than deletes, and is the third kind of hazard: a finalized invoice's line grid "
    + "goes read-only, so an overlay held over it becomes permanently unsavable — the same lost work "
    + "by a different route, and the reason `finalizeGate` exists. Seeded by hand because the "
    + "tripwire below looks for destroyers and a status write is not one."],
  ["src/server/practice-reset.ts#resetPracticeData",
    "Truncates the practice database and re-seeds the demo baseline. Every row any editor on screen "
    + "is holding an overlay over ceases to exist."],
]);

/**
 * A verdict for every dangerous (client file, route) pair. This IS the census the hand list was.
 *
 * `gate` names a binding this file must still be computing FROM `useUnsavedPresent()` AND still
 * refusing a control with — so both deleting the gate's unsaved branch and disconnecting the button
 * from the gate red, even when the file keeps other gates. `confirmDiscard` is proved only at file
 * scope (residual 2). `allowed` is an exemption whose reason must open by naming which of THREE
 * claims it makes: NOTHING TO GUARD (the page holds no editor), GUARDED OTHERWISE (it is protected
 * by something this sweep cannot prove), or NOT GUARDED — a real gap, recorded rather than fixed.
 * The third is the dangerous one, so it costs more: it must cite an issue, and how many may exist at
 * once is pinned, which makes a fourth a decision rather than one line of prose.
 */
type Verdict = { gate: string } | { confirmDiscard: true } | { allowed: string };
const CONTROL_VERDICTS: Map<string, Verdict> = new Map([
  ["src/app/certs/[id]/CertDetail.tsx :: /api/certs/{}/print",
    { gate: "unsavedReadings" }],
  ["src/app/invoicing/[id]/InvoiceDetail.tsx :: /api/invoices/{}/finalize",
    { gate: "finalizeGate" }],
  ["src/app/invoicing/[id]/InvoiceDetail.tsx :: /api/invoices/{}/print",
    { gate: "printGate" }],
  ["src/app/invoicing/[id]/InvoiceDetail.tsx :: /api/invoices/{}/recalculate",
    { gate: "recalcGate" }],
  ["src/app/orders/[id]/DocumentsSection.tsx :: /api/orders/{}/traveler",
    { gate: "printGate" }],
  ["src/app/shipping/[id]/ShipmentDetail.tsx :: /api/shippers/{}/print",
    { gate: "printGate" }],
  ["src/app/orders/[id]/LoadsSection.tsx :: /api/orders/{}/loads/resplit",
    { confirmDiscard: true }],
  ["src/app/shipping/[id]/ShipmentDetail.tsx :: /api/shippers/{}/reverse",
    { confirmDiscard: true }],

  // ---- exemptions ----
  ["src/app/quotes/[id]/QuoteDetail.tsx :: /api/quotes/{}/print",
    { allowed:
      "ARCHIVES, GUARDED OTHERWISE. `printGate` (:246) refuses on the page-local `dirty` (:210) that "
      + "this file also registers with the guard at :597, rather than reading the registry back. The "
      + "whole quote editor is this one file, so the local flag sees what the registry would — with "
      + "one deliberate exception recorded at :586-594: `dirty` excludes a typed-but-unadded price "
      + "break, because an unadded break is in neither the server state nor the printed lines. "
      + "Converting this to the primitive would re-litigate that ruling." }],
  ["src/app/receivables/statements/Statements.tsx :: /api/receivables/statements",
    { allowed:
      "ARCHIVES, NOTHING TO GUARD. Every control on the statements page is a filter (asOf, "
      + "combineFamily, assessFinanceCharges, customer); there is no explicit-save editor on it, so a "
      + "gate would be constant false. This reason fails OPEN the day an editor is added here — the "
      + "backstop is that such an editor must register, which unsaved-registration-sweep enforces." }],
  ["src/app/receivables/statements/Statements.tsx :: /api/receivables/statements/divisions",
    { allowed: "ARCHIVES, NOTHING TO GUARD — the per-division run of the same page; see the entry "
      + "for /api/receivables/statements above." }],
  ["src/app/receivables/statements/Statements.tsx :: /api/receivables/statements/run",
    { allowed: "ARCHIVES, NOTHING TO GUARD — the run-for-everyone form of the same page; see the "
      + "entry for /api/receivables/statements above." }],
  ["src/app/parts/[id]/ProcessStepsSection.tsx :: /api/parts/{}/process/load-template",
    { allowed:
      "REPLACES, GUARDED OTHERWISE. It asks first with its own wording — `confirm(\"Replace the "
      + "current steps…\")` at :360, BEFORE the request — and prunes its own step drafts on success, "
      + "which is the only overlay over those rows: no other section on the parts page holds one. It "
      + "does not read the registry, so the prompt names nothing at risk; that is a wording gap "
      + "rather than a lost-work gap." }],
  ["src/app/practice/PracticeResetControl.tsx :: /api/practice/reset",
    { allowed:
      "REPLACES, GUARDED OTHERWISE. Its own page holds no editor, and its `window.confirm` states "
      + "the whole consequence — everything entered in the practice copy is erased and replaced with "
      + "the sample data — which is a stronger warning than the shared prompt's. The route is "
      + "refused outright on a non-practice database, so this can never reach production rows." }],
  ["src/app/orders/[id]/LinesSection.tsx :: /api/orders/{}/lines/{}",
    { allowed:
      "REPLACES, NOT GUARDED — a gap this sweep found, recorded rather than fixed here. `removeLine` "
      + "hard-deletes the line's `OrderSerial` rows, and `SerialsSection` holds exactly those in a "
      + "registered overlay; the `confirm` at :222 names the LINE and never the unsaved serials, and "
      + "the pair also covers this file's two field PATCHes, which are ordinary blur saves; and "
      + "consults nothing. Filed as #293; changing the control is a behaviour decision, not part "
      + "of building the census that found it." }],
  ["src/app/shipping/[id]/ShipmentDetail.tsx :: /api/shippers/{}/orders/{}",
    { allowed:
      "REPLACES, NOT GUARDED — the same gap on the shipment page, and the reason this sweep proves "
      + "gates per control rather than per file: `removeOrder` at :653 asks a bare `confirm` that "
      + "does name the loss, while the file's OTHER controls are properly gated, so a file-scoped "
      + "rule would have blessed it. Filed as #294." }],
]);

/**
 * Client files holding a mutating request whose URL cannot be read at all, because the path arrives
 * as a prop or a parameter. Each reason must say where the path comes from — that is what makes
 * "this cannot be archival" checkable by a reader rather than merely asserted.
 */
const OPAQUE_URL_ALLOWED: Map<string, string> = new Map([
  ["src/app/customers/[id]/page.tsx",
    "The address and contact writes go through a local `call(path, init)` that de-duplicates "
    + "in-flight requests, and its own `api(path, init)` is the one unroutable site; the paths it is "
    + "handed are literal `/api/customers/...` strings in this same file, which this sweep routes "
    + "separately. The page's other writes call `api()` with a literal path directly."],
  ["src/components/AttachmentsSection.tsx",
    "Deletes one attachment at `${basePath}/${att.id}` — a path built from an owner-supplied prop, so "
    + "it folds no further. An attachment is a stored FILE, never printed paper: no attachment route "
    + "reaches `storeDocument`, which the derived archival route set above independently shows."],
  ["src/components/PasteGrid.tsx",
    "Posts pasted rows to an `endpoint` prop, supplied by its three consumers — `ReferenceTable`, "
    + "the parts list and the customers list, each a `.../paste` bulk importer. It creates rows; it "
    + "prints and replaces nothing."],
]);

// ---------------------------------------------------------------------------------------------
// THE DISCOVERY TRIPWIRE
// ---------------------------------------------------------------------------------------------

const RAW_EXEC = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRawUnsafe"]);
/** The raw-exec name a tag names, whether written `db.$executeRaw` or bare. */
const rawTagName = (tag: ts.Expression): string | null =>
  ts.isPropertyAccessExpression(tag) ? tag.name.text : (ts.isIdentifier(tag) ? tag.text : null);
const RAW_DESTRUCTIVE = /\b(TRUNCATE|DELETE\s+FROM|UPDATE)\b/i;

/**
 * Every `src/server` function that destroys rows WHOLESALE — the candidates the replace census must
 * classify.
 *
 * THE UNIVERSE IS "DESTROYS", NOT "DELETES AND RE-CREATES", and that widening is the whole value.
 * The obvious rule — a `deleteMany` paired with a `createMany` on the same model — reads as precise
 * and is the wrong shape: it finds the replaces that put something back and misses every destroyer
 * that does not, which is where two live gaps were sitting (`removeLine` deletes a line's serials,
 * `removeOrderFromShipper` deletes three grids' rows, neither creates anything). Three arms:
 * `deleteMany` on any delegate; an `updateMany` whose DATA clause writes `deletedAt`, which is how
 * the soft-deletable models are cleared; and a raw `$executeRaw*` whose SQL is destructive, without
 * which the practice reset's `TRUNCATE` — the largest replace in the tree — is invisible.
 *
 * The soft-delete arm reads the `data` clause specifically. Matching `deletedAt` anywhere in the
 * call swept in every `claimLive*` helper in the tree, whose WHERE clause names it: ten candidates
 * that destroy nothing, and a tripwire whose failures are mostly noise is one that gets loosened.
 *
 * WHAT IT STILL CANNOT SEE, enumerated because each is a destroyer that would arrive with no
 * candidate: a LOOP of single-row `.delete()` calls (counting bare `delete` would flag every
 * one-row removal in the tree, which is the noise trade above, and no loop-delete exists here
 * today — measured); a delegate HOISTED out of its receiver (`const rows = tx.orderSerial; await
 * rows.deleteMany(…)`, which breaks the `receiver.model.op` shape this reads); and a destroy that
 * lives in a callee while the create lives in the caller. The first two are empty on this tree; the
 * third is why a candidate's ROUTES are pinned rather than only its name.
 */
function replaceCandidates(): Map<FnKey, string> {
  const found = new Map<FnKey, string>();
  for (const file of srcFiles(".ts").filter((f) => f.startsWith("src/server/"))) {
    const sf = parseSource(file);
    const consider = (name: string, body: ts.Node): void => {
      const reasons = new Set<string>();
      const walk = (n: ts.Node): void => {
        // A tagged template FIRST, because it is the majority shape: six of the seven raw sites in
        // `src/server` are `` db.$executeRaw`…` `` and only one is a call, so an arm that reads only
        // `ts.isCallExpression` misses almost all of them — it missed `reseedSingletons`'s whole-table
        // UPDATE, which is a destroyer reached by the practice reset (reviewer-found, mutation-proved).
        if (ts.isTaggedTemplateExpression(n) && RAW_DESTRUCTIVE.test(n.getText(sf))
          && RAW_EXEC.has(rawTagName(n.tag) ?? "")) reasons.add("raw destructive SQL");
        if (ts.isCallExpression(n)) {
          if (ts.isIdentifier(n.expression) && RAW_EXEC.has(n.expression.text)
            && RAW_DESTRUCTIVE.test(n.getText(sf))) reasons.add("raw destructive SQL");
          if (ts.isPropertyAccessExpression(n.expression)) {
            const op = n.expression.name.text;
            const recv = n.expression.expression;
            if (RAW_EXEC.has(op) && RAW_DESTRUCTIVE.test(n.getText(sf))) reasons.add("raw destructive SQL");
            if (ts.isPropertyAccessExpression(recv) && ts.isIdentifier(recv.name)) {
              const model = recv.name.text;
              if (op === "deleteMany") reasons.add(`deleteMany ${model}`);
              if (op === "updateMany") {
                const arg = n.arguments[0];
                const data = arg && ts.isObjectLiteralExpression(arg)
                  ? arg.properties.find((p) => !!p.name && ts.isIdentifier(p.name) && p.name.text === "data")
                  : undefined;
                if (data && /deletedAt/.test(data.getText(sf))) reasons.add(`soft-delete sweep ${model}`);
              }
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
      if (reasons.size > 0) found.set(fnKey(file, name), [...reasons].sort().join("; "));
    };
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) consider(stmt.name.text, stmt.body);
      else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (d.initializer && ts.isIdentifier(d.name)) consider(d.name.text, d.initializer);
        }
      }
    }
  }
  return found;
}

/**
 * Every discovered destroyer, with a written verdict AND the routes that reach it.
 *
 * The route list is not decoration: `applyLoads` is one function reached by two entry points with
 * OPPOSITE verdicts — `replaceLoads` is the Loads grid's own Save, `resplitLoads` is a hazard — so a
 * verdict keyed on the function alone can record only one of them, and a THIRD caller would inherit
 * whichever was written, silently. Pinning the routes makes that caller red by name.
 */
const REPLACE_CANDIDATES: Map<FnKey, { verdict: string; routes: string[] }> = new Map([
  ["src/server/cert-results.ts#replaceReadings",
    { verdict: "NOT A HAZARD — the readings grid's own Save; the click IS the replace.",
      routes: ["/api/certs/{}/results"] }],
  ["src/server/invoices.ts#replaceInvoiceLines",
    { verdict: "NOT A HAZARD — the invoice lines grid's own Save; the click IS the replace.",
      routes: ["/api/invoices/{}/lines"] }],
  ["src/server/invoices.ts#recalculateInvoice",
    { verdict: "HAZARD — seeded.", routes: ["/api/invoices/{}/recalculate"] }],
  ["src/server/order-edit.ts#removeLine",
    { verdict: "HAZARD — seeded.", routes: ["/api/orders/{}/lines/{}"] }],
  ["src/server/order-edit.ts#replaceContainers",
    { verdict: "NOT A HAZARD — the Containers grid's own Save; the click IS the replace.",
      routes: ["/api/orders/{}/containers"] }],
  ["src/server/order-edit.ts#replaceSerials",
    { verdict: "NOT A HAZARD — the Serials grid's own Save; the click IS the replace.",
      routes: ["/api/orders/{}/lines/{}/serials"] }],
  ["src/server/order-edit.ts#replaceCharges",
    { verdict: "NOT A HAZARD — the Charges grid's own Save; the click IS the replace.",
      routes: ["/api/orders/{}/charges"] }],
  ["src/server/order-loads.ts#applyLoads",
    { verdict: "NOT A HAZARD ITSELF — a module-private helper reached by `replaceLoads` (the Loads "
      + "grid's own Save) and by `resplitLoads`, which is seeded as a hazard. The hazard is the "
      + "caller, which is why both its routes are pinned here.",
      routes: ["/api/orders/{}/loads", "/api/orders/{}/loads/resplit"] }],
  ["src/server/part-process-steps.ts#removeStep",
    { verdict: "NOT A HAZARD — destroys the step the operator asked to remove, and its draft overlay "
      + "is pruned on both sides (#283, #289); the click IS the removal.",
      routes: ["/api/parts/{}/process/steps/{}"] }],
  ["src/server/part-process-steps.ts#loadTemplate",
    { verdict: "HAZARD — seeded.", routes: ["/api/parts/{}/process/load-template"] }],
  ["src/server/practice-seed.ts#reseedSingletons",
    { verdict: "HAZARD via its caller — it truncates and re-seeds the by-construction singletons and "
      + "the eight Standard templates as part of `resetPracticeData`, which is seeded. Surfaced only "
      + "once the raw-SQL arm learned to read a tagged template.",
      routes: ["/api/practice/reset"] }],
  ["src/server/practice-reset.ts#truncateAllTables",
    { verdict: "HAZARD via its caller — the truncate behind `resetPracticeData`, which is seeded.",
      routes: ["/api/practice/reset"] }],
  ["src/server/quotes.ts#applyQuoteLines",
    { verdict: "NOT A HAZARD — the quote form's own Save; the click IS the replace.",
      routes: ["/api/quotes/{}"] }],
  ["src/server/quotes.ts#deleteQuote",
    { verdict: "NOT A HAZARD — deleting the quote is the one action QuoteDetail deliberately allows "
      + "while the form is dirty (:436-438): the operator is discarding the very work the guard "
      + "would be protecting.",
      routes: ["/api/quotes/{}"] }],
  ["src/server/roles.ts#setRolePermissions",
    { verdict: "NOT A HAZARD — writes the permission matrix the admin form just submitted.",
      routes: ["/api/admin/roles/{}"] }],
  ["src/server/sessions.ts#destroySession",
    { verdict: "NOT A HAZARD — signing out; no editor holds an overlay over session rows, and the "
      + "sign-out path consults the guard itself (Shell.tsx).",
      routes: ["/api/auth/logout"] }],
  ["src/server/shippers.ts#removeOrderFromShipper",
    { verdict: "HAZARD — seeded.", routes: ["/api/shippers/{}/orders/{}"] }],
  ["src/server/shippers.ts#replaceShipperLines",
    { verdict: "NOT A HAZARD — the shipment panel's Lines Save; the click IS the replace.",
      routes: ["/api/shippers/{}/orders/{}/lines"] }],
  ["src/server/shippers.ts#replaceShipperContainers",
    { verdict: "NOT A HAZARD — the shipment panel's Containers Save; the click IS the replace.",
      routes: ["/api/shippers/{}/orders/{}/containers"] }],
  ["src/server/shippers.ts#replaceShipperSerials",
    { verdict: "NOT A HAZARD — the shipment panel's Serials Save; the click IS the replace.",
      routes: ["/api/shippers/{}/orders/{}/serials"] }],
  ["src/server/surcharges.ts#setSurchargeStepCodes",
    { verdict: "NOT A HAZARD — writes the step-code set the surcharge form just submitted.",
      routes: ["/api/admin/surcharges/{}/step-codes"] }],
  ["src/server/users.ts#writeUser",
    { verdict: "NOT A HAZARD — rewrites a user's overrides and sessions from the admin form being "
      + "saved; no editor overlays either.",
      routes: ["/api/admin/users/{}"] }],
]);

// ---------------------------------------------------------------------------------------------

describe("#277 — every control that archives paper or replaces rows carries a verdict", () => {
  const routes = srcFiles(".ts").filter((f) => /^src\/app\/api\/.*\/route\.ts$/.test(f));
  // The graph spans the SERVICES, every `.ts` under `src/app/api` (fifteen shared helper modules
  // already live beside the route files, and a handler extracted into one must not break the walk)
  // and `src/lib` (the client-safe leaves several routes delegate to).
  const graph = new Map<string, ModuleFacts>(
    srcFiles(".ts")
      .filter((f) => f.startsWith("src/server/") || f.startsWith("src/app/api/") || f.startsWith("src/lib/"))
      .map((f) => [f, moduleFacts(f)]),
  );

  /** Route patterns whose mutating handler reaches one of `seeds`. */
  const routesReaching = (seeds: readonly FnKey[]): string[] => {
    const reached = functionsReaching(graph, seeds);
    return [...new Set(routes
      .filter((f) => MUTATING_METHODS.some((m) => reached.has(fnKey(f, m))))
      .map(routePattern))].sort();
  };

  const dangerousRoutes = [...new Set([
    ...routesReaching([ARCHIVE_SEED]),
    ...routesReaching([...REPLACE_SEEDS.keys()]),
  ])].sort();

  const allRouted: RequestSite[] = [];
  const allOpaque: RequestSite[] = [];
  for (const file of clientFiles()) {
    const { routed, opaque } = requestSites(file);
    allRouted.push(...routed);
    allOpaque.push(...opaque);
  }

  /**
   * The dangerous (file, route) pairs, derived. The client method is deliberately IGNORED here:
   * moving a print behind a one-argument helper (`postDoc(url)`) makes the site read as a GET, and
   * a method-filtered join would drop it out of the census with nothing to show for it. Matching on
   * the URL alone attributes it either way; the cost on this tree is zero extra pairs.
   */
  const dangerousPairs = [...new Set(allRouted.flatMap((s) =>
    dangerousRoutes.filter((p) => urlMatchesRoute(s.url, p)).map((p) => `${s.file} :: ${p}`)))].sort();

  it("finds enough source to be a real census, not a vacuous pass", () => {
    // Each floor is a failure this sweep could not otherwise report: "no files matched" and "all
    // files clean" are the same green. The five VOLUME floors below sit well under their measured
    // figures, so ordinary growth never trips them; the two KIND floors after them are deliberately
    // tight — at today's 5 gates and 2 asks, removing either ask trips one, which is the point.
    expect(routes.length, "API route files").toBeGreaterThan(100);
    expect(graph.size, "modules in the call graph").toBeGreaterThan(250);
    expect(clientFiles().length, "client sources").toBeGreaterThan(100);
    expect(allRouted.filter(isMutating).length, "mutating client request sites").toBeGreaterThan(80);
    expect(routesReaching([ARCHIVE_SEED]).length, "routes reaching storeDocument").toBeGreaterThanOrEqual(6);
    expect(dangerousPairs.length, "dangerous (file, route) pairs").toBeGreaterThanOrEqual(12);
    // The two proof checks below iterate the verdicts of their own kind, so a census that degenerated
    // entirely into exemptions would leave both loops empty and both green. Converting a gate into an
    // exemption already costs a written reason a reviewer can refuse — this makes it cost a floor too.
    const kinds = [...CONTROL_VERDICTS.values()];
    expect(kinds.filter((v) => "gate" in v).length, "controls proved by a named gate").toBeGreaterThanOrEqual(4);
    expect(kinds.filter((v) => "confirmDiscard" in v).length, "controls proved by an ask")
      .toBeGreaterThanOrEqual(2);
  });

  it("derives the archival routes from storeDocument rather than from a list", () => {
    const archival = routesReaching([ARCHIVE_SEED]);
    // Anchors, not the whole set — the point of deriving is that the set may legitimately grow.
    expect(archival).toContain("/api/orders/{}/traveler");
    expect(archival).toContain("/api/certs/{}/print");
    expect(archival).toContain("/api/invoices/{}/print");
    expect(archival).toContain("/api/shippers/{}/print");
    // The private-hop case, kept as an anchor because it is the edge a naive graph drops: the
    // statements routes reach `storeDocument` through a module-private `printStatementInTx`.
    expect(archival).toContain("/api/receivables/statements");
    // And the negative direction — a route that merely IMPORTS a service module holding an archival
    // function must not be swept in. Both of these import the very modules that print.
    expect(archival).not.toContain("/api/invoices/{}/lines");
    expect(archival).not.toContain("/api/orders/{}/loads");
  });

  it("keeps storeDocument the only writer of archived paper", () => {
    // The archival half rests entirely on that seed. Left as a design-time grep it would narrow to
    // nothing the day a batch print writes `storedDocument.createMany` directly — every assertion
    // here is phrased over the seed's reachability, so all of them would stay green.
    const writers = srcFiles(".ts").filter((f) => STORED_DOCUMENT_WRITE.test(read(f))).sort();
    expect(writers).toEqual(["src/server/documents.ts"]);
    // The pattern must NOT be global: a `/g` regex carries `lastIndex` between `.test()` calls, so
    // every file after the first match would be searched from that offset and a genuine second writer
    // would be skipped in silence. Asserting the FLAG is the only check that catches it — a reviewer
    // added `g` and the two behavioural assertions below still passed, because the carried offset
    // happens to answer `false` for a short string, which is what they expect anyway.
    expect(STORED_DOCUMENT_WRITE.global, "a /g regex carries lastIndex between files").toBe(false);
    expect(STORED_DOCUMENT_WRITE.test("await tx.storedDocument.createMany({})"), "still detects").toBe(true);
    expect(STORED_DOCUMENT_WRITE.test("await tx.storedDocument.findMany({})"), "a read is not a write")
      .toBe(false);
    // A nested relation create writes the row without naming the delegate: `order.update({ data: {
    // documents: { create: … } } })`. Empty on this tree, and asserted rather than assumed, because
    // the archival half rests entirely on the delegate form being the only one.
    const nested = srcFiles(".ts").filter((f) => /documents:\s*\{\s*create/.test(read(f))).sort();
    expect(nested, "a StoredDocument created through a relation").toEqual([]);
  });

  it("pins which client file reaches which dangerous route", () => {
    // THE ANTI-FAIL-OPEN COUNTERPART to the join guard below. Every check that follows is phrased
    // over `dangerousPairs`, so a control that stops being SEEN — moved behind a helper the parser
    // does not follow, or into a shared component with a prop-supplied path — empties its own row and
    // takes its verdict with it, quietly. Pinning the set makes the disappearance the failure.
    expect(dangerousPairs).toEqual([...CONTROL_VERDICTS.keys()].sort());
  });

  it("proves each refusing gate is still computed FROM the unsaved answer", () => {
    // Per CONTROL, not per file. `InvoiceDetail.tsx` calls `useUnsavedPresent()` once and feeds three
    // gates; deleting the unsaved branch out of one of them must red, and under a file-scoped rule it
    // would not.
    const broken: string[] = [];
    for (const [key, verdict] of CONTROL_VERDICTS) {
      if (!("gate" in verdict)) continue;
      const [file] = key.split(" :: ");
      const { tainted, refusals } = gateBindings(file);
      if (!tainted.has(verdict.gate)) broken.push(`${key}: ${verdict.gate} no longer reads useUnsavedPresent()`);
      else if (!refusals.has(verdict.gate)) broken.push(`${key}: ${verdict.gate} refuses no control`);
    }
    expect(broken).toEqual([]);
  });

  it("proves each asking gate still calls confirmDiscard", () => {
    // File scope, and the header says why it cannot be narrower: the call sits in a JSX handler while
    // the request is issued in a function beside it.
    const broken = [...CONTROL_VERDICTS]
      .filter(([, v]) => "confirmDiscard" in v)
      .map(([key]) => key.split(" :: ")[0])
      .filter((file) => !callsConfirmDiscard(file));
    expect(broken).toEqual([]);
  });

  it("keeps every exemption a reason somebody wrote, and states which claim it makes", () => {
    const problems: string[] = [];
    for (const [key, verdict] of CONTROL_VERDICTS) {
      if (!("allowed" in verdict)) continue;
      if (verdict.allowed.trim().length <= 40) problems.push(`${key}: the reason is too short to be a reason`);
      // Every exemption is one of exactly two claims, and conflating them is how an entry written to
      // silence an over-match ends up blessing a real gap.
      if (!/^(ARCHIVES|REPLACES), (GUARDED OTHERWISE|NOTHING TO GUARD|NOT GUARDED)/.test(verdict.allowed)) {
        problems.push(`${key}: the reason must open by naming the claim it makes`);
      }
      // A NOT GUARDED entry says a real gap ships. It must name the issue that tracks it, or the
      // exemption is just prose silencing the sweep — "a permanent amnesty rather than a check".
      if (/^(ARCHIVES|REPLACES), NOT GUARDED/.test(verdict.allowed) && !/#\d+/.test(verdict.allowed)) {
        problems.push(`${key}: a NOT GUARDED reason must cite the issue tracking the gap`);
      }
      // AND the other two claims must be TRUE OF THE FILE. Without this, a per-control gate proof can
      // be switched off by rewriting its verdict as a plausible sentence — a reviewer did exactly
      // that to CertDetail's print and the sweep stayed green. If the file is still computing a gate
      // from `useUnsavedPresent()` and still refusing a control with it, then "guarded by something
      // this sweep cannot prove" and "nothing here to guard" are both false, and the honest verdict
      // is the gate. NOT GUARDED is deliberately exempt: `ShipmentDetail` genuinely has working gates
      // on its OTHER controls, which is the whole point of #294.
      if (/^(ARCHIVES|REPLACES), (GUARDED OTHERWISE|NOTHING TO GUARD)/.test(verdict.allowed)) {
        const [file] = key.split(" :: ");
        const { tainted, refusals } = gateBindings(file);
        const proven = [...tainted].filter((name) => refusals.has(name));
        if (proven.length > 0) {
          problems.push(`${key}: ${proven.join(", ")} already refuses from useUnsavedPresent — claim the gate`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Pinned, not floored: a third known-unguarded control is a decision somebody makes, not a line
    // of prose somebody adds. Both of today's were found by this sweep and filed as #293 and #294.
    const notGuarded = [...CONTROL_VERDICTS.values()]
      .filter((v) => "allowed" in v && /^(ARCHIVES|REPLACES), NOT GUARDED/.test(v.allowed));
    expect(notGuarded.length, "known-unguarded controls").toBe(2);
  });

  it("keeps the client-to-route join intact — every mutating request resolves to a real route", () => {
    // Both halves depend on a URL matching a route pattern, and a join that silently stops matching
    // turns every check above green: routes lose their callers and nothing is flagged. So the join is
    // asserted over EVERY mutating request in the app rather than only the dangerous ones — if URL
    // normalisation drifts, this reds by name long before a gate goes missing.
    const patterns = routes.map(routePattern);
    const unmatched = allRouted.filter(isMutating)
      .filter((s) => !patterns.some((p) => urlMatchesRoute(s.url, p)))
      .map((s) => `${s.file}:${s.line} ${s.method} ${s.url}`);
    expect(unmatched).toEqual([]);
  });

  it("writes down every mutating request whose URL it cannot read", () => {
    // A path arriving as a prop is a request this sweep cannot route, so it cannot say whether the
    // request is dangerous. An exemption with a reason is the fail-CLOSED answer; skipping it is how
    // a print built on a prop-supplied path would be invisible to every check here.
    const opaqueFiles = [...new Set(allOpaque.filter(isMutating).map((s) => s.file))]
      .filter((f) => f !== "src/lib/fetcher.ts")       // the `api()` helper itself — it IS the wrapper
      .sort();
    expect(opaqueFiles).toEqual([...OPAQUE_URL_ALLOWED.keys()].sort());
    for (const [file, reason] of OPAQUE_URL_ALLOWED) {
      expect(reason.trim().length, `${file}: the reason is too short to be a reason`).toBeGreaterThan(40);
    }
  });

  it("classifies every wholesale destroyer in src/server, with the routes that reach it", () => {
    const candidates = replaceCandidates();
    expect(candidates.size, "discovered destroyers").toBeGreaterThanOrEqual(15);
    expect([...candidates.keys()].sort(), "unclassified or vanished destroyer")
      .toEqual([...REPLACE_CANDIDATES.keys()].sort());
    const routeDrift = [...REPLACE_CANDIDATES]
      .map(([key, { routes: pinned }]) => {
        const actual = routesReaching([key]);
        return actual.join(",") === [...pinned].sort().join(",")
          ? null : `${key}: reaches ${actual.join(", ") || "(none)"}, pinned ${pinned.join(", ")}`;
      })
      .filter((x): x is string => x !== null);
    expect(routeDrift).toEqual([]);
    // Every seeded hazard must be reachable, or the seed names a function that no longer exists.
    for (const seed of REPLACE_SEEDS.keys()) {
      expect(routesReaching([seed]).length, `${seed} reaches no route`).toBeGreaterThan(0);
    }
  });

  it("has no local import specifier the graph could not resolve", () => {
    // Every unresolved local specifier is a lost edge, and a lost edge is fail-OPEN: a dangerous
    // route reached through it stops being detected with no failure of its own.
    const lost = [...graph]
      .flatMap(([file, facts]) => facts.unresolved.map((spec) => `${file}: ${spec}`))
      .sort();
    expect(lost).toEqual([]);
  });

  it("reads a method off every route, so an unrecognised export cannot hide a handler", () => {
    // A route file whose graph holds none of the six method names is one this sweep would never
    // classify — it drops out of both halves silently. Next calls only these exports, so what this
    // really catches is a parse or a walk that stopped seeing declarations.
    const methodless = routes
      .filter((f) => {
        const facts = graph.get(f);
        return !HTTP_METHODS.some((m) => facts?.calls.has(m) || facts?.reexports.has(m));
      })
      .sort();
    expect(methodless).toEqual([]);
  });
});

describe("#277 — the detectors themselves, on sources written to break them", () => {
  // None of the rules above can be trusted from a green run: each passes both when the code is safe
  // and when the detector has gone blind. These exercise the rules directly, which is the only place
  // that difference shows.

  const firstCall = <T>(src: string, pick: (n: ts.CallExpression) => T): T | undefined => {
    const sf = parseSource("candidate.tsx", src);
    let out: T | undefined;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && out === undefined) out = pick(n);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    return out;
  };

  it("reads a URL from every literal shape, folds a hoisted one, and refuses the rest", () => {
    const url = (src: string, consts = new Map<string, string>()): string | null | undefined =>
      firstCall(src, (n) => foldUrl(n.arguments[0], consts));
    expect(url(`fetch("/api/x");`)).toBe("/api/x");
    expect(url("fetch(`/api/x`);")).toBe("/api/x");
    expect(url("fetch(`/api/orders/${id}/traveler`);")).toBe("/api/orders/*/traveler");
    // The shape that broke the first draft of this file: a trailing interpolation carrying a query.
    expect(url("fetch(`/api/orders/${id}/traveler${query}`);")).toBe("/api/orders/*/traveler*");
    // The two evasions folding exists for.
    expect(url(`fetch(path, { method: "POST" });`, new Map([["path", "/api/certs/*/print"]])))
      .toBe("/api/certs/*/print");
    expect(url(`fetch("/api/certs/" + id + "/print");`)).toBe("/api/certs/*/print");
    // Genuinely unreadable — reported rather than guessed at.
    expect(url(`fetch(path);`)).toBe(null);
    expect(url(`fetch(pick(a, b));`)).toBe(null);
  });

  it("treats an unreadable HTTP method as mutating, never as a read", () => {
    const method = (src: string): string | undefined => firstCall(src, (n) => methodOf(n.arguments[1]));
    expect(method(`fetch("/api/x");`), "no init is a read").toBe("GET");
    expect(method(`fetch("/api/x", { method: "POST" });`)).toBe("POST");
    expect(method(`fetch("/api/x", { "method": "DELETE" });`), "a quoted key").toBe("DELETE");
    expect(method(`fetch("/api/x", { headers: {} });`), "an init with no method").toBe("GET");
    for (const src of [
      `fetch("/api/x", { ...init });`,
      `fetch("/api/x", { method });`,
      `fetch("/api/x", { method: verb });`,
      `fetch("/api/x", { method: hard ? "PUT" : "POST" });`,
      `fetch("/api/x", init);`,
    ]) expect(method(src), src).toBe("UNKNOWN");
    expect(isMutating({ file: "x", line: 1, url: "/api/x", method: "UNKNOWN" })).toBe(true);
    expect(isMutating({ file: "x", line: 1, url: "/api/x", method: "GET" })).toBe(false);
  });

  it("folds a hoisted URL, but refuses a name declared twice with different values", () => {
    const one = requestSites("candidate.tsx",
      `function a() { const path = "/api/certs/x/print"; return fetch(path, { method: "POST" }); }`);
    expect(one.routed.map((s) => s.url), "a single declaration folds").toEqual(["/api/certs/x/print"]);
    expect(one.opaque).toEqual([]);
    // The same name meaning two different things: whichever came last would win, and the call sites
    // would be attributed to a route one of them never calls. Unreadable is the fail-CLOSED answer —
    // both land in the opaque bucket, where they need an exemption somebody writes.
    const two = requestSites("candidate.tsx", [
      `function a() { const path = "/api/certs/x/print"; return fetch(path, { method: "POST" }); }`,
      `function b() { const path = "/api/quotes/y"; return fetch(path, { method: "DELETE" }); }`,
    ].join("\n"));
    expect(two.routed).toEqual([]);
    expect(two.opaque.length, "both sites become unroutable, not just the second").toBe(2);
    // Re-declaring the SAME value is not ambiguity — a constant repeated in two components is common
    // and reads identically either way.
    const same = requestSites("candidate.tsx", [
      `function a() { const path = "/api/certs/x/print"; return fetch(path, { method: "POST" }); }`,
      `function b() { const path = "/api/certs/x/print"; return fetch(path, { method: "DELETE" }); }`,
    ].join("\n"));
    expect(same.routed.length).toBe(2);
    expect(same.opaque).toEqual([]);
  });

  it("calls an init a request only when it names a method, not when it merely spreads", () => {
    // `namesAMethod` is what widens the opaque bucket past `fetch`/`api` to a local wrapper. Made any
    // looser it fires on the object-merge idiom: `next.set(id, { ...next.get(id), ...patch })` was
    // reported as an unroutable request in three files.
    const named = (src: string): boolean | undefined => firstCall(src, (n) => namesAMethod(n.arguments[1]));
    expect(named(`send("/x", { method: "POST" });`)).toBe(true);
    expect(named(`send(url, { method: verb, body });`)).toBe(true);
    expect(named(`next.set(id, { ...prev, ...patch });`), "an object merge").toBe(false);
    expect(named(`send("/x", { headers: {} });`)).toBe(false);
  });

  it("matches a client URL to a route pattern, holes and query strings included", () => {
    expect(urlMatchesRoute("/api/certs/*/print", "/api/certs/{}/print")).toBe(true);
    expect(urlMatchesRoute("/api/orders/*/traveler*", "/api/orders/{}/traveler")).toBe(true);
    expect(urlMatchesRoute("/api/shippers/*/print?*", "/api/shippers/{}/print")).toBe(true);
    // A hole standing where a literal segment is: over-matched deliberately, because claiming more
    // routes for a call site is what keeps a dangerous one inside the census.
    expect(urlMatchesRoute("/api/*/statements", "/api/receivables/statements")).toBe(true);
    // What must NOT match: a different depth, a different literal, a prefix, a hole spanning a slash.
    expect(urlMatchesRoute("/api/certs/*/print", "/api/certs/{}")).toBe(false);
    expect(urlMatchesRoute("/api/certs/*/print", "/api/quotes/{}/print")).toBe(false);
    expect(urlMatchesRoute("/api/receivables/statements", "/api/receivables/statements/run")).toBe(false);
    expect(urlMatchesRoute("/api/*", "/api/receivables/statements")).toBe(false);
  });

  it("follows a call through an import, a private hop, a barrel and a point-free handler", () => {
    // The four edges the real tree needs, on a synthetic graph so the shapes are visible. A miss on
    // any is fail-OPEN — a dangerous route that stops being detected.
    const facts = (calls: [string, string[]][], imports: [string, string][] = [],
      reexports: [string, string][] = []): ModuleFacts => ({
      imports: new Map(imports), reexports: new Map(reexports),
      calls: new Map(calls.map(([k, v]) => [k, new Set(v)])), unresolved: [],
    });
    const graph = new Map<string, ModuleFacts>([
      ["doc.ts", facts([])],
      ["svc.ts", facts([["printThing", ["printThingInTx"]], ["printThingInTx", ["store"]]],
        [["store", "doc.ts#store"]])],
      ["barrel.ts", facts([], [], [["printThing", "svc.ts#printThing"]])],
      ["route.ts", facts([["POST", ["handle", "printThing"]]], [["printThing", "barrel.ts#printThing"]])],
      ["other.ts", facts([["POST", ["handle", "listThings"]]], [["listThings", "svc.ts#listThings"]])],
    ]);
    const reached = functionsReaching(graph, ["doc.ts#store"]);
    expect(reached.has("svc.ts#printThingInTx"), "the private hop").toBe(true);
    expect(reached.has("svc.ts#printThing"), "the exported entry").toBe(true);
    expect(reached.has("route.ts#POST"), "through the barrel, point-free").toBe(true);
    expect(reached.has("other.ts#POST"), "a route importing the module but not the function").toBe(false);
  });

  it("collects an identifier passed as an argument, which is what makes point-free reachable", () => {
    // `export const POST = handle(printCert)` never syntactically calls `printCert`. This calls the
    // REAL `moduleFacts` — an earlier version re-implemented the walk inline and stayed green with
    // the production line deleted, which is the same class of defect as a comment that describes
    // code it does not run.
    const facts = moduleFacts("src/app/api/x/route.ts", `export const POST = handle(printCert);`);
    expect([...(facts.calls.get("POST") ?? [])].sort()).toEqual(["handle", "printCert"]);
    // And a property call on a namespace import is recorded as `receiver.member`, which is how the
    // fixpoint follows `import * as X`.
    const ns = moduleFacts("src/app/api/y/route.ts", `export const POST = () => X.printCert();`);
    expect([...(ns.calls.get("POST") ?? [])]).toContain("X.printCert");
  });

  it("terminates on a call cycle and on a re-export cycle", () => {
    const facts = (calls: [string, string[]][], imports: [string, string][] = [],
      reexports: [string, string][] = []): ModuleFacts => ({
      imports: new Map(imports), reexports: new Map(reexports),
      calls: new Map(calls.map(([k, v]) => [k, new Set(v)])), unresolved: [],
    });
    const cyclic = new Map<string, ModuleFacts>([
      ["a.ts", facts([["f", ["g", "store"]], ["g", ["f"]]], [["store", "doc.ts#store"]])],
      ["b.ts", facts([], [], [["x", "c.ts#x"]])],
      ["c.ts", facts([], [], [["x", "b.ts#x"]])],
    ]);
    const reached = functionsReaching(cyclic, ["doc.ts#store"]);
    expect(reached.has("a.ts#f")).toBe(true);
    expect(reached.has("a.ts#g"), "reached through the cycle").toBe(true);
    expect(reached.has("b.ts#x"), "a re-export cycle resolves to nothing, and does not hang").toBe(false);
  });

  it("taints a gate only while it still reads the unsaved answer", () => {
    // The mutation the per-control rule exists to catch, on the real file: `recalcGate` must stop
    // being tainted the moment it stops reading `unsavedLines`, even though the file keeps calling
    // `useUnsavedPresent()` for its other two gates.
    const live = gateBindings("src/app/invoicing/[id]/InvoiceDetail.tsx");
    for (const name of ["unsavedLines", "finalizeGate", "recalcGate", "printGate"]) {
      expect(live.tainted.has(name), `${name} should be tainted today`).toBe(true);
    }
    // And a file that gates on a flag of its own, without the primitive, must NOT read as covered —
    // this is the divergence QuoteDetail's exemption is written about.
    const local = gateBindings("src/app/quotes/[id]/QuoteDetail.tsx");
    // Both halves, because the negative alone holds for any string in a file that never calls the
    // primitive — it distinguished nothing. The pair says: this gate EXISTS and refuses a control,
    // and it is still not derived from the registry, which is exactly what its exemption claims.
    expect(local.refusals.has("printGate"), "the gate refuses a control").toBe(true);
    expect(local.tainted.has("printGate"), "but not from useUnsavedPresent").toBe(false);
  });

  it("detects the asking gate as a CALL, never as an import or a mention", () => {
    const asks = (src: string): boolean => callsBareIdentifier(src, "confirmDiscard", "x.tsx");
    expect(asks(`if (!confirmDiscard()) return;`)).toBe(true);
    // The blind spot #188 names, re-found in this repo by mutation twice: an import left behind after
    // the call was deleted must NOT read as covered.
    expect(asks(`import { confirmDiscard } from "@/lib/use-unsaved-section";`)).toBe(false);
    expect(asks(`// guarded by confirmDiscard() above`), "a comment").toBe(false);
    expect(asks(`const hint = "confirmDiscard()";`), "a string").toBe(false);
    expect(asks(`<p>confirmDiscard()</p>`), "JSX text").toBe(false);
    expect(asks(`onLeave={confirmDiscard}`), "a reference, never called").toBe(false);
  });

  it("finds all three destroy shapes and no unrelated write", () => {
    // Exercised through the real tree, because the shapes are what the services actually write.
    const found = replaceCandidates();
    expect(found.has("src/server/invoices.ts#recalculateInvoice"), "deleteMany").toBe(true);
    expect(found.has("src/server/quotes.ts#applyQuoteLines"), "updateMany stamping deletedAt").toBe(true);
    expect(found.has("src/server/practice-reset.ts#truncateAllTables"), "raw destructive SQL").toBe(true);
    // The destroyer that puts nothing back — the shape a delete-and-re-create rule misses, and where
    // two live gaps were sitting.
    expect(found.has("src/server/order-edit.ts#removeLine"), "a destroy with no create").toBe(true);
    expect(found.has("src/server/shippers.ts#removeOrderFromShipper")).toBe(true);
    // A pure create is not a destroyer, and neither is a claim helper whose WHERE clause merely names
    // `deletedAt` — the noise that made the first version of this arm unusable.
    expect(found.has("src/server/documents.ts#storeDocument"), "a pure create").toBe(false);
    expect(found.has("src/server/parts.ts#claimLive"), "a live-row claim").toBe(false);
  });

  it("resolves `@/` as the only path alias, so no import shape is silently a package", () => {
    // `resolveLocalModule` answers `null` for any non-relative specifier that is not `@/`, treating it
    // as a package. That is only safe while `@/` is the only alias.
    const tsconfig = JSON.parse(read("tsconfig.json").replace(/^\s*\/\/.*$/gm, "")) as
      { compilerOptions: { paths: Record<string, string[]> } };
    expect(Object.keys(tsconfig.compilerOptions.paths)).toEqual(["@/*"]);
  });
});
