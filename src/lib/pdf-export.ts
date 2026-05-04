import type { Novel } from "../types";

// ──────────────────────────────────────────────────────────────────────────
// Presets
//
// The export overlay surfaces these presets so writers can pick the page
// format ("how the book reads") independently of the paper size ("how big
// is the page"). Both are pure data — buildCss reads them and emits the
// matching @page / body CSS.
// ──────────────────────────────────────────────────────────────────────────

export type PageFormatId =
  | "classic-trade"
  | "mass-market"
  | "literary-modern"
  | "manuscript"
  | "hardcover-cloth"
  | "minimalist-indie";

export interface PageFormatPreset {
  id: PageFormatId;
  label: string;
  /** One-line subtitle shown beneath the label in the overlay card. */
  description: string;
  body: {
    fontFamily: string;
    /** Body font size in pt (number — emit as `${n}pt`). */
    fontSizePt: number;
    lineHeight: number;
    /** First-line indent in em. 0 = block paragraphs. */
    indentEm: number;
    align: "left" | "justify";
    /** Spacing between block paragraphs (only used when indentEm = 0). */
    paragraphSpacingEm: number;
  };
  /** Page margins, in inches. Applied as @page { margin } and so adapt to
   *  whatever paper size is chosen. */
  marginsIn: { top: number; right: number; bottom: number; left: number };
  cover: {
    titleSizePt: number;
    style: "classic" | "modern" | "minimal" | "manuscript";
  };
  /** Include a Contents page after the cover. */
  toc: boolean;
  /** "separate-page" gives each chapter its own title page; "inline-heading"
   *  renders the chapter label at the top of the body and skips the page
   *  break (used for manuscript). */
  chapterStyle: "separate-page" | "inline-heading";
  /** Running header content. "title-author" prints "Author / Title / #" at
   *  the top — manuscript convention. */
  runningHeader: "title" | "title-author" | "none";
  pageNumbers: "center" | "outer" | "none";
}

export type PaperSizeId =
  | "us-trade"
  | "us-letter"
  | "mass-market"
  | "us-digest"
  | "a4"
  | "a5"
  | "royal"
  | "crown";

export interface PaperSizePreset {
  id: PaperSizeId;
  label: string;
  description: string;
  /** CSS @page size value, e.g. "6in 9in" or "210mm 297mm". */
  cssSize: string;
  /** Width / height ratio for the live preview thumbnail (aspect ratio
   *  uses width:height directly). */
  widthIn: number;
  heightIn: number;
}

// Common-stack font lookup so the preset data stays terse.
const FONT_STACK = {
  georgia: `'Georgia', 'Iowan Old Style', 'Times New Roman', serif`,
  garamond: `'EB Garamond', 'Garamond', 'Adobe Garamond Pro', 'Georgia', serif`,
  iowan: `'Iowan Old Style', 'Georgia', 'Times New Roman', serif`,
  times: `'Times New Roman', 'Times', 'Liberation Serif', serif`,
  courier: `'Courier New', 'Courier', 'Liberation Mono', monospace`,
  sans: `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Inter', system-ui, sans-serif`,
} as const;

