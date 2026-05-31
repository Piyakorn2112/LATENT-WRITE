import type { Novel } from "../types";

// ── CRC-32 (required by ZIP local/central-directory headers) ─────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Low-level ZIP helpers ─────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function u16(n: number): Uint8Array { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

// Build a ZIP archive using STORE (no compression). Each file is added
// as a local record followed by a central-directory entry. The format is
// defined in PKWARE Application Note §4.3.
function buildZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  // DOS epoch (1980-01-01 00:00:00) — reproducible across environments.
  const dosTime = u16(0);
  const dosDate = u16(0x0021);
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = enc(name);
    const crc = crc32(data);
    const sizePair = [u32(data.length), u32(data.length)];

    // Local file header (§4.3.7)
    const local = concat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0),         // version needed, flags, method (STORE=0)
      dosTime, dosDate,
      u32(crc), ...sizePair,
      u16(nameBytes.length), u16(0),   // filename len, extra len
      nameBytes,
    );

    // Central directory record (§4.3.12)
    cdParts.push(concat(
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0), // versions, flags, method
      dosTime, dosDate,
      u32(crc), ...sizePair,
      u16(nameBytes.length), u16(0), u16(0), // name, extra, comment
      u16(0), u16(0), u32(0),           // disk start, int/ext attrs
      u32(offset),
      nameBytes,
    ));

    offset += local.length + data.length;
    localParts.push(local, data);
  }

  const cdData = concat(...cdParts);
  // End of central directory record (§4.3.16)
  const eocd = concat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),                          // disk number, disk with CD
    u16(files.length), u16(files.length),
    u32(cdData.length), u32(offset),
    u16(0),                                   // comment length
  );

  return concat(...localParts, cdData, eocd);
}

