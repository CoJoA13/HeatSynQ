#!/usr/bin/env node
/**
 * build-manual.mjs — rebuild `docs/manual/manual.html` from the chapter markdown.
 *
 * WHY THIS EXISTS. `manual.html` is the single-page build of the 14-chapter manual: one file,
 * every screenshot inlined as a `data:` URI, no network, no dependencies. It was originally
 * produced by hand, which meant every edit to a chapter — or every rename of a control in the
 * app — silently rotted it. This script makes it reproducible: the markdown is the source, the
 * HTML is output, and a stale page is now a one-command fix rather than a re-typing job.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. Node built-ins only. The markdown subset below is hand-rolled
 * and covers exactly what the chapters actually contain (see MARKDOWN SUBSET). Adding a markdown
 * library to a docs tool is not wanted; if a chapter starts using a construct this parser does
 * not know, the parser is where the fix goes.
 *
 * DETERMINISTIC. Same inputs, same bytes. No clock, no randomness, and every directory read is
 * sorted — the file is committed, so a no-op rebuild must be a no-op diff. The provenance comment
 * at the top of the output carries a digest of the SOURCES, never a timestamp.
 *
 * LOUD ON ROT. A figure reference that does not resolve to a real file aborts the build with a
 * non-zero exit. That is the whole point: a broken figure is exactly the defect a hand-built page
 * hides. So is a chapter that exists on disk but is missing from `README.md`'s contents table, or
 * vice versa — the chapter order is derived, never hand-listed here.
 *
 * MARKDOWN SUBSET (determined by reading all 14 chapters plus README.md, not from a wish list):
 *   - ATX headings `#`..`######`
 *   - paragraphs, hard-wrapped in the source and joined with a space
 *   - `**strong**`, `*emphasis*`, `` `code` ``, `[link](target)`, `![figure](img/x.png)`
 *   - unordered (`-`/`*`/`+`) and ordered (`1.`) lists, with indented continuation lines and
 *     indent-based nesting
 *   - pipe tables, including the headerless form (`| | |` header row → no `<thead>`)
 *   - blockquotes, including multi-paragraph ones (`>` on its own line)
 *   - thematic breaks (`---`)
 *   - fenced code blocks (```) — none today, supported so the first one does not break the build
 *
 * DELIBERATELY NOT SUPPORTED: `_underscore_` emphasis and `~~strikethrough~~`. Both would corrupt
 * real chapter text — the permission actions are written bare (`edit_cert_results_after_print`,
 * `override_credit_hold`, `close_ar_period`), and chapter 12 quotes a literal audit-log diff
 * `status: ~~OPEN~~ → SHIPPED`. Do not "complete" the parser by adding them.
 *
 * Run: npm run manual:build   (from erp/)
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_DIR = path.resolve(HERE, "../../docs/manual");
const IMG_DIR = path.join(MANUAL_DIR, "img");
const OUT_FILE = path.join(MANUAL_DIR, "manual.html");
const README = "README.md";

const PAGE_TITLE = "HeatSynQ Manual";

/**
 * Screenshots are captured by `manual:capture` at deviceScaleFactor 2 on a 1440px-wide viewport
 * (so 2880 physical px), and the manual lays a full-width screen out at 1200 CSS px — a further
 * 1.2 reduction. 2 × 1.2 = 2.4 physical pixels per rendered pixel. Declaring width/height keeps
 * the page from reflowing as 6 MB of inline images decode; `max-width:100%` still caps them.
 * Expressed as 10/24 rather than /2.4 so the halves land on exact binary fractions and rounding
 * is stable across platforms.
 */
const IMG_SCALE_NUM = 10;
const IMG_SCALE_DEN = 24;
const displayPx = (px) => Math.round((px * IMG_SCALE_NUM) / IMG_SCALE_DEN);

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

// ---------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

/** Heading/figure anchor: lowercase, every run of non-alphanumerics becomes one hyphen. */
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------------------
// inline markdown
// ---------------------------------------------------------------------------

/**
 * Next run of `*` at or after `from`, as { start, len }, skipping code spans and backslash
 * escapes. Runs matter rather than single characters: chapter 13 writes `**the word *locked***`,
 * where the closing `***` is one run that has to be split between the inner `*` and the outer `**`.
 * (The hand-built page got that one wrong and emitted misnested `<strong>…<em></strong></em>`.)
 */
function findStarRun(src, from) {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const fence = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(fence, i + fence.length);
      i = close === -1 ? i + fence.length : close + fence.length;
      continue;
    }
    if (src[i] === "*") {
      return { start: i, len: /^\*+/.exec(src.slice(i))[0].length };
    }
    i += 1;
  }
  return null;
}

/** The next `*` run of at least two, i.e. a candidate `**` closer. */
function findStrongClose(src, from) {
  let i = from;
  for (;;) {
    const run = findStarRun(src, i);
    if (!run) return null;
    if (run.len >= 2) return run;
    i = run.start + run.len;
  }
}

/** The next lone `*`, i.e. a candidate `*` closer. Runs of two or more belong to a `**` pair. */
function findEmphasisClose(src, from) {
  let i = from;
  for (;;) {
    const run = findStarRun(src, i);
    if (!run) return null;
    if (run.len === 1) return run;
    i = run.start + run.len;
  }
}