export const PAGE_FORMAT_PRESETS: PageFormatPreset[] = [
  {
    id: "classic-trade",
    label: "Classic Trade Paperback",
    description: "The default trade-paperback look — Georgia, justified, indented paragraphs.",
    body: {
      fontFamily: FONT_STACK.georgia,
      fontSizePt: 11,
      lineHeight: 1.5,
      indentEm: 1.5,
      align: "justify",
      paragraphSpacingEm: 0,
    },
    marginsIn: { top: 0.7, right: 0.75, bottom: 0.75, left: 0.85 },
    cover: { titleSizePt: 32, style: "classic" },
    toc: true,
    chapterStyle: "separate-page",
    runningHeader: "title",
    pageNumbers: "center",
  },
  {
    id: "mass-market",
    label: "Mass-Market Paperback",
    description: "Compact pulp/airport-novel feel — denser pack, smaller chapter intros.",
    body: {
      fontFamily: FONT_STACK.times,
      fontSizePt: 10,
      lineHeight: 1.35,
      indentEm: 1.3,
      align: "justify",
      paragraphSpacingEm: 0,
    },
    marginsIn: { top: 0.55, right: 0.55, bottom: 0.6, left: 0.7 },
    cover: { titleSizePt: 26, style: "classic" },
    toc: false,
    chapterStyle: "separate-page",
    runningHeader: "title",
    pageNumbers: "outer",
  },
  {
    id: "literary-modern",
    label: "Literary Modern",
    description: "Roomy single-column literary fiction — Iowan, generous leading, no running header.",
    body: {
      fontFamily: FONT_STACK.iowan,
      fontSizePt: 12,
      lineHeight: 1.7,
      indentEm: 1.4,
      align: "justify",
      paragraphSpacingEm: 0,
    },
    marginsIn: { top: 1.0, right: 1.0, bottom: 1.0, left: 1.1 },
    cover: { titleSizePt: 30, style: "minimal" },
    toc: true,
    chapterStyle: "separate-page",
    runningHeader: "none",
    pageNumbers: "center",
  },
  {
    id: "manuscript",
    label: "Manuscript Submission",
    description: "Standard agent / publisher format — Times 12pt, double-spaced, inline chapter heads.",
    body: {
      fontFamily: FONT_STACK.times,
      fontSizePt: 12,
      lineHeight: 2.0,
      indentEm: 0.5,
      align: "left",
      paragraphSpacingEm: 0,
    },
    marginsIn: { top: 1.0, right: 1.0, bottom: 1.0, left: 1.0 },
    cover: { titleSizePt: 18, style: "manuscript" },
    toc: false,
    chapterStyle: "inline-heading",
    runningHeader: "title-author",
    pageNumbers: "outer",
  },
  {
    id: "hardcover-cloth",
    label: "Hardcover Edition",
    description: "Premium hardback feel — Garamond, tighter leading, larger title pages.",
    body: {
      fontFamily: FONT_STACK.garamond,
      fontSizePt: 11,
      lineHeight: 1.45,
      indentEm: 1.6,
      align: "justify",
      paragraphSpacingEm: 0,
    },
    marginsIn: { top: 0.9, right: 0.85, bottom: 0.95, left: 1.0 },
    cover: { titleSizePt: 36, style: "classic" },
    toc: true,
    chapterStyle: "separate-page",
    runningHeader: "title-author",
    pageNumbers: "center",
  },
  {
    id: "minimalist-indie",
    label: "Minimalist Modern",
    description: "Indie / self-pub modern feel — sans body, block paragraphs, no flourish.",
    body: {
      fontFamily: FONT_STACK.sans,
      fontSizePt: 11,
      lineHeight: 1.55,
      indentEm: 0,
      align: "left",
      paragraphSpacingEm: 0.7,
    },
    marginsIn: { top: 0.85, right: 0.8, bottom: 0.85, left: 0.85 },
    cover: { titleSizePt: 28, style: "modern" },
    toc: true,
    chapterStyle: "separate-page",
    runningHeader: "none",
    pageNumbers: "outer",
  },
];

