import type { ReactNode, CSSProperties } from "react";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { buildSpeakerPalette, IOS_COLORS, getSpeakerColor, type ColorPair } from "../lib/palette";

const NARRATIVE_COLOR = "#888888";
const ACTION_TEXT     = IOS_COLORS.orange.text;
const BASE_COLOR      = "var(--text-body)";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap any occurrence of a known speaker/entity name inside the given text in
// an EntityTag (light/dark glass tint coloured to the entity's speech-text colour).
// Returns ReactNode children — width is preserved (no padding/margin) so the
// textarea overlay alignment isn't disturbed.
function renderWithEntities(
  text: string,
  speakerNames: string[],
  palette: Map<string, ColorPair>,
  baseStyle: CSSProperties,
  keyPrefix: string,
  onEntityClick?: (name: string, anchor: DOMRect) => void,
): ReactNode[] {
  if (!speakerNames.length) {
    return [<span key={`${keyPrefix}-0`} style={baseStyle}>{text}</span>];
  }
  // Sort longer first so "Mary Sue" matches before "Mary"
  const sorted = [...speakerNames].sort((a, b) => b.length - a.length).map(escapeRegex);
  const re = new RegExp(`\\b(?:${sorted.join("|")})\\b`, "gi");

  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      parts.push(<span key={`${keyPrefix}-t${i++}`} style={baseStyle}>{text.slice(last, idx)}</span>);
    }
    const matched = m[0];
    const canonical = speakerNames.find(n => n.toLowerCase() === matched.toLowerCase()) ?? matched;
    const entityColor = getSpeakerColor(palette, canonical).text;
    parts.push(
      <span
        key={`${keyPrefix}-e${i++}`}
        className="entity-tag liquid-glass"
        style={{ "--entity-color": entityColor } as CSSProperties}
        onClick={onEntityClick ? (e) => {
          // Don't preventDefault — let the underlying textarea still receive
          // the click for cursor positioning when the user is mid-edit.
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onEntityClick(canonical, rect);
        } : undefined}
      >
        <span className="entity-label absolute">
          {matched}
        </span>
      </span>,
    );
    last = idx + matched.length;
  }
  if (last < text.length) {
    parts.push(<span key={`${keyPrefix}-t${i++}`} style={baseStyle}>{text.slice(last)}</span>);
  }
  return parts;
}

// Map each trimmed paragraph back to its start offset in raw content.
function mapPositions(content: string, paragraphs: string[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const p of paragraphs) {
    const i = content.indexOf(p, from);
    const pos = i >= 0 ? i : from;
    out.push(pos);
    from = pos + p.length;
  }
  return out;
}

interface Props {
  content: string;
  paragraphs: string[];
  /** Controls opacity — kept for compatibility (highlight is now persistent). */
  visible?: boolean;
  speechResults: ChapterAnalysisResult["speechResults"];
  /** World-data + auto-extracted entity names — highlighted wherever they appear. */
  knownNames?: string[];
  /** Fires when the user clicks an entity chip; receives the canonical name + anchor rect. */
  onEntityClick?: (name: string, anchor: DOMRect) => void;
}

export function HighlightLayer({
  content, paragraphs, speechResults, knownNames, visible = true, onEntityClick,
}: Props) {
  if (!paragraphs.length || !content) return null;

  const positions = mapPositions(content, paragraphs);
  const nodes: ReactNode[] = [];
  let cursor = 0;

  // Highlightable entities = detected speakers ∪ world-data / auto-extracted names.
  // The union means non-speaking but world-known characters still get tagged.
  const speakerSet = new Set<string>();
  for (const r of speechResults) {
    for (const s of r?.segments ?? []) {
      if (s.speaker) speakerSet.add(s.speaker);
    }
  }
  for (const n of knownNames ?? []) speakerSet.add(n);
  const speakerNames = [...speakerSet];

  // Build palette once per render — first 10 names get iOS palette colours,
  // overflow uses golden-angle HSL distribution.
  const palette = buildSpeakerPalette(speakerNames);

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const paraStart = positions[pi];
    const para      = paragraphs[pi];
    const segs      = speechResults[pi]?.segments ?? [];

    // Gap (newlines) before this paragraph
    if (paraStart > cursor) {
      nodes.push(
        <span key={`gap${pi}`} style={{ color: BASE_COLOR }}>
          {content.slice(cursor, paraStart)}
        </span>,
      );
    }

    const paraNodes: ReactNode[] = [];

    // Colour each speech/narrative segment; leave gaps in base colour
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    let pc = 0;

    for (const seg of sorted) {
      // Plain gap before this segment — entity-scan it too (e.g., free-standing
      // narrative outside any tagged segment).
      if (seg.start > pc) {
        const gapText = para.slice(pc, seg.start);
        paraNodes.push(
          <span key={`bp${seg.start}`}>
            {renderWithEntities(gapText, speakerNames, palette, { color: BASE_COLOR }, `bp${pi}-${seg.start}`, onEntityClick)}
          </span>,
        );
      }
      const color =
        seg.type === "narrative"
          ? NARRATIVE_COLOR
          : seg.speaker
          ? getSpeakerColor(palette, seg.speaker).text
          : ACTION_TEXT;

      const segText = para.slice(seg.start, seg.end);
      const segStyle: CSSProperties = {
        color,
        fontStyle: seg.type === "narrative" ? "italic" : undefined,
      };
      paraNodes.push(
        <span key={`sg${seg.start}`}>
          {renderWithEntities(segText, speakerNames, palette, segStyle, `sg${pi}-${seg.start}`, onEntityClick)}
        </span>,
      );
      pc = seg.end;
    }

    if (pc < para.length) {
      const tailText = para.slice(pc);
      paraNodes.push(
        <span key="tail">
          {renderWithEntities(tailText, speakerNames, palette, { color: BASE_COLOR }, `tail${pi}`, onEntityClick)}
        </span>,
      );
    }

    nodes.push(<span key={`para${pi}`}>{paraNodes}</span>);
    cursor = paraStart + para.length;
  }

  if (cursor < content.length) {
    nodes.push(
      <span key="trail" style={{ color: BASE_COLOR }}>{content.slice(cursor)}</span>,
    );
  }

  return (
    <div
      className="editor-highlight"
      aria-hidden="true"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 0.25s ease" }}
    >
      {nodes}
    </div>
  );
}