/**
 * Render one span of inline markdown. `ctx` carries the resolvers the link/image forms need
 * (which file we are in, so a bad figure reference can name it).
 */
function renderInline(src, ctx) {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const rest = src.slice(i);

    // backslash escape
    if (src[i] === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(src[i + 1])) {
      out += escapeText(src[i + 1]);
      i += 2;
      continue;
    }

    // code span — matched by backtick-run length, so `` ` `` works
    if (src[i] === "`") {
      const fence = /^`+/.exec(rest)[0];
      const close = src.indexOf(fence, i + fence.length);
      if (close !== -1) {
        let code = src.slice(i + fence.length, close);
        if (/^ .* $/.test(code) && code.trim() !== "") code = code.slice(1, -1);
        out += `<code>${escapeText(code)}</code>`;
        i = close + fence.length;
        continue;
      }
    }

    // image
    if (rest.startsWith("![")) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (m) {
        out += renderImage(m[1], m[2], ctx);
        i += m[0].length;
        continue;
      }
    }

    // link
    if (src[i] === "[") {
      const close = src.indexOf("]", i);
      if (close !== -1 && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end !== -1) {
          const text = src.slice(i + 1, close);
          const target = src.slice(close + 2, end).trim();
          out += renderLink(text, target, ctx);
          i = end + 1;
          continue;
        }
      }
    }

    // strong. The closer is the LAST two asterisks of the run that ends it, so any asterisks
    // ahead of them stay with the inner span and close an emphasis opened inside it.
    if (rest.startsWith("**")) {
      const close = findStrongClose(src, i + 2);
      if (close) {
        const inner = src.slice(i + 2, close.start + close.len - 2);
        out += `<strong>${renderInline(inner, ctx)}</strong>`;
        i = close.start + close.len;
        continue;
      }
    }

    // emphasis — `*` only. `_` is a literal here on purpose (see the file header).
    if (src[i] === "*" && !rest.startsWith("**")) {
      const close = findEmphasisClose(src, i + 1);
      if (close && close.start > i + 1) {
        out += `<em>${renderInline(src.slice(i + 1, close.start), ctx)}</em>`;
        i = close.start + 1;
        continue;
      }
    }

    out += escapeText(src[i]);
    i += 1;
  }

  return out;
}

/**
 * Resolve a markdown link target to something that works inside the single page.
 *  - `NN-name.md` → the chapter's section anchor
 *  - `README.md`  → the front page
 *  - absolute http(s) → left alone, with rel="noopener noreferrer"
 * Anything else relative is a rot signal: it is reported and left as written, because
 * `manual.html` sits beside its sources and a sibling path still resolves from there.
 */
function renderLink(text, target, ctx) {
  const inner = renderInline(text, ctx);
  let href = target;

  if (/^https?:\/\//i.test(target)) {
    return `<a href="${escapeAttr(target)}" rel="noopener noreferrer">${inner}</a>`;
  }
  if (target.startsWith("#")) {
    return `<a href="${escapeAttr(target)}">${inner}</a>`;
  }
  if (target === README) {
    href = "#top";
  } else {
    const chapter = ctx.chapterAnchorFor(target);
    if (chapter) {
      href = chapter;
    } else {
      warn(`${ctx.file}: link to "${target}" is not a chapter or README — left as a relative path`);
    }
  }
  return `<a href="${escapeAttr(href)}">${inner}</a>`;
}

/** Read a PNG's intrinsic size out of its IHDR. Returns null for anything that is not a PNG. */
function pngSize(buf) {
  const SIGNATURE = "89504e470d0a1a0a";
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== SIGNATURE) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const imageCache = new Map();

/**
 * Inline one image as a `data:` URI. A reference that does not resolve is a BUILD ERROR, not a
 * broken `<img>`: two dead figure references were found by hand earlier in this project, and
 * catching the third automatically is the reason this script exists.
 */
function renderImage(alt, src, ctx) {
  if (/^(https?:)?\/\//i.test(src)) {
    fail(`${ctx.file}: figure "${alt}" points at a remote URL (${src}) — the page must be self-contained`);
    return "";
  }

  const rel = src.replace(/^\.\//, "");
  const abs = path.resolve(MANUAL_DIR, rel);
  if (!abs.startsWith(MANUAL_DIR + path.sep)) {
    fail(`${ctx.file}: figure "${alt}" points outside docs/manual (${src})`);
    return "";
  }

  let entry = imageCache.get(abs);
  if (!entry) {
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      fail(`${ctx.file}: figure "${alt}" has an unsupported image type (${src})`);
      return "";
    }
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      fail(`${ctx.file}: figure "${alt}" references ${src}, which does not exist`);
      return "";
    }
    if (buf.length === 0) {
      fail(`${ctx.file}: figure "${alt}" references ${src}, which is empty`);
      return "";
    }
    const size = pngSize(buf);
    if (!size && ext === ".png") {
      fail(`${ctx.file}: figure "${alt}" references ${src}, which is not a readable PNG`);
      return "";
    }
    entry = { uri: `data:${mime};base64,${buf.toString("base64")}`, size, rel };
    imageCache.set(abs, entry);
  }
  ctx.usedImages.add(entry.rel);

  const dims = entry.size
    ? ` width="${displayPx(entry.size.width)}" height="${displayPx(entry.size.height)}"`
    : "";
  return `<img src="${entry.uri}" alt="${escapeAttr(alt)}"${dims} loading="lazy" decoding="async">`;
}

// ---------------------------------------------------------------------------
// block markdown
// ---------------------------------------------------------------------------

const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_BULLET = /^(\s*)([-*+])\s+(.*)$/;
const RE_ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
/** `|---|---|` — the row under a pipe table's header. Every cell must be dashes, optionally colon-anchored. */
function isTableDivider(line) {
  if (typeof line !== "string") return false;
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

const startsBlock = (line) =>
  line.trim() === "" ||
  RE_HEADING.test(line) ||
  RE_HR.test(line) ||
  RE_FENCE.test(line) ||
  RE_QUOTE.test(line) ||
  RE_BULLET.test(line) ||
  RE_ORDERED.test(line) ||
  line.trimStart().startsWith("|");

/** Parse a list of source lines into a flat array of block objects. */
function parseBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of file)
      blocks.push({ type: "code", lang: fence[2], body });
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (line.trimStart().startsWith("|") && isTableDivider(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(lines[i]);
        i += 1;
      }
      blocks.push(parseTable(rows));
      continue;
    }

    if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      warn(`a "|" line is not part of a well-formed table (missing the |---|---| row): ${line.trim()}`);
    }

    // do/while, not while: the line that got here already failed startsBlock's siblings, and a
    // zero-length paragraph would spin forever.
    const text = [];
    do {
      text.push(lines[i].trim());
      i += 1;
    } while (i < lines.length && !startsBlock(lines[i]));
    const joined = text.join(" ");
    const figure = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(joined);
    if (figure) blocks.push({ type: "figure", alt: figure[1], src: figure[2] });
    else blocks.push({ type: "paragraph", text: joined });
  }

  return blocks;
}

function splitRow(row) {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function parseTable(rows) {
  const header = splitRow(rows[0]);
  const align = splitRow(rows[1]).map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const body = rows.slice(2).map(splitRow);
  const columns = Math.max(header.length, ...body.map((r) => r.length), 1);
  const pad = (cells) => Array.from({ length: columns }, (_, n) => cells[n] ?? "");
  // A header row whose cells are all empty is the manual's "label table" form: chapter 6's credit
  // memo facts and chapter 12's action/reference grids. It renders without a <thead>.
  const headed = header.some((c) => c !== "");
  return { type: "table", headed, header: pad(header), align, rows: body.map(pad) };
}

const indentWidth = (s) => s.replace(/\t/g, "    ").length;

/** Parse one list starting at `start`. Returns [block, indexAfter]. */
function parseList(lines, start) {
  const first = RE_ORDERED.exec(lines[start]) ?? RE_BULLET.exec(lines[start]);
  const ordered = RE_ORDERED.test(lines[start]);
  const baseIndent = indentWidth(first[1]);
  const startNumber = ordered ? Number(first[2]) : 1;

  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      // A blank line continues the list only if what follows is indented into the current item.
      const next = lines[i + 1];
      if (next === undefined || next.trim() === "") break;
      if (indentWidth(/^\s*/.exec(next)[0]) < baseIndent + 2) break;
      items[items.length - 1]?.lines.push("");
      i += 1;
      continue;
    }

    const bullet = RE_BULLET.exec(line);
    const numbered = RE_ORDERED.exec(line);
    const marker = numbered ?? bullet;
    const markerIndent = marker ? indentWidth(marker[1]) : Infinity;

    if (marker && markerIndent === baseIndent) {
      if (Boolean(numbered) !== ordered) break; // a different list starts here
      items.push({ lines: [marker[3]] });
      i += 1;
      continue;
    }

    if (items.length > 0 && indentWidth(/^\s*/.exec(line)[0]) >= baseIndent + 2) {
      items[items.length - 1].lines.push(line.slice(baseIndent + 2));
      i += 1;
      continue;
    }

    break;
  }

  return [
    { type: "list", ordered, start: startNumber, items: items.map((it) => parseBlocks(it.lines)) },
    i,
  ];
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, ctx) {
  return blocks.map((b) => renderBlock(b, ctx)).filter((s) => s !== "");
}

function renderBlock(block, ctx) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, block.level + ctx.headingShift);
      const text = renderInline(block.text, ctx);
      const id = ctx.anchor(slugify(block.text));
      return `<h${level} id="${escapeAttr(id)}">${text}</h${level}>`;
    }
    case "paragraph":
      return `<p>${renderInline(block.text, ctx)}</p>`;
    case "figure": {
      const img = renderImage(block.alt, block.src, ctx);
      if (img === "") return "";
      return `<figure>${img}<figcaption>${renderInline(block.alt, ctx)}</figcaption></figure>`;
    }
    case "hr":
      return "<hr>";
    case "quote":
      return `<blockquote>${renderBlocks(block.blocks, ctx).join("\n")}</blockquote>`;
    case "code": {
      const lang = block.lang ? ` class="language-${escapeAttr(block.lang)}"` : "";
      return `<div class="code-scroll"><pre><code${lang}>${escapeText(block.body.join("\n"))}\n</code></pre></div>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const startAttr = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      // Tight rendering, matching the manual's existing look: an item's leading paragraph is the
      // item's own text, not a <p> inside it, so a nested list reads `<li>text<ul>…</ul></li>`.
      const items = block.items
        .map((itemBlocks) => {
          const inner = itemBlocks
            .map((b, n) =>
              n === 0 && b.type === "paragraph" ? renderInline(b.text, ctx) : renderBlock(b, ctx),
            )
            .join("");
          return `<li>${inner}</li>`;
        })
        .join("");
      return `<${tag}${startAttr}>${items}</${tag}>`;
    }
    case "table": {
      const cell = (tag, text, n) => {
        const a = block.align[n];
        const style = a ? ` style="text-align:${a}"` : "";
        return `<${tag}${style}>${renderInline(text, ctx)}</${tag}>`;
      };
      const head = block.headed
        ? `<thead><tr>${block.header.map((c, n) => cell("th", c, n)).join("")}</tr></thead>`
        : "";
      // An all-empty header row is discarded either way: it labels nothing.
      const body = `<tbody>${block.rows
        .map((r) => `<tr>${r.map((c, n) => cell("td", c, n)).join("")}</tr>`)
        .join("")}</tbody>`;
      // The scroller is what keeps a wide table off the page's own horizontal axis.
      return `<div class="table-scroll"><table>${head}${body}</table></div>`;
    }
    default:
      fail(`internal: unknown block type ${block.type}`);
      return "";
  }
}

