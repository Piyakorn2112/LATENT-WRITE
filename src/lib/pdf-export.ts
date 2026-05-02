import type { Novel } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CSS string literal: only escape backslashes and double quotes.
function cssStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Approximate words per printed page at 12pt Georgia on US Letter with the
// reduced margins below (~0.7in). Letter pages hold roughly 1.6× a 6×9 page.
const WORDS_PER_PAGE = 430;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Paragraph renderer ────────────────────────────────────────────────────

const SCENE_BREAK_RE = /^[\s\*\-—#~=|]{3,}$/;

function renderBody(content: string): string {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let noIndentNext = true;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      chunks.push('<div class="scene-gap"></div>');
      noIndentNext = true;
      continue;
    }

    if (SCENE_BREAK_RE.test(line.trim())) {
      chunks.push('<p class="scene-break">*&#8195;&#8195;*&#8195;&#8195;*</p>');
      noIndentNext = true;
      continue;
    }

    const cls = noIndentNext ? ' class="no-indent"' : "";
    chunks.push(`<p${cls}>${esc(line)}</p>`);
    noIndentNext = false;
  }

  return chunks.join("\n");
}

// ── TOC ───────────────────────────────────────────────────────────────────

function buildToc(novel: Novel): string {
  const { chapters } = novel;

  // Front-matter budget: cover(1) + TOC(1) ≈ 2 pages before chapters start.
  let pg = 3;
  const pageStarts: number[] = [];
  for (const ch of chapters) {
    pageStarts.push(pg);
    pg += 1; // chapter title page
    pg += Math.max(1, Math.ceil(wordCount(ch.content) / WORDS_PER_PAGE));
  }

  const rows = chapters
    .map((ch, i) => {
      const label = ch.title ? esc(ch.title) : `Chapter ${ch.number}`;
      return `<div class="toc-row">
        <span class="toc-num">${ch.number}.</span>
        <span class="toc-label">${label}</span>
        <span class="toc-dots"></span>
        <span class="toc-pg">${pageStarts[i]}</span>
      </div>`;
    })
    .join("\n");

  return `
<section class="toc-page">
  <h2 class="toc-heading">Contents</h2>
  <div class="toc-list">${rows}</div>
</section>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────
//
// Design notes for a reliable Chromium print render:
// • No flexbox + 100vh on full-page elements — that combination collapses
//   to 0 height in printToPDF. Use padding + page breaks instead.
// • All fonts are system fallbacks; no @font-face that could fail to load.
// • @page named pages + `page: name` for per-section margin boxes
//   (supported in Chromium 130+, which Electron 41 ships).
// • preferCSSPageSize must be true in printToPDF or @page { size } is ignored.

function buildCss(title: string): string {
  const t = cssStr(title);

  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body { background: #fff; color: #000; }
body {
  font-family: 'Georgia', 'Times New Roman', 'Iowan Old Style', serif;
  font-size: 12pt;
  line-height: 1.65;
}

/* Default page (body text): running header + page number — US Letter */
@page {
  size: 8.5in 11in;
  /* Narrow margins — leaves more text per page so the export feels less
     wasteful while still allowing room for the running header/footer. */
  margin: 0.7in 0.75in 0.7in 0.85in;
  @top-center {
    content: "${t}";
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 9pt;
    letter-spacing: 0.08em;
    color: #888;
  }
  @bottom-center {
    content: counter(page);
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 9pt;
    color: #666;
  }
}

/* Cover — first page, no header/footer */
@page :first {
  margin: 0.9in;
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
}

@page toc-pg {
  @top-center    { content: ""; }
  @bottom-center {
    content: counter(page);
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 9pt;
    color: #666;
  }
}

@page chapter-title-pg {
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
}

/* === Cover === */
.cover {
  /* No flex/100vh — those collapse in print. Padding + page-break instead. */
  padding-top: 4.2in;
  text-align: center;
  page-break-after: always;
  break-after: page;
}
.cover-title {
  font-size: 36pt;
  font-weight: normal;
  line-height: 1.2;
  letter-spacing: 0.02em;
  margin-bottom: 0.25in;
}
.cover-subtitle {
  font-size: 14pt;
  font-style: italic;
  font-weight: normal;
  color: #444;
  margin-bottom: 0.5in;
  line-height: 1.35;
  max-width: 5.5in;
  margin-left: auto;
  margin-right: auto;
}
.cover-rule {
  width: 2.4in;
  height: 1px;
  background: #111;
  margin: 0 auto 0.55in;
}
.cover-author {
  font-size: 14pt;
  font-weight: normal;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #333;
}

/* === TOC === */
.toc-page {
  page: toc-pg;
  page-break-after: always;
  break-after: page;
  padding-top: 0.7in;
}
.toc-heading {
  font-size: 12pt;
  font-weight: normal;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  text-align: center;
  margin-bottom: 0.5in;
}
.toc-list { width: 100%; }
.toc-row {
  display: flex;
  align-items: baseline;
  margin-bottom: 0.16in;
  font-size: 11pt;
  gap: 0.1in;
}
.toc-num { flex: 0 0 1.4em; color: #888; font-size: 10pt; }
.toc-label {
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 75%;
}
.toc-dots {
  flex: 1;
  border-bottom: 1px dotted #bbb;
  margin-bottom: 0.1em;
  min-width: 0.4in;
}
.toc-pg {
  flex: 0 0 0.5in;
  text-align: right;
  color: #555;
  font-size: 10pt;
}

/* === Chapter title page === */
.chapter-title-page {
  page: chapter-title-pg;
  padding-top: 3.4in;
  page-break-before: always;
  break-before: page;
  page-break-after: always;
  break-after: page;
}
.chapter-num-label {
  font-size: 9pt;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #888;
  margin-bottom: 0.22in;
}
.chapter-title-heading {
  font-size: 20pt;
  font-weight: normal;
  line-height: 1.25;
}

/* === Chapter body === */
.chapter-body p {
  text-indent: 1.5em;
  margin: 0;
  orphans: 2;
  widows: 2;
}
.chapter-body p.no-indent { text-indent: 0; }
.chapter-body p.scene-break {
  text-indent: 0;
  text-align: center;
  margin: 0.6em 0;
  letter-spacing: 0.3em;
  color: #666;
}
.scene-gap { height: 0.55em; }

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}

// ── Main export ───────────────────────────────────────────────────────────

export function buildNovelHtml(novel: Novel): string {
  const title = novel.meta.title || "Untitled";
  const subtitle = novel.meta.subtitle || "";
  const author = novel.meta.author || "";
  const { chapters } = novel;

  const tocHtml = buildToc(novel);

  const chaptersHtml = chapters
    .map((ch) => {
      const chTitle = ch.title || "";
      return `
<section class="chapter-title-page">
  <p class="chapter-num-label">Chapter ${ch.number}</p>
  ${chTitle ? `<h2 class="chapter-title-heading">${esc(chTitle)}</h2>` : ""}
</section>
<section class="chapter-body">
${renderBody(ch.content)}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <style>${buildCss(title)}</style>
</head>
<body>

<section class="cover">
  <h1 class="cover-title">${esc(title)}</h1>
  ${subtitle ? `<p class="cover-subtitle">${esc(subtitle)}</p>` : ""}
  <div class="cover-rule"></div>
  <p class="cover-author">${author ? esc(author) : "&nbsp;"}</p>
</section>

${tocHtml}

${chaptersHtml}

</body>
</html>`;
}

// ── Browser fallback (non-Electron) ───────────────────────────────────────
export function printNovelBrowser(novel: Novel): void {
  const html = buildNovelHtml(novel);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) {
    w.addEventListener("load", () => URL.revokeObjectURL(url));
  }
}
