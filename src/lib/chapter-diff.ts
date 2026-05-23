/**
 * chapter-diff.ts
 *
 * Paragraph-level diff for iterative /scan reviews.
 * Identifies which paragraphs changed between the last-reviewed version and the
 * current chapter text, so Claude only re-reads what actually changed.
 *
 * Used ONLY for /scan (iterative workload reduction).
 *
 * Algorithm: simple LCS-based paragraph identity match using 60-char prefix
 * hashes. Avoids expensive NLP — pure string matching on paragraph anchors.
 */

// ── Public types ───────────────────────────────────────────────────────────

export interface ParagraphChange {
  kind: 'added' | 'removed' | 'modified';
  /** Index in the CURRENT chapter (added/modified) or PREVIOUS (removed). */
  index: number;
  /** The paragraph text (current for added/modified, previous for removed). */
  text: string;
}

export interface ChapterDiff {
  /** All detected changes. */
  changes: ParagraphChange[];
  /** Snapshot hash for storing in PersistedRendererChatState. */
  snapshotHash: string;
  /** Whether any changes were detected. */
  hasChanges: boolean;
  /** Quick summary line for display. */
  summary: string;
}

// ── Hashing ────────────────────────────────────────────────────────────────

/** Lightweight deterministic hash of a string (djb2 variant). */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(36);
}

/** Hash the full chapter text for snapshot storage. */
export function hashChapter(text: string): string {
  return hashString(text.trim());
}

/** Split chapter text into paragraphs, normalised the same way as reviewParagraphs. */
function splitParas(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length >= 15);
}

/**
 * Short anchor for LCS paragraph identity matching (20 chars).
 * Short enough to survive mid-sentence edits at word boundaries,
 * long enough to distinguish most paragraphs.
 */
function anchor(para: string): string {
  return para.slice(0, 20).toLowerCase().replace(/\s+/g, ' ');
}

// ── LCS paragraph matching ─────────────────────────────────────────────────

/**
 * Find the longest common subsequence of paragraph anchors between prev and cur.
 * Returns a mapping: cur index → prev index (or -1 if new).
 */
function matchParas(prev: string[], cur: string[]): number[] {
  const n = prev.length, m = cur.length;
  const prevAnchors = prev.map(anchor);
  const curAnchors  = cur.map(anchor);

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (prevAnchors[i - 1] === curAnchors[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get matching
  const curToPrev = new Array<number>(m).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (prevAnchors[i - 1] === curAnchors[j - 1]) {
      curToPrev[j - 1] = i - 1;
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return curToPrev;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Compute the diff between the last-reviewed chapter snapshot and current text.
 *
 * @param prevText  - chapter text at the time of the last Claude review
 * @param curText   - current chapter text
 */
export function diffChapter(prevText: string, curText: string): ChapterDiff {
  const prev = splitParas(prevText);
  const cur  = splitParas(curText);
  const snapshotHash = hashChapter(curText);

  if (prev.length === 0 && cur.length === 0) {
    return { changes: [], snapshotHash, hasChanges: false, summary: 'No paragraphs.' };
  }

  // Identical?
  if (hashChapter(prevText) === hashChapter(curText)) {
    return { changes: [], snapshotHash, hasChanges: false, summary: 'No changes since last review.' };
  }

  const curToPrev = matchParas(prev, cur);

  const changes: ParagraphChange[] = [];

  // Added or modified paragraphs (in cur but not matched, or matched but content changed)
  for (let j = 0; j < cur.length; j++) {
    const pi = curToPrev[j];
    if (pi === -1) {
      changes.push({ kind: 'added', index: j, text: cur[j] });
    } else if (cur[j] !== prev[pi]) {
      // Anchor matched but full content differs → modified
      changes.push({ kind: 'modified', index: j, text: cur[j] });
    }
  }

  // Removed paragraphs (in prev but not matched to any cur)
  const matchedPrevIndices = new Set(curToPrev.filter(p => p >= 0));
  for (let i = 0; i < prev.length; i++) {
    if (!matchedPrevIndices.has(i)) {
      changes.push({ kind: 'removed', index: i, text: prev[i] });
    }
  }

  const added    = changes.filter(c => c.kind === 'added').length;
  const modified = changes.filter(c => c.kind === 'modified').length;
  const removed  = changes.filter(c => c.kind === 'removed').length;

  const parts: string[] = [];
  if (added)    parts.push(`${added} added`);
  if (modified) parts.push(`${modified} modified`);
  if (removed)  parts.push(`${removed} removed`);
  const summary = parts.length > 0
    ? `Since last review: ${parts.join(', ')} paragraph(s).`
    : 'No changes since last review.';

  return { changes, snapshotHash, hasChanges: changes.length > 0, summary };
}

/**
 * Format the diff into a compact block for Claude's scan prompt.
 * Only includes added/modified paragraphs (Claude doesn't need to see deletions
 * unless there's a continuity concern).
 */
export function formatDiffForPrompt(diff: ChapterDiff, prevReviewSummary?: string): string {
  if (!diff.hasChanges) {
    return prevReviewSummary
      ? `PREVIOUS REVIEW FINDINGS (chapter unchanged):\n${prevReviewSummary}`
      : '';
  }

  const lines: string[] = ['CHANGES SINCE LAST REVIEW', diff.summary];

  if (prevReviewSummary) {
    lines.push('', 'Previous review summary:', prevReviewSummary);
  }

  const relevantChanges = diff.changes.filter(c => c.kind !== 'removed');
  if (relevantChanges.length > 0) {
    lines.push('', 'Changed paragraphs:');
    for (const change of relevantChanges.slice(0, 8)) {
      lines.push(`[${change.kind} ¶${change.index + 1}] ${change.text.slice(0, 200)}${change.text.length > 200 ? '…' : ''}`);
    }
  }

  return lines.join('\n');
}