// ---------------------------------------------------------------------------
// source loading
// ---------------------------------------------------------------------------

const read = (file) => readFileSync(path.join(MANUAL_DIR, file), "utf8").replace(/\r\n/g, "\n");

/**
 * Everything after a source file's final `---` is navigation ("Next: … Previous: …") or the
 * README's maintainer notes, and belongs to the per-file reading experience, not to the one-page
 * build. Dropping it is a rule, not a hand-list — but a `---` that turns out to be sitting above
 * real content is a build error rather than a silent amputation.
 */
function stripBackMatter(blocks, file) {
  const last = blocks.map((b) => b.type).lastIndexOf("hr");
  if (last === -1) return blocks;

  const tail = blocks.slice(last + 1);
  const bad = backMatterViolation(tail, file);
  if (bad) {
    fail(`${file}: the content after the final "---" is not back matter — ${bad}`);
    return blocks;
  }
  return blocks.slice(0, last);
}

/**
 * One nav line: an optional "Next:"/"Previous:" label and a link, repeated, separated by "·".
 * Matches every chapter tail in the manual today, e.g.
 *   Next: [2. Orders →](02-orders.md)
 *   Previous: [13. Document templates](13-templates.md) · [← Back to contents](README.md)
 */
const NAV_LINE =
  /^(?:(?:Next|Previous):\s*)?\[[^\]]+\]\([^)]+\)(?:\s*·\s*(?:(?:Next|Previous):\s*)?\[[^\]]+\]\([^)]+\))*$/;