// ── DOCX XML builders ─────────────────────────────────────────────────────

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SCENE_BREAK_RE = /^[\s*\-—#~=|]{3,}$/;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(text: string, styleId?: string): string {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

function buildDocumentXml(novel: Novel): string {
  const parts: string[] = [];
  parts.push(para(novel.meta.title || "Untitled", "Title"));
  if (novel.meta.subtitle) parts.push(para(novel.meta.subtitle, "Subtitle"));
  if (novel.meta.author) parts.push(para(novel.meta.author, "Subtitle"));

  for (const ch of novel.chapters) {
    parts.push(para(ch.title ? ch.title : `Chapter ${ch.number}`, "Heading1"));
    for (const line of ch.content.split("\n")) {
      if (!line.trim()) { parts.push("<w:p/>"); continue; }
      if (SCENE_BREAK_RE.test(line.trim())) { parts.push(para("* * *", "SceneBreak")); continue; }
      parts.push(para(line));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${parts.join("\n")}
<w:sectPr>
  <w:pgSz w:w="12240" w:h="15840"/>
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
</w:sectPr>
</w:body></w:document>`;
}

function buildStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:line="480" w:lineRule="auto" w:after="0"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
      <w:sz w:val="24"/><w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:line="240" w:lineRule="auto" w:before="0" w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:line="240" w:lineRule="auto" w:before="0" w:after="480"/></w:pPr>
    <w:rPr><w:i/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:line="240" w:lineRule="auto" w:before="720" w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="SceneBreak">
    <w:name w:val="SceneBreak"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>
  </w:style>
</w:styles>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const WORD_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// ── Public API ────────────────────────────────────────────────────────────

export function novelToMarkdown(novel: Novel): string {
  const lines: string[] = [];
  lines.push(`# ${novel.meta.title || "Untitled"}`, "");
  if (novel.meta.author) { lines.push(`*by ${novel.meta.author}*`, ""); }
  if (novel.meta.subtitle) { lines.push(`*${novel.meta.subtitle}*`, ""); }

  for (const ch of novel.chapters) {
    lines.push("---", "");
    lines.push(`## ${ch.title || `Chapter ${ch.number}`}`, "");
    for (const line of ch.content.split("\n")) {
      lines.push(line.trim() && SCENE_BREAK_RE.test(line.trim()) ? "---" : line);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function novelToDocx(novel: Novel): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml",         data: enc(CONTENT_TYPES_XML) },
    { name: "_rels/.rels",                  data: enc(PACKAGE_RELS_XML) },
    { name: "word/_rels/document.xml.rels", data: enc(WORD_RELS_XML) },
    { name: "word/document.xml",            data: enc(buildDocumentXml(novel)) },
    { name: "word/styles.xml",              data: enc(buildStylesXml()) },
  ]);
}

// ── EPUB builders ─────────────────────────────────────────────────────────
//
// EPUB 3 is a ZIP with a fixed layout. We reuse buildZip (STORE, no
// compression) and place `mimetype` first, exactly as the OCF spec requires.

const EPUB_CSS = `@namespace epub "http://www.idpf.org/2007/ops";
html { font-size: 100%; }
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 1em 1.2em; }
h1 { font-size: 1.5em; font-weight: bold; text-align: center; margin: 1.6em 0 1.2em; page-break-before: always; break-before: page; }
p { margin: 0; text-indent: 1.4em; text-align: justify; widows: 2; orphans: 2; }
h1 + p { text-indent: 0; }
p.scene { text-indent: 0; text-align: center; margin: 1.4em 0; }
.titlepage { text-align: center; margin-top: 25%; }
.book-title { font-size: 2.1em; page-break-before: avoid; margin-bottom: 0.4em; }
.book-subtitle { font-style: italic; font-size: 1.1em; margin: 0.4em 0; }
.book-author { margin-top: 2.4em; font-size: 1.05em; }
nav#toc ol { list-style: none; padding-left: 0; line-height: 1.9; }
`;

function pad3(n: number): string { return String(n).padStart(3, "0"); }

function epubUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function xhtmlDoc(title: string, inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
<meta charset="utf-8"/>
<title>${xmlEsc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${inner}
</body>
</html>`;
}

function chapterXhtml(ch: Novel["chapters"][number]): string {
  const title = ch.title || `Chapter ${ch.number}`;
  const parts: string[] = [`<h1>${xmlEsc(title)}</h1>`];
  for (const line of ch.content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (SCENE_BREAK_RE.test(t)) { parts.push(`<p class="scene">* * *</p>`); continue; }
    parts.push(`<p>${xmlEsc(line)}</p>`);
  }
  return xhtmlDoc(title, parts.join("\n"));
}

function titleXhtml(novel: Novel): string {
  const m = novel.meta;
  const parts = [`<div class="titlepage">`, `<h1 class="book-title">${xmlEsc(m.title || "Untitled")}</h1>`];
  if (m.subtitle) parts.push(`<p class="book-subtitle">${xmlEsc(m.subtitle)}</p>`);
  if (m.author) parts.push(`<p class="book-author">${xmlEsc(m.author)}</p>`);
  parts.push(`</div>`);
  return xhtmlDoc(m.title || "Untitled", parts.join("\n"));
}

function navXhtml(novel: Novel): string {
  const items = novel.chapters.map((ch, i) =>
    `<li><a href="chapter-${pad3(i + 1)}.xhtml">${xmlEsc(ch.title || `Chapter ${ch.number}`)}</a></li>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
<li><a href="title.xhtml">Title page</a></li>
${items}
</ol>
</nav>
</body>
</html>`;
}

function ncxXml(novel: Novel, uid: string): string {
  const points = novel.chapters.map((ch, i) =>
    `<navPoint id="navpoint-${i + 1}" playOrder="${i + 2}"><navLabel><text>${xmlEsc(ch.title || `Chapter ${ch.number}`)}</text></navLabel><content src="chapter-${pad3(i + 1)}.xhtml"/></navPoint>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
<head>
<meta name="dtb:uid" content="${xmlEsc(uid)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xmlEsc(novel.meta.title || "Untitled")}</text></docTitle>
<navMap>
<navPoint id="navpoint-title" playOrder="1"><navLabel><text>Title page</text></navLabel><content src="title.xhtml"/></navPoint>
${points}
</navMap>
</ncx>`;
}

function contentOpf(novel: Novel, uuid: string, modified: string): string {
  const m = novel.meta;
  const manifestChapters = novel.chapters.map((_, i) =>
    `<item id="chap${i + 1}" href="chapter-${pad3(i + 1)}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join("\n");
  const spineChapters = novel.chapters.map((_, i) => `<itemref idref="chap${i + 1}"/>`).join("\n");
  const creator = m.author ? `<dc:creator>${xmlEsc(m.author)}</dc:creator>` : "";
  const desc = m.subtitle ? `<dc:description>${xmlEsc(m.subtitle)}</dc:description>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
<dc:title>${xmlEsc(m.title || "Untitled")}</dc:title>
<dc:language>en</dc:language>
${creator}
${desc}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="titlepage" href="title.xhtml" media-type="application/xhtml+xml"/>
${manifestChapters}
</manifest>
<spine toc="ncx">
<itemref idref="titlepage"/>
${spineChapters}
</spine>
</package>`;
}

const EPUB_CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`;

export function novelToEpub(novel: Novel): Uint8Array {
  const uuid = epubUuid();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const files: Array<{ name: string; data: Uint8Array }> = [
    // `mimetype` MUST be first and uncompressed (buildZip uses STORE).
    { name: "mimetype",                data: enc("application/epub+zip") },
    { name: "META-INF/container.xml",  data: enc(EPUB_CONTAINER_XML) },
    { name: "OEBPS/content.opf",       data: enc(contentOpf(novel, uuid, modified)) },
    { name: "OEBPS/nav.xhtml",         data: enc(navXhtml(novel)) },
    { name: "OEBPS/toc.ncx",           data: enc(ncxXml(novel, `urn:uuid:${uuid}`)) },
    { name: "OEBPS/style.css",         data: enc(EPUB_CSS) },
    { name: "OEBPS/title.xhtml",       data: enc(titleXhtml(novel)) },
  ];
  novel.chapters.forEach((ch, i) => {
    files.push({ name: `OEBPS/chapter-${pad3(i + 1)}.xhtml`, data: enc(chapterXhtml(ch)) });
  });

  return buildZip(files);
}

export function downloadBlob(filename: string, data: Uint8Array | string, mimeType: string): void {
  // BlobPart requires ArrayBuffer specifically; Uint8Array carries ArrayBufferLike
  // in TS 5.x (which includes SharedArrayBuffer), so we cast. Runtime is fine.
  const blob = new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
