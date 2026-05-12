import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignCenterVertical,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold as BoldIcon,
  CaseSensitive,
  Check,
  ChevronDown,
  Italic as ItalicIcon,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
} from "lucide-react";
import {
  PAGE_FORMAT_PRESETS,
  PAPER_SIZE_PRESETS,
  COVER_FONTS,
  findCoverFont,
  emptyCover,
  loadPdfPrefs,
  savePdfPrefs,
  type PageFormatId,
  type PaperSizeId,
  type PdfExportOptions,
  type CoverDesign,
  type CoverTextBox,
  type CoverTextField,
  type CoverTextPosition,
} from "../lib/pdf-export";
import type { NovelMeta } from "../types";
import {
  CloseIcon, FileTextIcon, BookOpenIcon, ImageIcon, TypeIcon,
  PlusIcon, TrashIcon, UploadIcon,
} from "./Icon";
import { GlassColorPicker } from "./GlassColorPicker";
import { NumberStepper } from "./NumberStepper";

interface Props {
  /** Used to seed default text boxes (title / subtitle / author / description)
   *  with the writer's existing book metadata so they don't have to retype it. */
  meta: NovelMeta;
  onConfirm: (options: PdfExportOptions) => void;
  onClose: () => void;
}

type Tab = "format" | "size" | "front" | "back";

// ── Image processing ──────────────────────────────────────────────────────
//
// Cover images are stored as base64 data URLs in localStorage. Full-resolution
// camera shots can be 5-10 MB which blows the localStorage quota; we downscale
// every upload to a max long-edge of 2000 px and re-encode as JPEG quality 0.9
// (or PNG if the source has transparency). Output is rarely > 800 KB and
// indistinguishable at print resolution.

const MAX_LONG_EDGE = 2000;

async function imageFileToDataUrl(file: File): Promise<string> {
  const sourceUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Image load failed"));
    i.src = sourceUrl;
  });
  // If small enough, keep the original encoding (preserves PNG transparency).
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  if (longEdge <= MAX_LONG_EDGE) return sourceUrl;
  const scale = MAX_LONG_EDGE / longEdge;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return sourceUrl;
  ctx.drawImage(img, 0, 0, w, h);
  // JPEG keeps the size manageable; PNG is preserved for sources that look
  // like they need transparency (rare for covers).
  const isPng = file.type === "image/png";
  return canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.9);
}

// ── Default cover seeding ────────────────────────────────────────────────

let __covTextBoxIdCounter = 0;
const newTextBoxId = () => `tb-${Date.now()}-${++__covTextBoxIdCounter}`;

function seedFrontCover(meta: NovelMeta): CoverDesign {
  const boxes: CoverTextBox[] = [];
  if (meta.title) {
    boxes.push({
      id: newTextBoxId(),
      field: "title",
      text: meta.title,
      fontId: "didot",
      fontSizePt: 44,
      bold: false,
      align: "center",
      color: "#ffffff",
      position: "center",
      letterSpacing: 0.02,
      uppercase: false,
    });
  }
  if (meta.subtitle) {
    boxes.push({
      id: newTextBoxId(),
      field: "subtitle",
      text: meta.subtitle,
      fontId: "baskerville",
      fontSizePt: 16,
      italic: true,
      align: "center",
      color: "#ffffff",
      position: "center",
    });
  }
  if (meta.author) {
    boxes.push({
      id: newTextBoxId(),
      field: "author",
      text: meta.author,
      fontId: "avenir-next",
      fontSizePt: 14,
      align: "center",
      color: "#ffffff",
      position: "bottom",
      letterSpacing: 0.18,
      uppercase: true,
    });
  }
  return { textBoxes: boxes };
}

function seedBackCover(meta: NovelMeta): CoverDesign {
  const boxes: CoverTextBox[] = [];
  if (meta.description) {
    boxes.push({
      id: newTextBoxId(),
      field: "description",
      text: meta.description,
      fontId: "baskerville",
      fontSizePt: 12,
      align: "center",
      color: "#ffffff",
      position: "center",
    });
  }
  if (meta.title) {
    boxes.push({
      id: newTextBoxId(),
      field: "title",
      text: meta.title,
      fontId: "avenir-next",
      fontSizePt: 11,
      align: "center",
      color: "#ffffff",
      position: "bottom",
      letterSpacing: 0.18,
      uppercase: true,
    });
  }
  return { textBoxes: boxes };
}