/**
 * Returns a reason string when the tail is NOT recognisable back matter, or null when it is.
 *
 * This is a POSITIVE rule — "back matter looks exactly like this" — and that is the point (Codex
 * rounds 3, 5 and 6). It replaces a negative one: "no structural block, and under 1200 characters".
 * That heuristic was wrong three times in the same way. It first let a trailing LIST be deleted
 * silently, then — after `list` was added to the forbidden set — a short trailing PARAGRAPH, which
 * is the ordinary way someone appends a closing note. Enumerating what must not appear can only
 * ever be as complete as the last review; stating what MAY appear cannot rot, because anything
 * unrecognised fails loudly by default. The size cap is gone with it: shape decides now, so a cap
 * would only be a second, weaker opinion about the same question.
 */
function backMatterViolation(tail, file) {
  if (tail.length === 0) return null;

  if (file === README) {
    // README's back matter is maintainer-facing supporting material: an italic lead-in paragraph
    // and a list of italic links. Recognised by that lead-in, so real instructions appended here
    // still fail rather than vanishing.
    const [lead, ...rest] = tail;
    if (lead.type !== "paragraph" || !/^\*Supporting material\b/.test(lead.text.trim())) {
      return `README's back matter must open with the italic "*Supporting material…" line, found a ${lead.type}`;
    }
    const offender = rest.find((b) => b.type !== "list" && b.type !== "paragraph");
    return offender ? `README's supporting material may only be paragraphs and lists, found a ${offender.type}` : null;
  }

  const offender = tail.find((b) => b.type !== "paragraph" || !NAV_LINE.test(b.text.trim()));
  return offender
    ? offender.type !== "paragraph"
      ? `a ${offender.type} is content, not navigation`
      : `"${offender.text.trim().slice(0, 60)}…" is not a Next/Previous navigation line`
    : null;
}