export const PAPER_SIZE_PRESETS: PaperSizePreset[] = [
  {
    id: "us-trade",
    label: "US Trade",
    description: "6 × 9 in — the dominant trade paperback size.",
    cssSize: "6in 9in",
    widthIn: 6.0,
    heightIn: 9.0,
  },
  {
    id: "us-letter",
    label: "US Letter",
    description: "8.5 × 11 in — manuscript / printer default.",
    cssSize: "8.5in 11in",
    widthIn: 8.5,
    heightIn: 11.0,
  },
  {
    id: "mass-market",
    label: "Mass Market",
    description: "4.25 × 6.87 in — pocket paperback / airport rack.",
    cssSize: "4.25in 6.87in",
    widthIn: 4.25,
    heightIn: 6.87,
  },
  {
    id: "us-digest",
    label: "US Digest",
    description: "5.5 × 8.5 in — common indie / novella size.",
    cssSize: "5.5in 8.5in",
    widthIn: 5.5,
    heightIn: 8.5,
  },
  {
    id: "a4",
    label: "A4",
    description: "210 × 297 mm — international manuscript standard.",
    cssSize: "210mm 297mm",
    widthIn: 8.27,
    heightIn: 11.69,
  },
  {
    id: "a5",
    label: "A5",
    description: "148 × 210 mm — common European trade novel size.",
    cssSize: "148mm 210mm",
    widthIn: 5.83,
    heightIn: 8.27,
  },
  {
    id: "royal",
    label: "Royal",
    description: "6.14 × 9.21 in — UK trade hardcover.",
    cssSize: "6.14in 9.21in",
    widthIn: 6.14,
    heightIn: 9.21,
  },
  {
    id: "crown",
    label: "Crown / Pocket",
    description: "5.06 × 7.81 in — pocket-format hardcover.",
    cssSize: "5.06in 7.81in",
    widthIn: 5.06,
    heightIn: 7.81,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Fonts
//
// Curated set of *macOS-bundled* fonts. The app targets macOS only (see
// electron-builder.yml — only `mac` and `mas` targets) so we can rely on
// these being installed locally and used offline without bundling any
// font files. Each entry is a CSS font-family stack with sensible
// fallbacks. Used by the cover composer's font picker and emitted into
// the PDF export HTML so the print BrowserWindow renders them identically.
// ──────────────────────────────────────────────────────────────────────────

export interface CoverFont {
  /** Stable id used in stored prefs. */
  id: string;
  /** Display label in the picker. */
  label: string;
  /** CSS font-family stack. */
  stack: string;
  /** Visual category — surfaces in the picker as a section header. */
  category: "serif" | "sans" | "display" | "mono" | "script";
}

export const COVER_FONTS: CoverFont[] = [
  // Serif
  { id: "georgia",        label: "Georgia",          stack: `'Georgia', 'Times New Roman', serif`,                            category: "serif" },
  { id: "times",          label: "Times New Roman",  stack: `'Times New Roman', 'Times', serif`,                              category: "serif" },
  { id: "iowan",          label: "Iowan Old Style",  stack: `'Iowan Old Style', 'Georgia', serif`,                            category: "serif" },
  { id: "hoefler",        label: "Hoefler Text",     stack: `'Hoefler Text', 'Garamond', serif`,                              category: "serif" },
  { id: "big-caslon",     label: "Big Caslon",       stack: `'Big Caslon', 'Hoefler Text', serif`,                            category: "serif" },
  { id: "baskerville",    label: "Baskerville",      stack: `'Baskerville', 'Georgia', serif`,                                category: "serif" },
  { id: "didot",          label: "Didot",            stack: `'Didot', 'Bodoni 72', serif`,                                    category: "serif" },
  { id: "palatino",       label: "Palatino",         stack: `'Palatino', 'Palatino Linotype', 'Book Antiqua', serif`,         category: "serif" },
  { id: "bodoni",         label: "Bodoni 72",        stack: `'Bodoni 72', 'Didot', serif`,                                    category: "serif" },

  // Sans
  { id: "helvetica",      label: "Helvetica",        stack: `'Helvetica', 'Helvetica Neue', sans-serif`,                      category: "sans" },
  { id: "helvetica-neue", label: "Helvetica Neue",   stack: `'Helvetica Neue', 'Helvetica', sans-serif`,                      category: "sans" },
  { id: "avenir",         label: "Avenir",           stack: `'Avenir', 'Avenir Next', sans-serif`,                            category: "sans" },
  { id: "avenir-next",    label: "Avenir Next",      stack: `'Avenir Next', 'Avenir', sans-serif`,                            category: "sans" },
  { id: "futura",         label: "Futura",           stack: `'Futura', 'Trebuchet MS', sans-serif`,                           category: "sans" },
  { id: "optima",         label: "Optima",           stack: `'Optima', 'Avenir', sans-serif`,                                 category: "sans" },
  { id: "gill-sans",      label: "Gill Sans",        stack: `'Gill Sans', 'Trebuchet MS', sans-serif`,                        category: "sans" },
  { id: "trebuchet",      label: "Trebuchet MS",     stack: `'Trebuchet MS', 'Helvetica', sans-serif`,                        category: "sans" },
  { id: "system",         label: "System",           stack: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`, category: "sans" },

  // Display
  { id: "papyrus",        label: "Papyrus",          stack: `'Papyrus', fantasy`,                                              category: "display" },
  { id: "copperplate",    label: "Copperplate",      stack: `'Copperplate', 'Copperplate Gothic Light', serif`,               category: "display" },
  { id: "herculanum",     label: "Herculanum",       stack: `'Herculanum', 'Papyrus', fantasy`,                                category: "display" },
  { id: "luminari",       label: "Luminari",         stack: `'Luminari', fantasy`,                                             category: "display" },

  // Script
  { id: "snell",          label: "Snell Roundhand",  stack: `'Snell Roundhand', 'Apple Chancery', cursive`,                   category: "script" },
  { id: "apple-chancery", label: "Apple Chancery",   stack: `'Apple Chancery', cursive`,                                       category: "script" },
  { id: "marker-felt",    label: "Marker Felt",      stack: `'Marker Felt', 'Bradley Hand', cursive`,                          category: "script" },
  { id: "bradley",        label: "Bradley Hand",     stack: `'Bradley Hand', cursive`,                                         category: "script" },
  { id: "noteworthy",     label: "Noteworthy",       stack: `'Noteworthy', 'Marker Felt', cursive`,                            category: "script" },

  // Mono
  { id: "menlo",          label: "Menlo",            stack: `'Menlo', 'Monaco', monospace`,                                    category: "mono" },
  { id: "monaco",         label: "Monaco",           stack: `'Monaco', 'Menlo', monospace`,                                    category: "mono" },
  { id: "courier-new",    label: "Courier New",      stack: `'Courier New', 'Courier', monospace`,                             category: "mono" },
];

export function findCoverFont(id: string): CoverFont {
  return COVER_FONTS.find((f) => f.id === id) ?? COVER_FONTS[0];
}

// ──────────────────────────────────────────────────────────────────────────
// Cover design
//
// A cover is just an optional background image + a list of text boxes
// floating over it. Both front and back follow the same shape. The PDF
// renders these on full-bleed (zero-margin) pages so the image fills the
// whole sheet; `object-fit: cover` auto-crops + centres the image to the
// page aspect-ratio without distortion.
// ──────────────────────────────────────────────────────────────────────────

export type CoverTextField = "title" | "subtitle" | "author" | "description" | "custom";

export type CoverTextPosition = "top" | "center" | "bottom";

export interface CoverTextBox {
  id: string;
  field: CoverTextField;
  text: string;
  fontId: string;
  fontSizePt: number;
  bold?: boolean;
  italic?: boolean;
  align: "left" | "center" | "right";
  color: string;
  /** Vertical placement on the page — keeps positioning approachable
   *  without a full free-form drag UI. */
  position: CoverTextPosition;
  /** Letter-spacing in em — useful for caps-formatted titles. */
  letterSpacing?: number;
  /** Whether to uppercase the text on render. */
  uppercase?: boolean;
}

export interface CoverDesign {
  /** Base64 data URL (image/png or image/jpeg). Auto-cropped + centred to
   *  paper aspect via object-fit:cover when rendered. */
  imageDataUrl?: string;
  /** Layered text blocks rendered over the cover image. */
  textBoxes: CoverTextBox[];
}

export function emptyCover(): CoverDesign {
  return { textBoxes: [] };
}

export interface PdfExportOptions {
  pageFormatId: PageFormatId;
  paperSizeId: PaperSizeId;
  /** Optional custom front cover. When present, overrides the format's
   *  default text cover with the supplied image + text boxes. */
  frontCover?: CoverDesign;
  /** Optional back cover. When present, appended as a final full-bleed page. */
  backCover?: CoverDesign;
}

export const DEFAULT_PDF_OPTIONS: PdfExportOptions = {
  pageFormatId: "classic-trade",
  paperSizeId: "us-trade",
};

// Persist last-used selection so the overlay opens with the writer's prior
// choice already highlighted. Tiny payload, separate from main preferences
// so the schemas stay independent.
const PDF_PREFS_KEY = "latentwrite:pdf-prefs-v1";

// Cover image data URLs can be large (multi-MB at full resolution); the
// upload path always downscales them, but we keep the cover key separate
// so a quota failure on the image doesn't lose the format/size pick.
const PDF_COVERS_KEY = "latentwrite:pdf-covers-v1";

export function loadPdfPrefs(): PdfExportOptions {
  try {
    const raw = localStorage.getItem(PDF_PREFS_KEY);
    let fmt: PageFormatId = DEFAULT_PDF_OPTIONS.pageFormatId;
    let size: PaperSizeId = DEFAULT_PDF_OPTIONS.paperSizeId;
    if (raw) {
      const p = JSON.parse(raw) as Partial<PdfExportOptions>;
      if (PAGE_FORMAT_PRESETS.some((x) => x.id === p.pageFormatId)) {
        fmt = p.pageFormatId as PageFormatId;
      }
      if (PAPER_SIZE_PRESETS.some((x) => x.id === p.paperSizeId)) {
        size = p.paperSizeId as PaperSizeId;
      }
    }
    let frontCover: CoverDesign | undefined;
    let backCover: CoverDesign | undefined;
    const coversRaw = localStorage.getItem(PDF_COVERS_KEY);
    if (coversRaw) {
      const c = JSON.parse(coversRaw) as { front?: CoverDesign; back?: CoverDesign };
      if (c.front) frontCover = c.front;
      if (c.back) backCover = c.back;
    }
    return { pageFormatId: fmt, paperSizeId: size, frontCover, backCover };
  } catch {
    return { ...DEFAULT_PDF_OPTIONS };
  }
}

export function savePdfPrefs(opts: PdfExportOptions): void {
  // Format/size always saved (small payload — never fails quota).
  try {
    localStorage.setItem(
      PDF_PREFS_KEY,
      JSON.stringify({
        pageFormatId: opts.pageFormatId,
        paperSizeId: opts.paperSizeId,
      }),
    );
  } catch {
    /* quota — ignore */
  }
  // Covers persisted under a separate key so an oversize image (despite
  // downscaling) doesn't take down the format/size choice with it.
  try {
    if (opts.frontCover || opts.backCover) {
      localStorage.setItem(
        PDF_COVERS_KEY,
        JSON.stringify({ front: opts.frontCover, back: opts.backCover }),
      );
    } else {
      localStorage.removeItem(PDF_COVERS_KEY);
    }
  } catch {
    /* quota — ignore */
  }
}

function findFormat(id: PageFormatId): PageFormatPreset {
  return PAGE_FORMAT_PRESETS.find((p) => p.id === id) ?? PAGE_FORMAT_PRESETS[0];
}
function findSize(id: PaperSizeId): PaperSizePreset {
  return PAPER_SIZE_PRESETS.find((p) => p.id === id) ?? PAPER_SIZE_PRESETS[0];
}

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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Estimate words-per-page given a format + paper size. Rough — we use it
// only for the TOC page numbers, which don't need exactness. Drives off
// effective text area × line height × char width approximation.
function estimateWordsPerPage(fmt: PageFormatPreset, size: PaperSizePreset): number {
  const textWidthIn = size.widthIn - fmt.marginsIn.left - fmt.marginsIn.right;
  const textHeightIn = size.heightIn - fmt.marginsIn.top - fmt.marginsIn.bottom;
  // Approx 11.5 chars per inch at 11pt serif body, 8.5 at 12pt courier;
  // scale by font size linearly.
  const charsPerIn = 11.5 * (11 / fmt.body.fontSizePt);
  const charsPerLine = textWidthIn * charsPerIn;
  // 1pt ≈ 1/72 in. line-height in pt = fontSize * lineHeight.
  const lineHeightIn = (fmt.body.fontSizePt * fmt.body.lineHeight) / 72;
  const linesPerPage = textHeightIn / lineHeightIn;
  // Average word length ~5.1 chars + 1 space.
  const wordsPerLine = charsPerLine / 6.1;
  return Math.max(80, Math.round(linesPerPage * wordsPerLine));
}

// ── Custom-cover renderer ─────────────────────────────────────────────────
//
// Renders an optional custom front/back cover as a full-bleed page: a
// background <img> sized to the page (object-fit: cover crops + centres
// without distortion) plus any number of free-positioned text boxes.
// All boxes are anchored to the page corners by their `position` (top /
// center / bottom) so they survive paper-size changes without re-layout.

function renderTextBox(box: CoverTextBox): string {
  const font = findCoverFont(box.fontId);
  const styleParts: string[] = [
    `font-family: ${font.stack}`,
    `font-size: ${box.fontSizePt}pt`,
    `color: ${box.color}`,
    `text-align: ${box.align}`,
  ];
  if (box.bold) styleParts.push("font-weight: 700");
  if (box.italic) styleParts.push("font-style: italic");
  if (box.letterSpacing != null) styleParts.push(`letter-spacing: ${box.letterSpacing}em`);
  if (box.uppercase) styleParts.push("text-transform: uppercase");
  // Rendered text — preserve newlines as <br>.
  const text = esc(box.text).replace(/\n/g, "<br>");
  return `<div class="cover-text-box cover-text-box--${box.position}" style="${styleParts.join("; ")}">${text}</div>`;
}

function renderCustomCover(
  cover: CoverDesign | undefined,
  variant: "front" | "back",
): string {
  if (!cover) return "";
  const cls = variant === "front" ? "cover cover--custom" : "back-cover";
  const img = cover.imageDataUrl
    ? `<img class="cover-image" src="${cover.imageDataUrl}" alt="" />`
    : "";
  const boxes = cover.textBoxes.map(renderTextBox).join("\n  ");
  return `<section class="${cls}">
  ${img}
  <div class="cover-text-stack">
    ${boxes}
  </div>
</section>`;
}

function hasFrontCover(opts: PdfExportOptions): boolean {
  return !!opts.frontCover && (
    !!opts.frontCover.imageDataUrl || (opts.frontCover.textBoxes?.length ?? 0) > 0
  );
}

function hasBackCover(opts: PdfExportOptions): boolean {
  return !!opts.backCover && (
    !!opts.backCover.imageDataUrl || (opts.backCover.textBoxes?.length ?? 0) > 0
  );
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

function buildToc(novel: Novel, fmt: PageFormatPreset, size: PaperSizePreset): string {
  const { chapters } = novel;
  const wpp = estimateWordsPerPage(fmt, size);

  // Front-matter budget: cover(1) + TOC(1) ≈ 2 pages before chapters start.
  let pg = 3;
  const pageStarts: number[] = [];
  for (const ch of chapters) {
    pageStarts.push(pg);
    if (fmt.chapterStyle === "separate-page") pg += 1;
    pg += Math.max(1, Math.ceil(wordCount(ch.content) / wpp));
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

function buildCss(
  title: string,
  author: string,
  fmt: PageFormatPreset,
  size: PaperSizePreset,
  hasCustomFrontCover: boolean,
): string {
  const t = cssStr(title);
  const a = cssStr(author);

  // Running-header content depends on the format's preference.
  const headerContent =
    fmt.runningHeader === "title-author"
      ? `"${a ? a + "  ·  " : ""}${t}"`
      : fmt.runningHeader === "title"
      ? `"${t}"`
      : `""`;

  // Page-number positioning.
  const pageNumberCenter =
    fmt.pageNumbers === "center" ? "counter(page)" : `""`;
  const pageNumberOuterLeft =
    fmt.pageNumbers === "outer" ? "counter(page)" : `""`;
  const pageNumberOuterRight =
    fmt.pageNumbers === "outer" ? "counter(page)" : `""`;

  // Cover layout: padding-top is a fraction of paper height so the title
  // floats roughly 38% down the page on every paper size. Manuscript style
  // pins the title block to the top-right per industry convention.
  const coverPadTopIn = (size.heightIn * 0.38).toFixed(2);

  // Chapter title page top — keep the chapter heading in the upper third
  // for paperbacks, scaled to paper height.
  const chapterPadTopIn = (size.heightIn * 0.30).toFixed(2);

  const indent = fmt.body.indentEm;
  const indentRule = indent > 0 ? `text-indent: ${indent}em;` : `text-indent: 0;`;
  const blockSpacing = fmt.body.indentEm === 0
    ? `margin-bottom: ${fmt.body.paragraphSpacingEm}em;`
    : `margin: 0;`;

  // Cover style variants — three flavours of cover layout, picked per format.
  const coverCss = (() => {
    switch (fmt.cover.style) {
      case "manuscript":
        // Top-right author block, centred title at ~mid page. Industry
        // standard for unsolicited submissions.
        return `
.cover {
  padding: 0.5in 0.5in 0;
  page-break-after: always;
  break-after: page;
  position: relative;
}
.cover-author-block {
  text-align: left;
  font-size: 11pt;
  line-height: 1.4;
  white-space: pre-line;
  color: #111;
}
.cover-center-block {
  margin-top: ${(size.heightIn * 0.32).toFixed(2)}in;
  text-align: center;
}
.cover-title {
  font-size: ${fmt.cover.titleSizePt}pt;
  font-weight: normal;
  letter-spacing: 0.05em;
  margin-bottom: 0.25in;
  text-transform: uppercase;
}
.cover-subtitle, .cover-rule, .cover-author { display: none; }
`;
      case "modern":
        return `
.cover {
  padding-top: ${coverPadTopIn}in;
  text-align: left;
  padding-left: ${(size.widthIn * 0.10).toFixed(2)}in;
  padding-right: ${(size.widthIn * 0.10).toFixed(2)}in;
  page-break-after: always;
  break-after: page;
}
.cover-title {
  font-size: ${fmt.cover.titleSizePt}pt;
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin-bottom: 0.18in;
}
.cover-subtitle {
  font-size: 12pt;
  font-style: normal;
  font-weight: normal;
  color: #555;
  margin-bottom: 0.45in;
  line-height: 1.35;
  max-width: 5.5in;
}
.cover-rule {
  width: 1.6in;
  height: 2px;
  background: #111;
  margin: 0 0 0.45in 0;
}
.cover-author {
  font-size: 11pt;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #222;
}
`;
      case "minimal":
        return `
.cover {
  padding-top: ${coverPadTopIn}in;
  text-align: center;
  page-break-after: always;
  break-after: page;
}
.cover-title {
  font-size: ${fmt.cover.titleSizePt}pt;
  font-weight: normal;
  line-height: 1.15;
  letter-spacing: 0.01em;
  margin-bottom: 0.2in;
}
.cover-subtitle {
  font-size: 11pt;
  font-style: italic;
  color: #555;
  margin-bottom: 0.55in;
  line-height: 1.35;
  max-width: 4.5in;
  margin-left: auto;
  margin-right: auto;
}
.cover-rule { display: none; }
.cover-author {
  font-size: 10pt;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #444;
}
`;
      case "classic":
      default:
        return `
.cover {
  padding-top: ${coverPadTopIn}in;
  text-align: center;
  page-break-after: always;
  break-after: page;
}
.cover-title {
  font-size: ${fmt.cover.titleSizePt}pt;
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
`;
    }
  })();

  // Chapter heading style — separate page or inline at top of body.
  const chapterCss = fmt.chapterStyle === "inline-heading"
    ? `
.chapter-title-page { display: none; }
.chapter-body {
  page-break-before: always;
  break-before: page;
}
.chapter-body::before { content: ""; }
.chapter-inline-heading {
  text-align: center;
  font-weight: normal;
  font-size: 12pt;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin-top: 1in;
  margin-bottom: 0.6in;
}
.chapter-inline-title {
  display: block;
  margin-top: 0.18in;
  font-size: 14pt;
  letter-spacing: 0.04em;
  text-transform: none;
}
`
    : `
.chapter-title-page {
  page: chapter-title-pg;
  padding-top: ${chapterPadTopIn}in;
  page-break-before: always;
  break-before: page;
  page-break-after: always;
  break-after: page;
  text-align: center;
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
.chapter-inline-heading { display: none; }
`;

  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body { background: #fff; color: #000; }
body {
  font-family: ${fmt.body.fontFamily};
  font-size: ${fmt.body.fontSizePt}pt;
  line-height: ${fmt.body.lineHeight};
}

@page {
  size: ${size.cssSize};
  margin: ${fmt.marginsIn.top}in ${fmt.marginsIn.right}in ${fmt.marginsIn.bottom}in ${fmt.marginsIn.left}in;
  @top-center {
    content: ${headerContent};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    letter-spacing: 0.08em;
    color: #888;
  }
  @bottom-center {
    content: ${pageNumberCenter};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
  @bottom-left {
    content: ${pageNumberOuterLeft};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
  @bottom-right {
    content: ${pageNumberOuterRight};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
}

/* Cover — first page, no header/footer. With a custom user-supplied
   cover (image / text overlay), the first page goes full-bleed (margin
   0) so the image runs edge-to-edge; otherwise the format's normal
   margins apply so the default text cover sits inside them. */
@page :first {
  margin: ${
    hasCustomFrontCover
      ? "0"
      : `${fmt.marginsIn.top}in ${fmt.marginsIn.right}in ${fmt.marginsIn.bottom}in ${fmt.marginsIn.left}in`
  };
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
  @bottom-left   { content: ""; }
  @bottom-right  { content: ""; }
}

@page toc-pg {
  @top-center    { content: ""; }
  @bottom-center {
    content: ${pageNumberCenter};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
  @bottom-left {
    content: ${pageNumberOuterLeft};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
  @bottom-right {
    content: ${pageNumberOuterRight};
    font-family: ${fmt.body.fontFamily};
    font-size: 9pt;
    color: #666;
  }
}

@page chapter-title-pg {
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
  @bottom-left   { content: ""; }
  @bottom-right  { content: ""; }
}

/* Custom front cover — full bleed (zero margins on the first page so the
   image runs edge-to-edge). The default text-only cover above keeps its
   own padding-based layout; .cover--custom overrides it when present. */
@page custom-cover-pg {
  size: ${size.cssSize};
  margin: 0;
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
  @bottom-left   { content: ""; }
  @bottom-right  { content: ""; }
}

@page back-cover-pg {
  size: ${size.cssSize};
  margin: 0;
  @top-center    { content: ""; }
  @bottom-center { content: ""; }
  @bottom-left   { content: ""; }
  @bottom-right  { content: ""; }
}

.cover--custom {
  page: custom-cover-pg;
  width: ${size.widthIn}in;
  height: ${size.heightIn}in;
  padding: 0 !important;
  margin: 0;
  position: relative;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
  text-align: initial;
}

.back-cover {
  page: back-cover-pg;
  width: ${size.widthIn}in;
  height: ${size.heightIn}in;
  padding: 0;
  margin: 0;
  position: relative;
  overflow: hidden;
  page-break-before: always;
  break-before: page;
}

.cover--custom .cover-image,
.back-cover .cover-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* object-fit: cover auto-crops + centres the image to the page aspect
     ratio without distortion — matches the user-facing preview. */
  object-fit: cover;
  display: block;
  z-index: 0;
}

.cover-text-stack {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  /* Distribute text boxes top / center / bottom — each box anchors itself
     via flex alignment via its --top/center/bottom modifier. */
}

.cover-text-box {
  width: 100%;
  padding: 0 0.6in;
  line-height: 1.2;
  word-wrap: break-word;
}

.cover-text-box--top {
  margin-top: 0.6in;
  margin-bottom: auto;
}

.cover-text-box--center {
  margin-top: auto;
  margin-bottom: auto;
}

.cover-text-box--bottom {
  margin-top: auto;
  margin-bottom: 0.6in;
}

${coverCss}

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

${chapterCss}

/* === Chapter body === */
.chapter-body p {
  ${indentRule}
  ${blockSpacing}
  text-align: ${fmt.body.align};
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

export function buildNovelHtml(
  novel: Novel,
  options: PdfExportOptions = DEFAULT_PDF_OPTIONS,
): string {
  const fmt = findFormat(options.pageFormatId);
  const size = findSize(options.paperSizeId);

  const title = novel.meta.title || "Untitled";
  const subtitle = novel.meta.subtitle || "";
  const author = novel.meta.author || "";
  const { chapters } = novel;

  const tocHtml = fmt.toc ? buildToc(novel, fmt, size) : "";

  const chaptersHtml = chapters
    .map((ch) => {
      const chTitle = ch.title || "";
      if (fmt.chapterStyle === "inline-heading") {
        return `
<section class="chapter-body">
  <p class="chapter-inline-heading no-indent">
    Chapter ${ch.number}
    ${chTitle ? `<span class="chapter-inline-title">${esc(chTitle)}</span>` : ""}
  </p>
${renderBody(ch.content)}
</section>`;
      }
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

  // Cover content. When the user supplied a custom cover (image and/or
  // text boxes via the export overlay), use that — full bleed, image
  // auto-cropped + centred to the page, text boxes layered on top. Falls
  // back to the format's default text cover otherwise. Manuscript style
  // prints an explicit top-left author block + word count.
  const coverHtml = hasFrontCover(options)
    ? renderCustomCover(options.frontCover, "front")
    : fmt.cover.style === "manuscript"
    ? `
<section class="cover">
  <div class="cover-author-block">${esc(author || "Author")}
${esc(novel.meta.author ? "" : "")}
About ${chapters.reduce((s, c) => s + wordCount(c.content), 0).toLocaleString()} words</div>
  <div class="cover-center-block">
    <h1 class="cover-title">${esc(title)}</h1>
    <p class="cover-author">${esc(author || "")}</p>
  </div>
</section>`
    : `
<section class="cover">
  <h1 class="cover-title">${esc(title)}</h1>
  ${subtitle ? `<p class="cover-subtitle">${esc(subtitle)}</p>` : ""}
  <div class="cover-rule"></div>
  <p class="cover-author">${author ? esc(author) : "&nbsp;"}</p>
</section>`;

  const backCoverHtml = hasBackCover(options)
    ? renderCustomCover(options.backCover, "back")
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <style>${buildCss(title, author, fmt, size, hasFrontCover(options))}</style>
</head>
<body>

${coverHtml}

${tocHtml}

${chaptersHtml}

${backCoverHtml}

</body>
</html>`;
}

// ── Browser fallback (non-Electron) ───────────────────────────────────────
export function printNovelBrowser(
  novel: Novel,
  options: PdfExportOptions = DEFAULT_PDF_OPTIONS,
): void {
  const html = buildNovelHtml(novel, options);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank");
  if (w) {
    w.addEventListener("load", () => URL.revokeObjectURL(url));
  }
}
