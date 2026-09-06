import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// THE CENSUS BEHIND THE CLAIM. #272 said registration was a "structural guarantee" because
// `useUnsavedSection` is called from inside the shared `SaveButton` — but that only ever bound the
// editors that USE that button, and Codex found several that did not: `InvoiceLinesGrid`,
// `CustomFieldsSection`, and the receivables apply panel all held an explicit-save draft while
// `unsavedLabels()` stayed empty, so navigating away discarded them in silence. The claim was
// overclaiming, which is this repo's most-refiled defect class, and a comment cannot fix it.
//
// This sweep is what makes it true: an explicit-save editor is one whose Save control is DISABLED
// on a dirty flag, and every such file must register. Derived by walking src/, never hand-listed,
// and it deliberately over-matches so it fails CLOSED — the escape hatch is an allowlist ENTRY WITH
// A REASON, never a silent absence.
//
// It cannot see an editor that tracks dirtiness some other way; that residual is why
// `use-unsaved-section.ts` documents the contract in prose as well.

// `import.meta.url`, not `__dirname`: this package is `"type": "module"` and every other test that
// resolves a repo path (errors, period-locks, manual-artifacts, …) uses this idiom — this file was
// the only `__dirname` left. Vitest's transform does define `__dirname`, so the old line ran green
// and the suite was never broken by it; the reason to change it is that nothing else here depends
// on that shim, and a swept source is exactly the kind of file another loader may one day read.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Files whose Save control gates on a dirty flag but which legitimately do not register. Each
 *  entry states why, so removing one is a decision. */