/** Drop the standalone "[← Back to contents](README.md)" paragraph each chapter opens with. */
const isContentsNav = (block) =>
  block.type === "paragraph" && /^\[[^\]]*\]\(README\.md\)$/.test(block.text.trim());

function loadChapters() {
  const files = readdirSync(MANUAL_DIR)
    .filter((f) => /^\d{2}-.+\.md$/.test(f))
    .sort();

  if (files.length === 0) fail("no NN-*.md chapters found in docs/manual");

  return files.map((file) => {
    const blocks = stripBackMatter(parseBlocks(read(file).split("\n")), file);
    const head = blocks[0];
    if (!head || head.type !== "heading" || head.level !== 1) {
      fail(`${file}: does not open with a level-1 heading`);
      return null;
    }
    const number = Number(file.slice(0, 2));
    const titled = /^\s*(\d+)\.\s+(.*)$/.exec(head.text);
    if (!titled) {
      fail(`${file}: the title "${head.text}" is not of the form "N. Title"`);
      return null;
    }
    if (Number(titled[1]) !== number) {
      fail(`${file}: titled "${head.text}" but the filename says chapter ${number}`);
      return null;
    }
    const body = blocks.slice(1).filter((b) => !isContentsNav(b));
    return { file, number, title: titled[2], blocks: body };
  });
}

