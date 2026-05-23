/**
 * chapter-dna.ts
 *
 * Formats the already-computed ChapterAnalysis into a compact "chapter brief"
 * (~250–350 tokens) for injection at the top of Claude prompts.
 *
 * Design goals:
 *   - Gives Claude the structural skeleton immediately so it can calibrate
 *     feedback against the chapter's actual function (climax, breather, etc.)
 *   - Replaces Claude's own re-derivation of structure with authoritative local data
 *   - Safe for all command types: purely additive, never truncates chapter text
 */

import type { ChapterAnalysis } from './chapter-analysis';
import type { CharacterVoiceStat, TagVariety } from './character-voice';

// ── Public types ───────────────────────────────────────────────────────────

export interface ChapterDNA {
  /** Compact plain-text brief for prompt injection, ~250–350 tokens. */
  brief: string;
  /** Estimated token count of the brief. */
  tokenEstimate: number;
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function registerLine(signals: ChapterAnalysis['registerSignals']): string {
  const parts: Array<{ label: string; val: number }> = [
    { label: 'literary', val: signals.literary },
    { label: 'expository', val: signals.expository },
    { label: 'action', val: signals.action },
    { label: 'introspective', val: signals.introspective },
  ];
  const top = parts.sort((a, b) => b.val - a.val).filter(p => p.val >= 10);
  if (top.length === 0) return 'mixed';
  return top.slice(0, 3).map(p => `${pct(p.val)} ${p.label}`).join(' · ');
}

function speakerLine(speakers: ChapterAnalysis['speakerCounts']): string {
  if (speakers.length === 0) return 'no attributed dialogue';
  const top = speakers.slice(0, 4);
  const parts = top.map(s => {
    const turnLabel = s.turns === 1 ? '1 turn' : `${s.turns} turns`;
    return `${s.name} (${turnLabel})`;
  });
  const rest = speakers.length > 4 ? ` +${speakers.length - 4} more` : '';
  return parts.join(', ') + rest;
}

function comparativeLine(c: ChapterAnalysis['comparative']): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (Math.abs(c.tensionVsAvg - 1) >= 0.15) {
    const dir = c.tensionVsAvg > 1 ? 'above' : 'below';
    parts.push(`tension ${pct(Math.abs(c.tensionVsAvg - 1) * 100)} ${dir} series avg`);
  }
  if (Math.abs(c.dialogueVsAvg - 1) >= 0.15) {
    const dir = c.dialogueVsAvg > 1 ? 'above' : 'below';
    parts.push(`dialogue ${pct(Math.abs(c.dialogueVsAvg - 1) * 100)} ${dir} series avg`);
  }
  if (Math.abs(c.lengthVsAvg - 1) >= 0.20) {
    const dir = c.lengthVsAvg > 1 ? 'longer' : 'shorter';
    parts.push(`${pct(Math.abs(c.lengthVsAvg - 1) * 100)} ${dir} than avg`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ── Voice fingerprint section ──────────────────────────────────────────────

function voiceSection(voices: CharacterVoiceStat[], tagVariety: TagVariety | undefined): string {
  if (voices.length === 0) return '';
  const lines: string[] = [];
  for (const v of voices.slice(0, 5)) {
    const lenLabel = v.avgLineLength <= 8 ? 'short' : v.avgLineLength < 18 ? 'medium' : 'long';
    const varLabel = v.lineSpan > 20 ? 'varied' : v.lineSpan > 8 ? 'moderate' : 'uniform';
    const mismatch = v.pronounMismatch
      ? ` ⚠ pronoun drift (expected ${v.pronounMismatch.expected}, saw ${v.pronounMismatch.observed})`
      : '';
    lines.push(`  ${v.name}: ${v.speeches} lines · ${lenLabel} avg (${Math.round(v.avgLineLength)} w) · ${varLabel} span${mismatch}`);
  }
  const tagLine = tagVariety && tagVariety.verdict !== 'no-data'
    ? `  Tags: ${tagVariety.verdict} (${pct(tagVariety.saidPct * 100)} said)`
    : '';
  return ['VOICE FINGERPRINTS', ...lines, tagLine].filter(Boolean).join('\n');
}

// ── Compact (single-line) format for scan prompts ─────────────────────────

function compactVoiceLine(voices: CharacterVoiceStat[], tagVariety: TagVariety | undefined): string {
  if (voices.length === 0) return '';
  const top = voices.slice(0, 3).map(v => {
    const len = v.avgLineLength <= 8 ? 'sh' : v.avgLineLength < 18 ? 'md' : 'lg';
    const va  = v.lineSpan > 20 ? 'vary' : v.lineSpan > 8 ? 'mod' : 'unif';
    const drift = v.pronounMismatch ? '⚠' : '';
    return `${v.name}:${len}/${va}${drift}`;
  });
  const tagStr = tagVariety && tagVariety.verdict !== 'no-data'
    ? ` tags:${tagVariety.verdict}` : '';
  return `VOICE: ${top.join(' ')}${tagStr}`;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Build a chapter brief from already-computed analysis data.
 *
 * @param analysis     - ChapterAnalysis from chapter-analysis.ts
 * @param voices       - CharacterVoiceStat[] from profileCharacterVoices (optional)
 * @param tagVariety   - TagVariety from computeTagVariety (optional)
 * @param chapterTitle - chapter title/label for display
 * @param compact      - true = single-line ~100-token format for /scan prompts;
 *                       false (default) = multi-line ~350-token format for writing commands
 */
export function buildChapterDNA(
  analysis: ChapterAnalysis,
  voices?: CharacterVoiceStat[],
  tagVariety?: TagVariety,
  chapterTitle?: string,
  compact = false,
): ChapterDNA {
  const label = chapterTitle?.trim() || 'Chapter';

  const peakPos = analysis.guidance.peakPosition !== null
    ? `@${analysis.guidance.peakPosition}%`
    : '';
  const peakLabel = analysis.peakLabel ? `(${analysis.peakLabel})` : '';

  if (compact) {
    // ── Compact mode: ~80–120 tokens, single block ──────────────────────
    const reg = analysis.registerSignals;
    const topReg = (['literary','action','expository','introspective'] as const)
      .map(k => ({ k, v: reg[k] }))
      .filter(x => x.v >= 15)
      .sort((a, b) => b.v - a.v)
      .slice(0, 2)
      .map(x => `${x.k.slice(0,3)}:${Math.round(x.v)}%`)
      .join('/') || 'mixed';

    const spk = analysis.speakerCounts.slice(0, 3).map(s => `${s.name}×${s.turns}`).join(',');
    const compTag = analysis.comparative
      ? (() => {
          const t = analysis.comparative.tensionVsAvg;
          const d = analysis.comparative.dialogueVsAvg;
          const parts: string[] = [];
          if (Math.abs(t - 1) >= 0.15) parts.push(`T${t > 1 ? '+' : '-'}${Math.round(Math.abs(t - 1) * 100)}%`);
          if (Math.abs(d - 1) >= 0.15) parts.push(`D${d > 1 ? '+' : '-'}${Math.round(Math.abs(d - 1) * 100)}%`);
          return parts.length ? ` [${parts.join(',')}vsAvg]` : '';
        })()
      : '';

    const parts: string[] = [
      `CHAPTER [${analysis.arcShape}/${analysis.chapterRole}] reg:${topReg} peak:${analysis.peakTension}${peakPos}${peakTag(peakLabel)} spk:${spk || 'none'} pace:${analysis.guidance.density}/${analysis.guidance.estimatedMinutes}m${compTag}`,
    ];
    if (voices && voices.length > 0) {
      parts.push(compactVoiceLine(voices, tagVariety));
    }
    const brief = parts.join('\n');
    return { brief, tokenEstimate: Math.round(brief.split(/\s+/).length * 1.35) };
  }

  // ── Full mode: ~250–350 tokens, multi-line ──────────────────────────────
  const compLine = comparativeLine(analysis.comparative);

  const lines: string[] = [
    `CHAPTER BRIEF — ${label}`,
    `Arc: ${analysis.arcShape}  Role: ${analysis.chapterRole}`,
    `Register: ${registerLine(analysis.registerSignals)}`,
    `Peak tension: ${analysis.peakTension}${peakPos ? ' ' + peakPos : ''}${peakLabel ? ' ' + peakLabel : ''}`,
    `Speakers: ${speakerLine(analysis.speakerCounts)}`,
    `Pacing: ${analysis.guidance.density} · ~${analysis.guidance.estimatedMinutes} min`,
    compLine ? `Series comparison: ${compLine}` : null,
  ].filter((l): l is string => l !== null);

  if (voices && voices.length > 0) {
    lines.push('');
    lines.push(voiceSection(voices, tagVariety));
  }

  const brief = lines.join('\n');
  const tokenEstimate = Math.round(brief.split(/\s+/).length * 1.35);

  return { brief, tokenEstimate };
}

function peakTag(label: string): string {
  return label ? ` ${label}` : '';
}

/**
 * Format a compact neighborhood context block from adjacent chapter boundaries.
 * Used to give Claude cross-chapter continuity awareness.
 */
/**
 * @param maxCharsPerSide - character limit per boundary snippet.
 *   200 for scan (workload-sensitive), 400 for writing commands (context-rich).
 */
export function buildNeighborhoodContext(
  prevTail: string | undefined,
  nextHead: string | undefined,
  prevTitle?: string,
  nextTitle?: string,
  maxCharsPerSide = 400,
): string {
  const parts: string[] = ['CHAPTER NEIGHBORHOOD'];
  if (prevTail) {
    const label = prevTitle ? `← Prev (${prevTitle}):` : '← Previous chapter:';
    parts.push(label);
    parts.push(prevTail.trim().slice(0, maxCharsPerSide));
  }
  if (nextHead) {
    const label = nextTitle ? `→ Next (${nextTitle}):` : '→ Next chapter:';
    parts.push(label);
    parts.push(nextHead.trim().slice(0, maxCharsPerSide));
  }
  if (parts.length === 1) return '';
  return parts.join('\n');
}

/**
 * Format continuity signals into a compact brief for /lore and /review.
 */
export function buildContinuityBrief(
  outOfOrder: Array<{ character: string; firstChapter: number; thisChapter: number }>,
  chekhov: Array<{ phrase: string; mentions: number }>,
  handoff: { drift: 'time' | 'place' | 'both' | null; prevTime?: string; thisTime?: string; prevPlace?: string; thisPlace?: string } | null,
): string {
  const lines: string[] = ['CONTINUITY SIGNALS'];
  if (outOfOrder.length > 0) {
    lines.push(`Out-of-order mentions: ${outOfOrder.map(o => `${o.character} (first Ch${o.firstChapter})`).join(', ')}`);
  }
  if (chekhov.length > 0) {
    lines.push(`Introduced-and-unreturned: ${chekhov.slice(0, 5).map(c => c.phrase).join(', ')}`);
  }
  if (handoff?.drift) {
    const parts = [];
    if (handoff.prevTime && handoff.thisTime) parts.push(`time: ${handoff.prevTime} → ${handoff.thisTime}`);
    if (handoff.prevPlace && handoff.thisPlace) parts.push(`place: ${handoff.prevPlace} → ${handoff.thisPlace}`);
    lines.push(`Chapter handoff drift (${handoff.drift}): ${parts.join(' | ')}`);
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}