const ALLOWED = new Map<string, string>([
  // The shared button itself — it IS the registration, and calling the hook here is what every
  // consumer inherits.
  ["components/SaveButton.tsx", "the shared button; it performs the registration for its consumers"],
  // Its draft is AUTOSAVED to /api/order-drafts and resumable, so leaving the page loses nothing —
  // the crash-safety promise this form was built around already covers what the guard would.
  ["app/orders/new/page.tsx", "the order draft is autosaved server-side and resumed on return"],
  // "Save view" names and stores a filter immediately; there is no accumulating draft behind it.
  ["app/board-parts/SavedViewsBar.tsx", "saves a named filter on the click; nothing is held first"],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Comments are not UI. Stripping them first is what stops a file that merely DISCUSSES a Save
 *  button — Shell.tsx's own guard commentary — from being counted as one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * A file that holds work until someone clicks Save.
 *
 * TWO signatures, because the first one alone was not a census (Codex P1 on #272). The original
 * rule keyed on a Save control disabled by a `dirty` identifier — and `NewShipment` keeps an entire
 * shipment, its picked orders and their line/container/serial grids, in local state behind a
 * "Save shipment" button with NO dirty flag anywhere, so it sailed through a sweep whose whole
 * purpose was to find exactly that. A draft does not have to name itself `dirty` to be a draft.
 *
 * So the label counts too: a control that says "Save …" is a file that accumulates work. That
 * deliberately over-matches — a page that saves immediately has no draft to lose — and those are
 * allowlist entries WITH REASONS, which is the point: each one becomes a decision somebody wrote
 * down rather than a file the detector never looked at.
 */
function hasExplicitSaveGate(source: string): boolean {
  const body = code(source);
  if (/disabled=\{[^}]*dirty/i.test(body) || /\bdirty=\{/.test(body)) return true;
  // A Save-labelled control: JSX text (`>Save lines`), or a string used as the label
  // (`{saving ? "Saving…" : "Save shipment"}`, `label="Save containers"`).
  //
  // The string arm matches a LABEL, not prose. A tooltip beginning "Save the readings first — a
  // print archives…" is a sentence explaining why a control is disabled, and counting it flagged
  // CertDetail — a file with no editor of its own — as an unregistered editor. Allowlisting that
  // would have recorded something false; the detector was simply wrong, and this sweep caught it
  // on the very commit that introduced it. A label is short and carries no sentence punctuation.
  return />\s*Save\b/.test(body)
    || [...body.matchAll(/["'`](Save [A-Za-z][^"'`]*)["'`]/g)]
      .some(([, label]) => label.length <= 24 && !/[.,—;:]/.test(label));
}

/** Registration is a CALL or a rendered button — never a mere import. Matching the import was this
 *  sweep's own first bug: deleting the call left `import { useUnsavedSection } …` behind and the
 *  sweep still passed, so it reported coverage it was not checking. Same blind spot the
 *  audit-children census documents (#188), found the same way — by deleting a registration and
 *  watching the sweep stay green. Import lines are stripped before the call is looked for. */
function registers(source: string): boolean {
  const body = source.replace(/^\s*import\s[^;]*;$/gm, "");
  return /\buseUnsavedSection\s*\(/.test(body) || /<SaveButton\b/.test(body);
}

/**
 * The lines in this source where a BARE `fetch` issues a write (#276).
 *
 * A write is a `method` this reader cannot rule out: one of the four mutating literals, or any shape
 * it cannot read — a spread, a shorthand, a COMPUTED key, a variable, a ternary, or an init that is
 * not an object literal at all. All of those fail CLOSED, since a method it cannot see is one that
 * might be a write. A missing second argument is the GET that `fetch` defaults to — UNLESS the first
 * argument is not a plain URL, because `fetch(new Request(url, { method: "POST" }))` carries its
 * method there instead.
 *
 * The global is recognised bare AND through `window`/`globalThis`/`self`, which are the same
 * function; only those receivers count, so `res.fetch(...)` stays some other function that shares
 * the name. Every one of these arms was a fail-OPEN in the first version, found by a reviewer
 * probing shapes rather than by the sweep going red — none occurs in `src/` today, so they are
 * closed shapes rather than fixed misses, and the self-test below is what keeps them closed.
 */
function bareFetchWrites(source: string, fileName: string): number[] {
  const sf = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const GLOBALS = new Set(["window", "globalThis", "self"]);
  const isWrite = (url: ts.Expression | undefined, init: ts.Expression | undefined): boolean => {
    if (init === undefined) {
      // `fetch(url)` is the GET default — but only when the first argument really is a URL. A
      // `Request` object carries its own method, and `fetch(req)` cannot be read at all.
      return !(url !== undefined
        && (ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url) || ts.isTemplateExpression(url)));
    }
    if (!ts.isObjectLiteralExpression(init)) return true;      // an init variable: unreadable
    for (const prop of init.properties) {
      if (ts.isSpreadAssignment(prop)) return true;            // `{ ...init }` may carry any method
      if (!prop.name) return true;                             // a shape with no readable key
      if (ts.isComputedPropertyName(prop.name)) return true;   // `{ ["method"]: verb }`
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (name !== "method") continue;
      if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) {
        return MUTATING.has(prop.initializer.text.toUpperCase());
      }
      return true;                                             // shorthand, or an expression
    }
    return false;                                              // an init that names no method
  };
  /** `fetch`, `window.fetch`, `globalThis.fetch`, `self.fetch` — the same function. */
  const isGlobalFetch = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === "fetch")
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch"
      && ts.isIdentifier(callee.expression) && GLOBALS.has(callee.expression.text));
  const out: number[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isGlobalFetch(n.expression) && isWrite(n.arguments[0], n.arguments[1])) {
      out.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return out;
}

/** Every dirty-ish identifier that GATES a Save control — the `nameDirty` in
 *  `disabled={canEdit.disabled || !nameDirty}`. A page can hold more than one draft, each with its
 *  own button, and the file-level check above cannot see the difference. */
function dirtyFlagsGatingSaves(source: string): string[] {
  const flags = new Set<string>();
  for (const m of source.matchAll(/disabled=\{([^}]*)\}/g)) {
    for (const ident of m[1].matchAll(/\b([A-Za-z_$][\w$]*(?:[Dd]irty)[\w$]*)\b/g)) flags.add(ident[1]);
  }
  return [...flags];
}

/** Whether a dirty flag reaches the guard — named inside a `useUnsavedSection(...)` argument, or
 *  handed to a `<SaveButton dirty={...}>`. Deliberately textual and over-matching: it fails CLOSED,
 *  and the escape hatch is the allowlist, not a cleverer regex. */
function flagIsRegistered(source: string, flag: string): boolean {
  const sites = [
    ...source.matchAll(/useUnsavedSection\s*\(([\s\S]*?)\)\s*;/g),
    ...source.matchAll(/dirty=\{([^}]*)\}/g),
  ];
  return sites.some((m) => new RegExp(`\\b${flag}\\b`).test(m[1]));
}

describe("every explicit-save editor registers with the unsaved-edit guard", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

  it("finds enough source to be a real census, not a vacuous pass", () => {
    // Without this the whole sweep would pass on a bad glob — the failure mode a sweep cannot
    // otherwise report, since "no files matched" and "all files clean" look identical.
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => hasExplicitSaveGate(readFileSync(f, "utf8"))).length)
      .toBeGreaterThanOrEqual(8);
  });

  it("leaves no explicit-save editor unregistered", () => {
    const unregistered = files
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return hasExplicitSaveGate(src) && !registers(src);
      })
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !ALLOWED.has(rel));
    expect(unregistered).toEqual([]);
  });

  it("registers EVERY dirty flag that gates a Save, not merely one per file", () => {
    // The blind spot the file-level check above cannot see, and Codex found it in the wild: the
    // process-template page registered its boilerplate steps while a second draft — the template
    // NAME, with its own Save button — stayed outside the guard, so a rename was discarded in
    // silence by a file that already looked covered.
    const gaps = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(SRC.length + 1);
      if (ALLOWED.has(rel) || !registers(src)) return []; // absence is the previous test's job
      return dirtyFlagsGatingSaves(src)
        .filter((flag) => !flagIsRegistered(src, flag))
        .map((flag) => `${rel}: ${flag}`);
    });
    expect(gaps).toEqual([]);
  });

  it("lets no client write escape the in-flight counter (#276)", () => {
    // THE OTHER HALF OF THE GUARD KNOWING WHAT IT NEEDS TO KNOW. This file's subject is that every
    // editor tells the registry it is dirty; this is that every WRITE tells the registry it is in
    // flight, which is what stopped the navigation prompt offering to discard a save that was
    // already committing. The count is incremented in exactly one place — `trackedFetch` in
    // `src/lib/fetcher.ts`, which `api()` is built on — so a bare `fetch` with a mutating method
    // anywhere else is a write the prompt cannot see, and the sentence goes back to being untrue on
    // that path alone. That is precisely the shape a hand census cannot hold, which is why it is
    // here rather than in a comment.
    //
    // PARSED, not pattern-matched (#188): `fetch` appears in prose and in strings across this tree,
    // and the question is whether it is CALLED with a write method — which the parser answers and a
    // regex does not. Server code is out of scope: a `fetch` under `src/server` or `src/app/api` is
    // the server calling out, not this browser tab writing.
    const offenders = files
      .filter((f) => {
        const rel = f.slice(SRC.length + 1);
        return !rel.startsWith("server/") && !rel.startsWith("app/api/") && rel !== "lib/fetcher.ts";
      })
      .flatMap((f) => bareFetchWrites(readFileSync(f, "utf8"), f).map((line) => `${f.slice(SRC.length + 1)}:${line}`));
    expect(offenders, "use trackedFetch (or api) so the unsaved-edit prompt can see the write")
      .toEqual([]);
  });

  it("...and that detector reads the call, not the word", () => {
    // Not vacuous by construction: the check above passes on a clean tree whether the detector works
    // or is blind, and those two look identical. These are the shapes it must and must not catch.
    const at = (src: string) => bareFetchWrites(src, "candidate.tsx");
    expect(at(`await fetch("/api/x", { method: "POST" });`), "a bare write").toHaveLength(1);
    expect(at(`await fetch(url, { method: verb });`), "an unreadable method fails closed").toHaveLength(1);
    expect(at(`await fetch("/api/x", { ...init });`), "a spread could carry any method").toHaveLength(1);
    // The four shapes a reviewer probed through the first version. None occurs in src/ today, which
    // is exactly why only a self-test can hold them: the census is green either way.
    expect(at(`await fetch(url, init);`), "an init variable is unreadable").toHaveLength(1);
    expect(at(`await fetch("/api/x", { ["method"]: verb });`), "a computed key").toHaveLength(1);
    expect(at(`await fetch(new Request(url, { method: "POST" }));`), "a Request carries its own method")
      .toHaveLength(1);
    expect(at(`await window.fetch("/api/x", { method: "POST" });`), "window.fetch IS the global")
      .toHaveLength(1);
    expect(at(`await globalThis.fetch("/api/x", { method: "POST" });`)).toHaveLength(1);
    expect(at(`await self.fetch("/api/x", { method: "POST" });`)).toHaveLength(1);
    expect(at(`await fetch("/api/x");`), "a read").toEqual([]);
    expect(at("await fetch(`/api/${id}`);"), "a read with an interpolated URL").toEqual([]);
    expect(at(`await fetch("/api/x", { headers: {} });`), "a read with headers").toEqual([]);
    expect(at(`await trackedFetch("/api/x", { method: "POST" });`), "the wrapper itself").toEqual([]);
    expect(at(`await api("/api/x", { method: "POST" });`), "the helper built on it").toEqual([]);
    expect(at(`// fetch("/api/x", { method: "POST" })`), "a comment").toEqual([]);
    expect(at(`const hint = 'fetch("/api/x", { method: "POST" })';`), "a string").toEqual([]);
    expect(at(`res.fetch("/api/x", { method: "POST" });`), "a property call, not the global").toEqual([]);
  });

  it("keeps the allowlist honest — every entry still exists and still looks like an editor", () => {
    // An allowlist entry for a file that has moved is a reason nobody is reading any more.
    for (const rel of ALLOWED.keys()) {
      const src = readFileSync(join(SRC, rel), "utf8");
      expect(hasExplicitSaveGate(src), `${rel} no longer matches — drop its allowlist entry`).toBe(true);
    }
  });
});