/** The contents table in README.md, as [{ number, file, title }]. */
function readmeContents(frontBlocks) {
  const rows = [];
  for (const block of frontBlocks) {
    if (block.type !== "table") continue;
    for (const row of block.rows) {
      const link = /^\[([^\]]+)\]\((\d{2}-[^)]+\.md)\)$/.exec(row[1]?.trim() ?? "");
      if (link && /^\d+$/.test(row[0]?.trim() ?? "")) {
        rows.push({ number: Number(row[0].trim()), file: link[2], title: link[1] });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

const CSS = String.raw`<style>
:root{
  --bg:#ffffff;
  --surface:#f7f8fa;
  --surface-2:#eef1f5;
  --text:#1b1f24;
  --text-soft:#3d444d;
  --muted:#5d666f;
  --border:#d7dce2;
  --border-soft:#e6eaef;
  --rule:#c3cad3;
  --accent:#0d4a8f;
  --accent-soft:#e8f0fa;
  --quote-bg:#f5f7fa;
  --quote-bar:#0d4a8f;
  --code-bg:#eef1f5;
  --code-text:#0f3d6e;
  --th-bg:#eef1f5;
  --stripe:#fafbfc;
  --figure-bg:#f2f4f7;
  --nav-bg:#f7f8fa;
  --shadow:0 1px 2px rgba(16,24,40,.06);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#14171c;
    --surface:#1b1f26;
    --surface-2:#232830;
    --text:#e6e9ee;
    --text-soft:#c9cfd8;
    --muted:#98a2af;
    --border:#333a45;
    --border-soft:#272d36;
    --rule:#3c4450;
    --accent:#79b3f0;
    --accent-soft:#1c2b3d;
    --quote-bg:#1b222c;
    --quote-bar:#79b3f0;
    --code-bg:#232a34;
    --code-text:#9ecbff;
    --th-bg:#232830;
    --stripe:#181c22;
    --figure-bg:#1b1f26;
    --nav-bg:#171b21;
    --shadow:0 1px 2px rgba(0,0,0,.5);
  }
}
:root[data-theme="dark"]{
  --bg:#14171c;
  --surface:#1b1f26;
  --surface-2:#232830;
  --text:#e6e9ee;
  --text-soft:#c9cfd8;
  --muted:#98a2af;
  --border:#333a45;
  --border-soft:#272d36;
  --rule:#3c4450;
  --accent:#79b3f0;
  --accent-soft:#1c2b3d;
  --quote-bg:#1b222c;
  --quote-bar:#79b3f0;
  --code-bg:#232a34;
  --code-text:#9ecbff;
  --th-bg:#232830;
  --stripe:#181c22;
  --figure-bg:#1b1f26;
  --nav-bg:#171b21;
  --shadow:0 1px 2px rgba(0,0,0,.5);
}

*,*::before,*::after{box-sizing:border-box}

body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:17px;
  line-height:1.62;
  -webkit-text-size-adjust:100%;
  overflow-x:hidden;
}

.layout{
  display:grid;
  grid-template-columns:1fr;
  gap:0;
  max-width:84rem;
  margin:0 auto;
  padding:0 1.25rem;
}

/* ---- navigation ---- */
.toc{
  background:var(--nav-bg);
  border:1px solid var(--border-soft);
  border-radius:8px;
  padding:1rem 1.1rem;
  margin:1.25rem 0 0;
  max-height:60vh;
  overflow-y:auto;
}
.toc h2{
  font-size:.72rem;
  letter-spacing:.09em;
  text-transform:uppercase;
  color:var(--muted);
  margin:0 0 .6rem;
  font-weight:700;
  border:0;
  padding:0;
}
.toc ol{list-style:none;margin:0;padding:0}
.toc ul{list-style:none;margin:.15rem 0 .5rem;padding:0 0 0 1.85rem}
.toc li{margin:0}
.toc a{
  display:block;
  padding:.22rem .3rem;
  color:var(--text-soft);
  text-decoration:none;
  border-radius:4px;
  line-height:1.35;
}
.toc a:hover{background:var(--surface-2);color:var(--accent)}
.toc .toc-ch{
  display:flex;
  gap:.6rem;
  font-weight:600;
  color:var(--text);
  margin-top:.3rem;
  font-size:.95rem;
}
.toc .toc-num{
  flex:0 0 1.25rem;
  text-align:right;
  color:var(--muted);
  font-variant-numeric:tabular-nums;
}
.toc ul a{font-size:.86rem;color:var(--muted)}

/* ---- content ---- */
.content{
  min-width:0;
  max-width:50rem;
  padding:1.5rem 0 4rem;
}

h1,h2,h3,h4{line-height:1.25;font-weight:700;color:var(--text)}
h1{
  font-size:2.1rem;
  margin:.6rem 0 .75rem;
  letter-spacing:-.015em;
}
.content>section>h2,h2{font-size:1.4rem;margin:2.4rem 0 .7rem}
h3{font-size:1.13rem;margin:1.9rem 0 .5rem}
h4{font-size:1rem;margin:1.5rem 0 .4rem;color:var(--text-soft)}

p{margin:0 0 1rem}
a{color:var(--accent)}
a:hover{text-decoration:none}

ul,ol{margin:0 0 1.1rem;padding-left:1.4rem}
li{margin:0 0 .45rem}
li>ul,li>ol{margin-top:.45rem}

strong{font-weight:650;color:var(--text)}
em{font-style:italic}

code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  font-size:.88em;
  background:var(--code-bg);
  color:var(--code-text);
  padding:.1em .35em;
  border-radius:4px;
  overflow-wrap:break-word;
}

/* Fenced code: the scroller keeps a long line off the page's own horizontal axis. */
.code-scroll{
  overflow-x:auto;
  margin:1.25rem 0 1.5rem;
  background:var(--code-bg);
  border:1px solid var(--border-soft);
  border-radius:6px;
  -webkit-overflow-scrolling:touch;
}
.code-scroll pre{margin:0;padding:.85rem 1.1rem}
.code-scroll code{
  display:block;
  background:none;
  padding:0;
  white-space:pre;
  overflow-wrap:normal;
  font-size:.86rem;
  line-height:1.5;
}

hr{
  border:0;
  border-top:1px solid var(--rule);
  margin:2.25rem 0;
}

blockquote{
  margin:1.25rem 0;
  padding:.85rem 1.1rem;
  background:var(--quote-bg);
  border-left:3px solid var(--quote-bar);
  border-radius:0 6px 6px 0;
}
blockquote>*:last-child{margin-bottom:0}

/* ---- tables ---- */
.table-scroll{
  overflow-x:auto;
  margin:1.25rem 0 1.5rem;
  border:1px solid var(--border);
  border-radius:6px;
  -webkit-overflow-scrolling:touch;
}
table{
  border-collapse:collapse;
  width:100%;
  font-size:.94rem;
  background:var(--bg);
}
th,td{
  text-align:left;
  vertical-align:top;
  padding:.55rem .8rem;
  border-bottom:1px solid var(--border-soft);
}
th{
  background:var(--th-bg);
  font-weight:650;
  white-space:nowrap;
  border-bottom:1px solid var(--border);
}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even){background:var(--stripe)}
td code{white-space:nowrap}

/* ---- figures ---- */
figure{
  margin:1.6rem 0;
}
figure img{
  display:block;
  max-width:100%;
  height:auto;
  border:1px solid var(--border);
  border-radius:6px;
  background:var(--figure-bg);
  box-shadow:var(--shadow);
}
figcaption{
  margin-top:.5rem;
  font-size:.85rem;
  color:var(--muted);
  line-height:1.45;
}

/* ---- chapters ---- */
.front{padding-bottom:.5rem}
.chapter{
  border-top:1px solid var(--rule);
  padding-top:2rem;
  margin-top:2.75rem;
}
.chapter-head{margin:0 0 1.4rem}
.eyebrow{
  margin:0 0 .2rem;
  font-size:.74rem;
  letter-spacing:.11em;
  text-transform:uppercase;
  font-weight:700;
  color:var(--accent);
}
h2.chapter-title{
  font-size:1.85rem;
  margin:0;
  letter-spacing:-.012em;
}
.to-top{
  margin:2rem 0 0;
  font-size:.82rem;
}
.to-top a{color:var(--muted);text-decoration:none}
.to-top a:hover{color:var(--accent);text-decoration:underline}

.page-foot{
  margin-top:3rem;
  padding-top:1.25rem;
  border-top:1px solid var(--rule);
  font-size:.86rem;
  color:var(--muted);
}
.page-foot code{font-size:.85em}

/* ---- wide screens: sticky sidebar ---- */
@media (min-width:62rem){
  .layout{
    grid-template-columns:17.5rem minmax(0,1fr);
    gap:2.5rem;
    padding:0 2rem;
  }
  .toc{
    position:sticky;
    top:1.25rem;
    align-self:start;
    max-height:calc(100vh - 2.5rem);
    margin:1.25rem 0 2rem;
  }
  .content{padding-top:1.5rem}
}

/* ---- print ---- */
@media print{
  body{background:#fff;color:#000;font-size:10.5pt}
  .toc,.to-top{display:none}
  .layout{display:block;max-width:none;padding:0}
  .content{max-width:none}
  .chapter{break-before:page;border-top:0;margin-top:0;padding-top:0}
  h1,h2,h3,h4{break-after:avoid}
  figure,.table-scroll,blockquote{break-inside:avoid}
  .table-scroll{overflow:visible}
  figure img{max-width:100%;box-shadow:none}
  a{color:#000;text-decoration:underline}
}
</style>`;

function build() {
  const chapters = loadChapters().filter(Boolean);
  const byFile = new Map(chapters.map((c) => [c.file, c]));
  const usedImages = new Set();

  const chapterAnchorFor = (target) => {
    const chapter = byFile.get(target.replace(/^\.\//, ""));
    return chapter ? `#ch-${chapter.number}` : null;
  };

  const makeCtx = (file, prefix, headingShift) => {
    const seen = new Map();
    return {
      file,
      headingShift,
      usedImages,
      chapterAnchorFor,
      anchor(base) {
        const key = base || "section";
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        return n === 1 ? `${prefix}-${key}` : `${prefix}-${key}-${n}`;
      },
    };
  };

  // ---- front page, from README.md -----------------------------------------
  const frontBlocks = stripBackMatter(parseBlocks(read(README).split("\n")), README);
  const contents = readmeContents(frontBlocks);

  // The chapter order is derived twice — from the filenames and from README's contents table —
  // and the two must agree. That disagreement is how a new chapter goes missing from the manual.
  //
  // Compared IN ORDER, not as sorted sets (Codex round 4). Sorting both sides first made this
  // check blind to the very thing its name claims to validate: a README row moved out of sequence
  // still passed, and the manual then shipped TWO conflicting chapter orders — README's on the
  // front page, filename order in the sidebar and the bodies. The sorted copies survive only to
  // tell the two failures apart in the message, which is a genuinely useful distinction: "you
  // reordered a row" and "you added a chapter and forgot the contents table" want different fixes.
  const key = (c) => `${c.number}|${c.file}|${c.title}`;
  const listed = contents.map(key);
  const found = chapters.map(key);
  if (listed.join("\n") !== found.join("\n")) {
    const sameSet = [...listed].sort().join("\n") === [...found].sort().join("\n");
    fail(
      sameSet
        ? `README.md's contents table lists the same chapters as the NN-*.md files but in a ` +
          `DIFFERENT ORDER, which would publish two conflicting sequences.\n` +
          `        README order: ${listed.join(", ")}\n` +
          `        file order:   ${found.join(", ")}`
        : `README.md's contents table and the NN-*.md files disagree.\n` +
          `        README lists: ${listed.join(", ") || "(none)"}\n` +
          `        on disk:      ${found.join(", ")}`,
    );
  }
  chapters.forEach((c, n) => {
    if (c.number !== n + 1) fail(`chapter numbers are not 1..N — found ${c.number} at position ${n + 1}`);
  });

  const frontCtx = makeCtx(README, "front", 0);
  const front = renderBlocks(frontBlocks, frontCtx);

  // ---- chapters ------------------------------------------------------------
  const chapterHtml = [];
  const tocEntries = [];

  for (const chapter of chapters) {
    const prefix = `ch-${chapter.number}`;
    const ctx = makeCtx(chapter.file, prefix, 1);
    const subs = [];

    // The TOC lists the chapter's level-2 headings. Collect the anchors as they are rendered so
    // the nav and the body can never disagree about an id.
    const rendered = chapter.blocks.map((block) => {
      const html = renderBlock(block, ctx);
      if (block.type === "heading" && block.level === 2) {
        const id = /id="([^"]*)"/.exec(html)?.[1] ?? "";
        subs.push({ id, text: renderInline(block.text, ctx) });
      }
      return html;
    });

    chapterHtml.push(
      [
        `<section class="chapter" id="${prefix}">`,
        `<header class="chapter-head"><p class="eyebrow">Chapter ${chapter.number}</p>` +
          `<h2 class="chapter-title">${renderInline(chapter.title, ctx)}</h2></header>`,
        ...rendered.filter((s) => s !== ""),
        `<p class="to-top"><a href="#top">Back to contents</a></p>`,
        `</section>`,
      ].join("\n"),
    );

    const subList = subs.length
      ? `<ul>${subs.map((s) => `<li><a href="#${escapeAttr(s.id)}">${s.text}</a></li>`).join("")}</ul>`
      : "";
    tocEntries.push(
      `<li><a class="toc-ch" href="#${prefix}"><span class="toc-num">${chapter.number}</span>` +
        `<span>${renderInline(chapter.title, ctx)}</span></a>${subList}</li>`,
    );
  }

  // ---- footer --------------------------------------------------------------
  const support = ["dataset.md", "sweep.md", "walkthrough.md"];
  const footer = [
    `<footer class="page-foot">`,
    `<p><strong>HeatSynQ user manual.</strong> Contents page and chapters 1&ndash;${chapters.length}, as one page.`,
    `Built from the chapter sources in <code>docs/manual/</code> in the repository.</p>`,
    `<p>Three supporting documents are kept alongside those sources for whoever maintains the`,
    `system rather than uses it, and are not reproduced here:`,
    `<code>${support[0]}</code> (the demonstration data these screenshots were taken against, and how`,
    `to rebuild it), <code>${support[1]}</code> (the automated health check across every screen) and`,
    `<code>${support[2]}</code> (what was verified working, what was filed, and what was checked`,
    `and cleared). Look for them in <code>docs/manual/</code>.</p>`,
    `</footer>`,
  ].join("\n");

  // ---- provenance ----------------------------------------------------------
  // Derived from the SOURCES, never from the clock — a no-op rebuild must be a no-op diff.
  const digest = createHash("sha256");
  const inputs = [README, ...chapters.map((c) => c.file), ...[...usedImages].sort()];
  for (const rel of inputs) {
    digest.update(rel);
    digest.update("\0");
    digest.update(readFileSync(path.join(MANUAL_DIR, rel)));
    digest.update("\0");
  }
  const sourceDigest = digest.digest("hex").slice(0, 16);

  const html = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<!-- Generated by erp/scripts/build-manual.mjs from docs/manual/*.md — do not edit by hand.`,
    `     Rebuild with: cd erp && npm run manual:build`,
    `     Sources: ${inputs.length} files, digest ${sourceDigest} -->`,
    `<title>${escapeText(PAGE_TITLE)}</title>`,
    CSS,
    `<div class="layout">`,
    `<nav class="toc" aria-label="Contents">`,
    `<h2>Contents</h2>`,
    `<ol>`,
    `<li><a class="toc-ch" href="#top"><span class="toc-num">&mdash;</span><span>Front page</span></a></li>`,
    tocEntries.join(""),
    `</ol>`,
    `</nav>`,
    `<main class="content">`,
    `<section class="front" id="top">`,
    ...front,
    `</section>`,
    ``,
    chapterHtml.join("\n\n"),
    footer,
    `</main>`,
    `</div>`,
  ].join("\n");

  return { html, chapters, usedImages, figureCount: countFigures(html) };
}

const countFigures = (html) => (html.match(/<figure>/g) ?? []).length;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const result = build();

const onDisk = readdirSync(IMG_DIR).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
const unused = onDisk.filter((f) => !result.usedImages.has(`img/${f}`)).sort();

if (problems.length > 0) {
  console.error(`\nmanual:build FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

writeFileSync(OUT_FILE, result.html + "\n");

const bytes = Buffer.byteLength(result.html) + 1;
console.log(`manual:build → ${path.relative(process.cwd(), OUT_FILE)}`);
console.log(
  `  ${result.chapters.length} chapters · ${result.figureCount} figures ` +
    `(${result.usedImages.size} distinct images) · ${(bytes / 1024 / 1024).toFixed(2)} MB`,
);
if (unused.length > 0) {
  console.log(`  note: ${unused.length} captured screenshot(s) no chapter references: ${unused.join(", ")}`);
}
for (const w of warnings) console.log(`  warning: ${w}`);

// ---------------------------------------------------------------------------------------------
// The publishing ceiling (#169). A rendered page above PUBLISH_LIMIT cannot be published as a
// shareable artifact at all, and the failure is invisible from here — you find out at publish
// time, with no clue why. So the build states it.
//
// This is a REAL cliff today, not a theoretical one: `manual:capture` writes 2x PNGs (~24 MB of
// screenshots), and the committed `img/` is roughly half that only because it was compressed by
// hand with an external `magick` call that exists nowhere in this repository. Follow the
// documented capture -> build workflow on a fresh checkout and the output lands near 28 MB.
//
// It WARNS at the soft threshold rather than only failing at the hard one, because the useful
// moment to hear about this is while there is still headroom to spend, not after a chapter has
// been written against figures that cannot ship.
// ---------------------------------------------------------------------------------------------
const PUBLISH_LIMIT = 16 * 1024 * 1024;
const SOFT_LIMIT = Math.floor(PUBLISH_LIMIT * 0.85);
const asMb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

if (bytes > PUBLISH_LIMIT) {
  console.error("");
  console.error(`ERROR: ${asMb(bytes)} exceeds the ${asMb(PUBLISH_LIMIT)} publishing ceiling.`);
  console.error("The page was still written, but it cannot be published as a shareable artifact.");
  console.error("");
  console.error("Almost certainly the screenshots: `manual:capture` writes 2x PNGs and the");
  console.error("committed ones were reduced by an external step that is not in this repo (#169).");
  console.error("Shrink docs/manual/img/ — or fix the capture scale, which is the real fix.");
  console.error("");
  process.exit(1);
}
if (bytes > SOFT_LIMIT) {
  console.log(
    `  warning: ${asMb(bytes)} of the ${asMb(PUBLISH_LIMIT)} publishing ceiling ` +
      `(${asMb(PUBLISH_LIMIT - bytes)} left — see #169 before adding figures)`,
  );
}