// ── Component ─────────────────────────────────────────────────────────────

export function PdfExportOverlay({ meta, onConfirm, onClose }: Props) {
  const [opts, setOpts] = useState<PdfExportOptions>(() => loadPdfPrefs());
  const [tab, setTab] = useState<Tab>("format");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  const setFormat = (id: PageFormatId) =>
    setOpts((o) => ({ ...o, pageFormatId: id }));
  const setSize = (id: PaperSizeId) =>
    setOpts((o) => ({ ...o, paperSizeId: id }));

  const setFrontCover = (front: CoverDesign | undefined) =>
    setOpts((o) => ({ ...o, frontCover: front }));
  const setBackCover = (back: CoverDesign | undefined) =>
    setOpts((o) => ({ ...o, backCover: back }));

  const confirm = () => {
    savePdfPrefs(opts);
    onConfirm(opts);
  };

  const fmt = PAGE_FORMAT_PRESETS.find((p) => p.id === opts.pageFormatId)!;
  const size = PAPER_SIZE_PRESETS.find((p) => p.id === opts.paperSizeId)!;

  return (
    <div
      className="index-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="world-panel pdf-panel">
        <div className="world-header">
          <h2 className="world-title">Export PDF</h2>
          <div className="world-tabs">
            <button
              className={`world-tab ${tab === "format" ? "world-tab--active" : ""}`}
              onClick={() => setTab("format")}
            >
              <BookOpenIcon size={13} />
              <span>Page format</span>
              <span className="world-tab-count">{PAGE_FORMAT_PRESETS.length}</span>
            </button>
            <button
              className={`world-tab ${tab === "size" ? "world-tab--active" : ""}`}
              onClick={() => setTab("size")}
            >
              <FileTextIcon size={13} />
              <span>Paper size</span>
              <span className="world-tab-count">{PAPER_SIZE_PRESETS.length}</span>
            </button>
            <button
              className={`world-tab ${tab === "front" ? "world-tab--active" : ""}`}
              onClick={() => setTab("front")}
            >
              <ImageIcon size={13} />
              <span>Front cover</span>
              {opts.frontCover && (opts.frontCover.imageDataUrl || opts.frontCover.textBoxes.length > 0) && (
                <span className="world-tab-status" aria-label="Front cover configured">
                  <Check size={11} strokeWidth={3.2} />
                </span>
              )}
            </button>
            <button
              className={`world-tab ${tab === "back" ? "world-tab--active" : ""}`}
              onClick={() => setTab("back")}
            >
              <TypeIcon size={13} />
              <span>Back cover</span>
              {opts.backCover && (opts.backCover.imageDataUrl || opts.backCover.textBoxes.length > 0) && (
                <span className="world-tab-status" aria-label="Back cover configured">
                  <Check size={11} strokeWidth={3.2} />
                </span>
              )}
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close export panel">
            <CloseIcon />
          </button>
        </div>

        {tab === "format" || tab === "size" ? (
          <FormatOrSizeBody
            tab={tab}
            opts={opts}
            fmt={fmt}
            size={size}
            onSelectFormat={setFormat}
            onSelectSize={setSize}
          />
        ) : (
          <CoverComposer
            variant={tab}
            cover={tab === "front" ? opts.frontCover : opts.backCover}
            onChange={(c) => (tab === "front" ? setFrontCover(c) : setBackCover(c))}
            onSeed={() =>
              (tab === "front" ? setFrontCover : setBackCover)(
                tab === "front" ? seedFrontCover(meta) : seedBackCover(meta),
              )
            }
            paper={{ widthIn: size.widthIn, heightIn: size.heightIn }}
          />
        )}

        <div className="pdf-footer">
          <button className="pdf-cancel" onClick={onClose}>Cancel</button>
          <button className="pdf-export-btn" onClick={confirm}>
            Export PDF
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Format / Paper-size body ─────────────────────────────────────────────

interface FormatOrSizeBodyProps {
  tab: "format" | "size";
  opts: PdfExportOptions;
  fmt: typeof PAGE_FORMAT_PRESETS[number];
  size: typeof PAPER_SIZE_PRESETS[number];
  onSelectFormat: (id: PageFormatId) => void;
  onSelectSize: (id: PaperSizeId) => void;
}

function FormatOrSizeBody({
  tab, opts, fmt, size, onSelectFormat, onSelectSize,
}: FormatOrSizeBodyProps) {
  return (
    <div className="pdf-body">
      <div className="pdf-cards">
        {tab === "format"
          ? PAGE_FORMAT_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`pdf-card ${opts.pageFormatId === p.id ? "pdf-card--active" : ""}`}
                onClick={() => onSelectFormat(p.id)}
              >
                <FormatPreviewSwatch format={p} />
                <span className="pdf-card-body">
                  <span className="pdf-card-title">{p.label}</span>
                  <span className="pdf-card-desc">{p.description}</span>
                  <span className="pdf-card-meta">{fmtSpecLine(p)}</span>
                </span>
              </button>
            ))
          : PAPER_SIZE_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`pdf-card ${opts.paperSizeId === p.id ? "pdf-card--active" : ""}`}
                onClick={() => onSelectSize(p.id)}
              >
                <PaperPreviewSwatch widthIn={p.widthIn} heightIn={p.heightIn} />
                <span className="pdf-card-body">
                  <span className="pdf-card-title">{p.label}</span>
                  <span className="pdf-card-desc">{p.description}</span>
                  <span className="pdf-card-meta">{`${p.widthIn.toFixed(2)} × ${p.heightIn.toFixed(2)} in`}</span>
                </span>
              </button>
            ))}
      </div>

      <div className="pdf-preview-wrap">
        <div className="pdf-preview-label">Preview</div>
        <LivePreview
          widthIn={size.widthIn}
          heightIn={size.heightIn}
          marginsIn={fmt.marginsIn}
          indentEm={fmt.body.indentEm}
          align={fmt.body.align}
          lineHeight={fmt.body.lineHeight}
          hasHeader={fmt.runningHeader !== "none"}
          hasFooter={fmt.pageNumbers !== "none"}
        />
        <div className="pdf-preview-summary">
          <div>
            <span className="pdf-preview-key">Format</span>
            <span className="pdf-preview-val">{fmt.label}</span>
          </div>
          <div>
            <span className="pdf-preview-key">Paper</span>
            <span className="pdf-preview-val">{size.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Cover composer ───────────────────────────────────────────────────────

interface CoverComposerProps {
  variant: "front" | "back";
  cover: CoverDesign | undefined;
  onChange: (next: CoverDesign | undefined) => void;
  onSeed: () => void;
  paper: { widthIn: number; heightIn: number };
}

function CoverComposer({ variant, cover, onChange, onSeed, paper }: CoverComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // The cover may be undefined when nothing has been uploaded or seeded yet.
  // We treat that as "use format defaults" — empty state.
  const c = cover ?? null;

  const setImage = async (file: File) => {
    setUploading(true);
    try {
      const dataUrl = await imageFileToDataUrl(file);
      onChange({ ...(c ?? emptyCover()), imageDataUrl: dataUrl });
    } finally {
      setUploading(false);
    }
  };

  const removeImage = () => {
    if (!c) return;
    const next: CoverDesign = { ...c };
    delete next.imageDataUrl;
    // Drop the whole cover if nothing remains.
    if ((next.textBoxes?.length ?? 0) === 0) onChange(undefined);
    else onChange(next);
  };

  const updateBox = (id: string, patch: Partial<CoverTextBox>) => {
    if (!c) return;
    const boxes = c.textBoxes.map((b) => (b.id === id ? { ...b, ...patch } : b));
    onChange({ ...c, textBoxes: boxes });
  };

  const removeBox = (id: string) => {
    if (!c) return;
    const boxes = c.textBoxes.filter((b) => b.id !== id);
    if (boxes.length === 0 && !c.imageDataUrl) onChange(undefined);
    else onChange({ ...c, textBoxes: boxes });
  };

  const addBox = (field: CoverTextField = "custom") => {
    const newBox: CoverTextBox = {
      id: newTextBoxId(),
      field,
      text:
        field === "title" ? "Title" :
        field === "subtitle" ? "Subtitle" :
        field === "author" ? "Author" :
        field === "description" ? "Description" :
        "Text",
      fontId: field === "title" ? "didot" : field === "author" ? "avenir-next" : "baskerville",
      fontSizePt: field === "title" ? 44 : field === "author" ? 14 : 16,
      align: "center",
      color: "#ffffff",
      position: field === "author" || field === "title" ? "center" : "center",
    };
    onChange({ ...(c ?? emptyCover()), textBoxes: [...((c?.textBoxes) ?? []), newBox] });
  };

  return (
    <div className="pdf-body pdf-body--cover">
      <div className="pdf-cover-controls">
        {/* Image upload */}
        <div className="pdf-cover-section">
          <div className="pdf-cover-section-label">
            {variant === "front" ? "Front cover image" : "Back cover image"}
          </div>
          <div className="pdf-cover-imagebox">
            {c?.imageDataUrl ? (
              <>
                <img src={c.imageDataUrl} alt="" className="pdf-cover-imagebox-thumb" />
                <div className="pdf-cover-imagebox-actions">
                  <button
                    className="pdf-mini-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    Replace
                  </button>
                  <button className="pdf-mini-btn pdf-mini-btn--danger" onClick={removeImage}>
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <button
                className="pdf-cover-upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                <UploadIcon size={18} />
                <span>{uploading ? "Processing…" : "Upload image"}</span>
                <span className="pdf-cover-upload-hint">
                  Auto-cropped &amp; centred to {paper.widthIn.toFixed(1)} × {paper.heightIn.toFixed(1)} in
                </span>
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setImage(f);
            }}
          />
        </div>

        {/* Text overlays */}
        <div className="pdf-cover-section">
          <div className="pdf-cover-section-label">
            <span>Text overlays</span>
            <div className="pdf-cover-text-actions">
              <button className="pdf-mini-btn" onClick={onSeed}>
                Auto-fill from book
              </button>
            </div>
          </div>

          <div className="pdf-cover-text-list">
            {(c?.textBoxes ?? []).map((b) => (
              <TextBoxEditor
                key={b.id}
                box={b}
                onChange={(patch) => updateBox(b.id, patch)}
                onRemove={() => removeBox(b.id)}
              />
            ))}
            {(c?.textBoxes ?? []).length === 0 && (
              <div className="pdf-cover-text-empty">
                No text overlays yet. Add one below or auto-fill from the book metadata.
              </div>
            )}
          </div>

          <div className="pdf-cover-add-row">
            {(["title", "subtitle", "author", "description", "custom"] as CoverTextField[]).map((f) => (
              <button key={f} className="pdf-mini-btn pdf-mini-btn--add" onClick={() => addBox(f)}>
                <PlusIcon size={11} />
                <span>{f.charAt(0).toUpperCase() + f.slice(1)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live cover preview */}
      <div className="pdf-preview-wrap">
        <div className="pdf-preview-label">Cover preview</div>
        <CoverPreview cover={c ?? null} paper={paper} />
        <div className="pdf-preview-summary">
          <div>
            <span className="pdf-preview-key">Image</span>
            <span className="pdf-preview-val">{c?.imageDataUrl ? "Set" : "—"}</span>
          </div>
          <div>
            <span className="pdf-preview-key">Text boxes</span>
            <span className="pdf-preview-val">{c?.textBoxes.length ?? 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Text-box editor ──────────────────────────────────────────────────────

interface TextBoxEditorProps {
  box: CoverTextBox;
  onChange: (patch: Partial<CoverTextBox>) => void;
  onRemove: () => void;
}

const FIELD_LABEL: Record<CoverTextField, string> = {
  title: "Title", subtitle: "Subtitle", author: "Author",
  description: "Description", custom: "Custom",
};

const COVER_FONT_CATEGORY_LABELS: Record<(typeof COVER_FONTS)[number]["category"], string> = {
  serif: "Serif",
  sans: "Sans",
  display: "Display",
  mono: "Mono",
  script: "Script",
};

const COVER_FONT_POPOVER_WIDTH = 280;
const COVER_FONT_POPOVER_GAP = 8;

interface CoverFontPickerProps {
  value: string;
  fontGroups: Record<string, typeof COVER_FONTS>;
  onChange: (fontId: string) => void;
}

function CoverFontPicker({ value, fontGroups, onChange }: CoverFontPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const currentFont = findCoverFont(value);

  useEffect(() => {
    if (!open) return;

    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDoc), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    let frame = 0;
    const refreshPosition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;

        const rect = trigger.getBoundingClientRect();
        const popoverWidth = popoverRef.current?.offsetWidth ?? COVER_FONT_POPOVER_WIDTH;
        const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
        let left = rect.left;
        left = Math.max(12, Math.min(window.innerWidth - popoverWidth - 12, left));

        const below = rect.bottom + COVER_FONT_POPOVER_GAP;
        const above = rect.top - popoverHeight - COVER_FONT_POPOVER_GAP;
        const top = below + popoverHeight > window.innerHeight - 12 && above >= 12 ? above : below;

        setPopoverStyle({
          position: "fixed",
          top: Math.max(12, top),
          left,
          width: popoverWidth,
          visibility: "visible",
        });
      });
    };

    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [open]);

  const popover = (
    <div
      ref={popoverRef}
      className="pdf-font-popover liquid-glass"
      style={popoverStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pdf-font-popover-scroll">
        {Object.entries(fontGroups).map(([category, fonts]) => {
          const categoryLabel = COVER_FONT_CATEGORY_LABELS[category as keyof typeof COVER_FONT_CATEGORY_LABELS] ?? category;
          return (
            <div key={category} className="pdf-font-popover-group">
              <div className="pdf-font-popover-heading">{categoryLabel}</div>
              {fonts.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  className={`pdf-font-popover-option ${font.id === value ? "pdf-font-popover-option--active" : ""}`}
                  style={{ fontFamily: font.stack } as CSSProperties}
                  onClick={() => {
                    onChange(font.id);
                    setOpen(false);
                  }}
                >
                  <span className="pdf-font-popover-option-label">{font.label}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="pdf-textbox-font-picker">
      <button
        type="button"
        ref={triggerRef}
        className="pdf-textbox-select pdf-textbox-font-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="pdf-textbox-font-trigger-label" style={{ fontFamily: currentFont.stack } as CSSProperties}>
          {currentFont.label}
        </span>
        <span className="pdf-textbox-font-trigger-chevron" aria-hidden="true">
          <ChevronDown size={14} strokeWidth={1.9} />
        </span>
      </button>
      {open && typeof document !== "undefined" && createPortal(popover, document.body)}
    </div>
  );
}

function TextBoxEditor({ box, onChange, onRemove }: TextBoxEditorProps) {
  // Group fonts by category for a navigable picker.
  const fontGroups = useMemo(() => {
    const groups: Record<string, typeof COVER_FONTS> = {};
    for (const f of COVER_FONTS) {
      if (!groups[f.category]) groups[f.category] = [];
      groups[f.category].push(f);
    }
    return groups;
  }, []);

  return (
    <div className="pdf-textbox-editor">
      <div className="pdf-textbox-row">
        <span className="pdf-textbox-pill">{FIELD_LABEL[box.field]}</span>
        <button className="pdf-mini-btn pdf-mini-btn--danger pdf-textbox-remove" onClick={onRemove}>
          <TrashIcon size={11} />
        </button>
      </div>

      {box.field === "description" ? (
        <textarea
          className="pdf-textbox-textarea"
          value={box.text}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={3}
          placeholder="Back-cover description…"
        />
      ) : (
        <input
          className="pdf-textbox-input"
          value={box.text}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Text…"
        />
      )}

      <div className="pdf-textbox-row pdf-textbox-row--controls">
        <CoverFontPicker
          value={box.fontId}
          onChange={(fontId) => onChange({ fontId })}
          fontGroups={fontGroups}
        />

        <NumberStepper
          value={box.fontSizePt}
          onChange={(fontSizePt) => onChange({ fontSizePt })}
          min={6}
          max={120}
          step={1}
          className="pdf-textbox-stepper"
        />
        <span className="pdf-textbox-unit">pt</span>

        <GlassColorPicker
          value={box.color}
          onChange={(c) => onChange({ color: c })}
        />
      </div>

      <div className="pdf-textbox-row pdf-textbox-row--toggles">
        <ToggleBtn
          icon={<BoldIcon size={14} strokeWidth={1.9} />}
          active={!!box.bold}
          title="Bold"
          onClick={() => onChange({ bold: !box.bold })}
        />
        <ToggleBtn
          icon={<ItalicIcon size={14} strokeWidth={1.9} />}
          active={!!box.italic}
          title="Italic"
          onClick={() => onChange({ italic: !box.italic })}
        />
        <ToggleBtn
          icon={<CaseSensitive size={14} strokeWidth={1.9} />}
          active={!!box.uppercase}
          title="Uppercase"
          onClick={() => onChange({ uppercase: !box.uppercase })}
        />

        <span className="pdf-textbox-divider" />

        {(["left", "center", "right"] as const).map((a) => (
          <ToggleBtn
            key={a}
            icon={
              a === "left"
                ? <TextAlignStart size={14} strokeWidth={1.9} />
                : a === "center"
                ? <TextAlignCenter size={14} strokeWidth={1.9} />
                : <TextAlignEnd size={14} strokeWidth={1.9} />
            }
            active={box.align === a}
            title={`Align ${a}`}
            onClick={() => onChange({ align: a })}
          />
        ))}

        <span className="pdf-textbox-divider" />

        {(["top", "center", "bottom"] as CoverTextPosition[]).map((p) => (
          <ToggleBtn
            key={p}
            icon={
              p === "top"
                ? <ArrowUpToLine size={14} strokeWidth={1.9} />
                : p === "center"
                ? <AlignCenterVertical size={14} strokeWidth={1.9} />
                : <ArrowDownToLine size={14} strokeWidth={1.9} />
            }
            active={box.position === p}
            title={`Position ${p}`}
            onClick={() => onChange({ position: p })}
          />
        ))}
      </div>
    </div>
  );
}

interface ToggleBtnProps {
  icon: ReactNode;
  active: boolean;
  title: string;
  onClick: () => void;
}

function ToggleBtn({ icon, active, title, onClick }: ToggleBtnProps) {
  return (
    <button
      type="button"
      className={`pdf-toggle-btn ${active ? "pdf-toggle-btn--active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

// ── Live cover preview ───────────────────────────────────────────────────

interface CoverPreviewProps {
  cover: CoverDesign | null;
  paper: { widthIn: number; heightIn: number };
}

function CoverPreview({ cover, paper }: CoverPreviewProps) {
  // Fit in 200×260 box, preserving aspect.
  const maxW = 200, maxH = 260;
  const scale = Math.min(maxW / paper.widthIn, maxH / paper.heightIn);
  const w = paper.widthIn * scale;
  const h = paper.heightIn * scale;
  // Scale text sizes so the preview reflects the relative typography. 1 in =
  // 72pt; the preview uses `scale` px per inch, so 1pt = scale/72 px.
  const ptToPx = (pt: number) => (pt * scale) / 72;

  return (
    <div
      className="pdf-cover-preview"
      style={{ width: `${w}px`, height: `${h}px` } as CSSProperties}
    >
      {cover?.imageDataUrl && (
        <img className="pdf-cover-preview-img" src={cover.imageDataUrl} alt="" />
      )}
      {!cover?.imageDataUrl && <div className="pdf-cover-preview-empty" />}
      <div className="pdf-cover-preview-stack">
        {(["top", "center", "bottom"] as CoverTextPosition[]).map((pos) => {
          const boxes = (cover?.textBoxes ?? []).filter((b) => b.position === pos);
          return (
            <div key={pos} className={`pdf-cover-preview-zone pdf-cover-preview-zone--${pos}`}>
              {boxes.map((b) => (
                <div
                  key={b.id}
                  style={{
                    fontFamily: findCoverFont(b.fontId).stack,
                    fontSize: `${Math.max(6, ptToPx(b.fontSizePt))}px`,
                    color: b.color,
                    textAlign: b.align,
                    fontWeight: b.bold ? 700 : 400,
                    fontStyle: b.italic ? "italic" : "normal",
                    textTransform: b.uppercase ? "uppercase" : "none",
                    letterSpacing: b.letterSpacing != null ? `${b.letterSpacing}em` : undefined,
                    lineHeight: 1.15,
                    padding: "0 10px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  } as CSSProperties}
                >
                  {b.text}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Format spec line + swatches (unchanged from previous version) ─────────

function fmtSpecLine(p: typeof PAGE_FORMAT_PRESETS[number]): string {
  const parts: string[] = [
    `${p.body.fontSizePt}pt`,
    `${p.body.lineHeight.toFixed(2).replace(/\.?0+$/, "")}× line`,
    p.body.align === "justify" ? "justified" : "left-aligned",
    p.body.indentEm > 0 ? `${p.body.indentEm}em indent` : "block paragraphs",
  ];
  if (p.toc) parts.push("TOC");
  return parts.join(" · ");
}

function FormatPreviewSwatch({ format }: { format: typeof PAGE_FORMAT_PRESETS[number] }) {
  const indented = format.body.indentEm > 0;
  const justified = format.body.align === "justify";
  const lines = [0, 1, 2, 3, 4];
  return (
    <span className="pdf-swatch pdf-swatch--format" aria-hidden="true">
      <span className="pdf-swatch-page">
        {format.runningHeader !== "none" && <span className="pdf-swatch-header" />}
        <span className="pdf-swatch-lines">
          {lines.map((i) => {
            const isFirst = i === 0;
            const isLast = i === lines.length - 1;
            const width = justified
              ? isLast ? "62%" : "100%"
              : isLast ? "55%" : i % 2 === 0 ? "92%" : "96%";
            const ml = isFirst && indented ? "10%" : "0";
            return (
              <span
                key={i}
                className="pdf-swatch-line"
                style={{ width, marginLeft: ml } as CSSProperties}
              />
            );
          })}
        </span>
        {format.pageNumbers !== "none" && (
          <span
            className="pdf-swatch-footer"
            style={{
              justifyContent: format.pageNumbers === "outer" ? "flex-end" : "center",
            } as CSSProperties}
          >
            <span className="pdf-swatch-pgnum" />
          </span>
        )}
      </span>
    </span>
  );
}

function PaperPreviewSwatch({ widthIn, heightIn }: { widthIn: number; heightIn: number }) {
  const maxW = 36, maxH = 46;
  const scale = Math.min(maxW / widthIn, maxH / heightIn);
  const w = widthIn * scale;
  const h = heightIn * scale;
  return (
    <span className="pdf-swatch pdf-swatch--paper" aria-hidden="true">
      <span
        className="pdf-swatch-paperRect"
        style={{ width: `${w}px`, height: `${h}px` } as CSSProperties}
      />
    </span>
  );
}

interface LivePreviewProps {
  widthIn: number;
  heightIn: number;
  marginsIn: { top: number; right: number; bottom: number; left: number };
  indentEm: number;
  align: "left" | "justify";
  lineHeight: number;
  hasHeader: boolean;
  hasFooter: boolean;
}

function LivePreview({
  widthIn, heightIn, marginsIn, indentEm, align, lineHeight, hasHeader, hasFooter,
}: LivePreviewProps) {
  const maxW = 200, maxH = 260;
  const scale = Math.min(maxW / widthIn, maxH / heightIn);
  const w = widthIn * scale;
  const h = heightIn * scale;
  const padTop = marginsIn.top * scale;
  const padRight = marginsIn.right * scale;
  const padBot = marginsIn.bottom * scale;
  const padLeft = marginsIn.left * scale;
  const justified = align === "justify";
  const indented = indentEm > 0;
  const lineCount = Math.max(8, Math.round(13 / lineHeight));

  return (
    <div
      className="pdf-preview-page"
      style={{ width: `${w}px`, height: `${h}px` } as CSSProperties}
    >
      <div
        className="pdf-preview-content"
        style={{
          paddingTop: `${padTop}px`,
          paddingRight: `${padRight}px`,
          paddingBottom: `${padBot}px`,
          paddingLeft: `${padLeft}px`,
        } as CSSProperties}
      >
        {hasHeader && <div className="pdf-preview-header" />}
        <div className="pdf-preview-lines">
          {Array.from({ length: lineCount }).map((_, i) => {
            const isFirst = i === 0;
            const isLast = i === lineCount - 1;
            const width = justified
              ? isLast ? "65%" : "100%"
              : isLast ? "55%" : i % 3 === 0 ? "94%" : i % 3 === 1 ? "90%" : "97%";
            const ml = isFirst && indented ? "8%" : "0";
            return (
              <div
                key={i}
                className="pdf-preview-line"
                style={{
                  width,
                  marginLeft: ml,
                  height: `${Math.max(1.2, lineHeight * 1.6)}px`,
                  marginBottom: `${Math.max(2, (lineHeight - 1) * 4)}px`,
                } as CSSProperties}
              />
            );
          })}
        </div>
        {hasFooter && <div className="pdf-preview-footer" />}
      </div>
    </div>
  );
}
