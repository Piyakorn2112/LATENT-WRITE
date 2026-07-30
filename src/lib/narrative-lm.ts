/**
 * Narrative language model — sentence selection + semantic label dedup.
 *
 * Uses all-MiniLM-L6-v2 (5.6MB quantized) via transformers.js.
 * The active runtime path is intentionally narrow:
 *  1. Story graph enrichment uses the LM to choose the most natural,
 *     event-central sentence inside a paragraph.
 *  2. Story graph can derive a finer-grained event detail tag from the
 *     selected sentence, and very conservatively refine the coarse event type.
 *  3. Story graph dedup uses semantic similarity between generated labels.
 *
 * Coarse event detection stays on the synchronous NLP path.
 */

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;

export type NarrativeEventType =
  | "climax"
  | "confrontation"
  | "revelation"
  | "introduction"
  | "transition"
  | "scene-break";

export type NarrativeEventDetailType =
  | "public-declaration"
  | "irreversible-choice"
  | "ideological-clash"
  | "personal-friction"
  | "truth-landed"
  | "institutional-fault"
  | "absence-felt"
  | "self-possession"
  | "reframing"
  | "arrival"
  | "new-presence"
  | "travel-shift"
  | "time-shift"
  | "quiet-reset"
  | "departure";

export interface NarrativeEventTypePrediction {
  type: NarrativeEventType;
  confidence: number;
  similarity: number;
}

export interface NarrativeEventDetailPrediction {
  detailType: NarrativeEventDetailType;
  detailLabel: string;
  type: NarrativeEventType;
  confidence: number;
  similarity: number;
}

export interface SelectedEventSentence {
  label: string;
  sentence: string;
  anchorSimilarity: number;
  centrality: number;
  quality: number;
  coverage: number;
}

interface LabelSelectionOptions {
  fallbackLabel?: string;
}

// ─── Narrative event anchors ──────────────────────────────────────────────────
// Tuned for literary/intellectual prose — catches verbal confrontations,
// philosophical revelations, and emotional turning points, not just action.
// Anchors calibrated for literary/intellectual prose (Hollow Iris / Root Crown):
// - Catches verbal confrontations and ideological clashes, not just physical ones
// - Catches governance/institutional realizations, not just "realized" action verbs
// - Catches quiet emotional turning points and philosophical declarations
// - Catches absence-sensing events (Root Crown's Network silence)
const EVENT_ANCHORS: Record<string, string> = {
  climax:
    "A character makes an irreversible public declaration, commitment, or action — the emotional or dramatic peak of the chapter, the thing that cannot be walked back",
  confrontation:
    "Two characters argue directly about their values, choices, or relationship — exposing a fundamental disagreement through verbal exchange, ideological opposition, or direct challenge",
  revelation:
    "A character understands something new — a philosophical truth about governance or accountability, an institutional failure, a hidden fact, or a truth about their own nature or limits",
  introduction:
    "A new character, relationship, institution, or setting appears for the first time — establishing a presence that will matter going forward",
  transition:
    "Time passes or the scene shifts — a temporal or spatial change, the narrative moving from one moment or place to another",
  "scene-break":
    "A clear narrative break — the section ends and a new one begins, or a chapter concludes",
};

const EVENT_DETAIL_ANCHORS: Record<NarrativeEventDetailType, {
  label: string;
  type: NarrativeEventType;
  anchor: string;
}> = {
  "public-declaration": {
    label: "public turn",
    type: "climax",
    anchor: "A character makes a public declaration, refusal, or speech that changes the room and cannot be taken back",
  },
  "irreversible-choice": {
    label: "commitment",
    type: "climax",
    anchor: "A character crosses a point of no return through an irreversible decision, vow, or committed act",
  },
  "ideological-clash": {
    label: "ideology",
    type: "confrontation",
    anchor: "Two characters directly oppose each other over beliefs, ethics, interpretation, governance, or values",
  },
  "personal-friction": {
    label: "friction",
    type: "confrontation",
    anchor: "Two characters push against each other through accusation, refusal, emotional tension, or direct relational conflict",
  },
  "truth-landed": {
    label: "truth",
    type: "revelation",
    anchor: "A character realizes, names, or finally understands a truth with new clarity",
  },
  "institutional-fault": {
    label: "institution",
    type: "revelation",
    anchor: "A character sees an institutional failure, governance distortion, or ethical gap more clearly",
  },
  "absence-felt": {
    label: "absence",
    type: "revelation",
    anchor: "A character feels or recognizes an absence, silence, disconnection, or missing presence as newly meaningful",
  },
  "self-possession": {
    label: "selfhood",
    type: "revelation",
    anchor: "A character recognizes their own body, agency, identity, or inner life as fully theirs",
  },
  reframing: {
    label: "reframe",
    type: "revelation",
    anchor: "A character sees a familiar structure, routine, or relationship from a newly altered angle",
  },
  arrival: {
    label: "arrival",
    type: "introduction",
    anchor: "Someone arrives, enters, or appears in a way that establishes a new presence in the scene",
  },
  "new-presence": {
    label: "presence",
    type: "introduction",
    anchor: "A new person, object, institution, or force becomes present and narratively important",
  },
  "travel-shift": {
    label: "travel",
    type: "transition",
    anchor: "The narrative moves through departure, transit, arrival, or a meaningful change in place",
  },
  "time-shift": {
    label: "time",
    type: "transition",
    anchor: "Time passes or the scene moves into a later moment, another part of the day, or a different phase",
  },
  "quiet-reset": {
    label: "reset",
    type: "scene-break",
    anchor: "A quiet scene reset or emotional separation creates a soft but meaningful break between beats",
  },
  departure: {
    label: "departure",
    type: "scene-break",
    anchor: "Someone leaves, a parting lands, or the scene closes through departure or dispersal",
  },
};

const EMBED_DIM = 384; // all-MiniLM output dimension (L6 and L12 both use 384)
const MAX_LABEL_CHARS = 62;

// Ordered preference list — L12 has better semantic quality at comparable size.
// The app will use whichever model is available in public/models/.
const PREFERRED_MODEL_IDS = [
  "Xenova/all-MiniLM-L12-v2",
  "Xenova/all-MiniLM-L6-v2",
] as const;
const LABEL_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "from",
  "with", "without", "into", "onto", "through", "by", "as", "is", "are", "was", "were",
  "be", "been", "being", "that", "this", "these", "those", "it", "its", "their", "his",
  "her", "hers", "they", "them", "she", "he", "we", "you", "i", "there", "here",
]);
const FRAGMENT_START_RE = /^(?:and|but|or|because|though|although|when|while|if|as|with|without|into|onto|through|from|to|for|of|in|on|at|by|about|around|after|before|during|than)\b/i;
const FRAGMENT_END_RE = /(?:[,;:–—-]|\b(?:and|or|but|because|though|although|if|when|while|as|with|without|for|to|of|in|on|at|by|from|than|that|which|who|whose|the|a|an)\b)$/i;
const ATTRIBUTION_ONLY_RE = /^(?:[A-Z][a-z]+|she|he|they)\s+(?:said|asked|replied|answered|told|whispered|murmured|shouted)\b/i;

type EmbedFn = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let _pipe: EmbedFn | null = null;
let _loading: Promise<EmbedFn> | null = null;
let _eventAnchors: Record<string, Float32Array> | null = null;
let _eventDetailAnchors: Record<NarrativeEventDetailType, Float32Array> | null = null;
// Anchor embedding cache (semanticSimilarity + event anchors)
const _anchorCache = new Map<string, Float32Array>();
// Per-session sentence embedding cache — avoids re-embedding identical sentences
// across refineEventType / classifyEventDetail / selectBestLabelCandidate calls.
const _sentenceCache = new Map<string, Float32Array>();

function getAssetBaseHref(): string {
  if (typeof window !== "undefined" && window.location?.href) {
    return new URL("./", window.location.href).href;
  }
  return new URL("../../public/", import.meta.url).href;
}

// ─── Embedding backend seam ───────────────────────────────────────────────────
/**
 * The three environments this module runs in reach the model three different
 * ways, and until this seam existed only two of them were reachable:
 *
 *   Electron  →  IPC to the main process (onnxruntime-node, native binaries)
 *   Browser   →  the local WASM pipeline below
 *   Node      →  NOTHING, and that silence was expensive.
 *
 * `@xenova/transformers` v2 has a top-level `import sharp from "sharp"` in
 * utils/image.js. Electron's main process installs a Module._load stub for it;
 * a plain `tsx scripts/…` run does not, so importing this module under Node
 * threw before it ever reached a model — and `enrichChapterEntryWithLM` catches
 * everything and returns the entry unchanged. The result: every offline event
 * suite reported "the LM changed 0% of labels" and that number described a
 * failed import, not a working model. Nothing logged. Nothing failed.
 *
 * Tests inject a Node-native embedder here instead of fighting that import.
 * Keep the seam even if the sharp problem goes away: an engine whose only
 * inference path is inside Electron cannot be measured, and an unmeasurable
 * engine drifts.
 */
export type Embedder = (text: string) => Promise<Float32Array>;

let _embedderOverride: Embedder | null = null;

/** Install (or clear, with null) an embedding backend. Clears every cache. */
export function setEmbedder(fn: Embedder | null): void {
  _embedderOverride = fn;
  _eventAnchors = null;
  _eventDetailAnchors = null;
  _anchorCache.clear();
  _sentenceCache.clear();
}

/** True when SOME embedding backend is reachable. Callers that degrade
 *  silently should say so out loud instead. */
export function hasEmbedder(): boolean {
  return _embedderOverride !== null || _pipe !== null || getElectronAPI()?.narrativeLMEmbed !== undefined;
}

/**
 * ⚠ THE BROWSER PATH IS UNSUPPORTED. Reported by the project owner: the LM works
 * under Electron only, and this WASM fallback does not, despite the assets being
 * present in public/ort-wasm. It is left in place rather than deleted because the
 * Vite dev server still imports this module and a hard throw here would break
 * `npm run dev` for everything else — but do not build a feature on it, and do
 * not read a passing dev-mode page as evidence that it works.
 *
 * The two paths that DO work:
 *   Electron  — IPC to the main process (onnxruntime-node, native binaries)
 *   Node      — scripts/lm-node-backend.ts, which is what every suite uses
 *
 * Both are native onnxruntime, not WASM. The suites therefore exercise the same
 * runtime the app ships, which is the only reason their numbers are worth
 * anything.
 */
async function getEmbeddingPipeline(): Promise<EmbedFn> {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  _loading = (async () => {
    if (DEV) console.log("[NarrativeLM] Browser fallback: initializing WASM pipeline (Electron should use IPC instead)…");
    const { pipeline, env } = await import("@xenova/transformers");

    const pageBase = getAssetBaseHref();
    env.backends.onnx.wasm.wasmPaths = pageBase + "ort-wasm/";
    // proxy:false — run inference on the main thread; web workers can fail in
    // Electron's file:// renderer, causing "registerBackend" errors.
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.allowLocalModels = true;
    env.localModelPath   = pageBase + "models/";
    env.useBrowserCache  = false;

    // Try each model in preference order; L12 is better but L6 is the fallback.
    for (const modelId of PREFERRED_MODEL_IDS) {
      try {
        const p = await pipeline("feature-extraction", modelId);
        _pipe = p as unknown as EmbedFn;
        if (DEV) console.log(`[NarrativeLM] ✓ Model ready: ${modelId}`);
        return _pipe;
      } catch {
        if (DEV) console.log(`[NarrativeLM] ${modelId} not available, trying next…`);
      }
    }
    throw new Error("[NarrativeLM] No MiniLM model available in public/models/");
  })();
  return _loading;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

type ElectronAPI = { narrativeLMEmbed?: (text: string) => Promise<number[] | null> };
function getElectronAPI(): ElectronAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

async function embed(text: string): Promise<Float32Array> {
  const cached = _sentenceCache.get(text);
  if (cached) return cached;

  let result: Float32Array;
  // An injected backend wins — that is how the offline suites reach a model.
  if (_embedderOverride) {
    result = await _embedderOverride(text);
    _sentenceCache.set(text, result);
    return result;
  }
  // In Electron: delegate to main process (onnxruntime-node, native binaries).
  const api = getElectronAPI();
  if (api?.narrativeLMEmbed) {
    const arr = await api.narrativeLMEmbed(text.slice(0, 500));
    if (arr) {
      result = new Float32Array(arr);
      _sentenceCache.set(text, result);
      return result;
    }
  }
  // Browser/web fallback: use the local WASM pipeline (vite dev server only)
  const pipe = await getEmbeddingPipeline();
  const out  = await pipe(text, { pooling: "mean", normalize: true });
  result = out.data.slice(0, EMBED_DIM) as Float32Array;
  _sentenceCache.set(text, result);
  return result;
}

async function getEventAnchorEmbeddings(): Promise<Record<string, Float32Array>> {
  if (_eventAnchors) return _eventAnchors;
  if (DEV) console.log("[NarrativeLM] Computing event anchor embeddings…");
  const result: Record<string, Float32Array> = {};
  for (const [t, anchor] of Object.entries(EVENT_ANCHORS)) {
    result[t] = await embed(anchor);
  }
  _eventAnchors = result;
  if (DEV) console.log("[NarrativeLM] ✓ Event anchors ready");
  return result;
}

async function getEventDetailAnchorEmbeddings(): Promise<Record<NarrativeEventDetailType, Float32Array>> {
  if (_eventDetailAnchors) return _eventDetailAnchors;
  if (DEV) console.log("[NarrativeLM] Computing event detail anchor embeddings…");
  const result = {} as Record<NarrativeEventDetailType, Float32Array>;
  for (const [detailType, meta] of Object.entries(EVENT_DETAIL_ANCHORS) as Array<[NarrativeEventDetailType, typeof EVENT_DETAIL_ANCHORS[NarrativeEventDetailType]]>) {
    result[detailType] = await embed(meta.anchor);
  }
  _eventDetailAnchors = result;
  if (DEV) console.log("[NarrativeLM] ✓ Event detail anchors ready");
  return result;
}

function splitSentences(text: string): string[] {
  const matched = text.match(/[^.!?…]+(?:[.!?…]+(?:["”]+)?)?/g);
  return (matched ?? text.split(/(?<=[.!?])\s+(?=[A-Z"'"'])/))
    .map(s => s.trim())
    .filter(s => s.length > 6);
}

function cleanLabel(s: string): string {
  const normalized = s
    .replace(/^["""''']+/, "")
    .replace(/["""''']+$/, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= MAX_LABEL_CHARS) return normalized;

  const naturalBoundaries = [", ", " — ", " – ", "; ", ": ", " the way ", " because ", " while ", " when ", " and "];
  for (const marker of naturalBoundaries) {
    const idx = normalized.indexOf(marker);
    if (idx >= 22 && idx <= MAX_LABEL_CHARS + 6) {
      const clause = normalized.slice(0, idx).trim();
      if (clause.length >= 18 && !FRAGMENT_END_RE.test(clause)) {
        return clause;
      }
    }
  }

  const cut = normalized.slice(0, MAX_LABEL_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const clipped = lastSpace > Math.max(16, Math.floor(MAX_LABEL_CHARS * 0.55))
    ? cut.slice(0, lastSpace)
    : cut;
  return `${clipped.trimEnd()}…`;
}

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z]{4,}/g)
    ?.filter(token => !LABEL_STOPWORDS.has(token))
    ?? [];
}

function labelCoverage(candidate: string, fallbackLabel?: string): number {
  if (!fallbackLabel) return 0;
  const tokens = contentTokens(fallbackLabel);
  if (tokens.length === 0) return 0;
  const lower = candidate.toLowerCase();
  const matched = tokens.filter(token => lower.includes(token)).length;
  return matched / tokens.length;
}

function sentenceQuality(sentence: string): number {
  const normalized = sentence.replace(/\s+/g, " ").trim();
  const bare = normalized.replace(/^["“”']+|["“”']+$/g, "").trim();
  const noTerminal = bare.replace(/[.!?…]+$/, "").trim();
  const words = noTerminal ? noTerminal.split(/\s+/).length : 0;
  let score = 0;

  if (/[.!?…]["”']?$/.test(normalized)) score += 0.18;
  else score -= 0.24;

  if (/^[A-Z"“]/.test(normalized)) score += 0.08;
  else score -= 0.08;

  if (FRAGMENT_START_RE.test(noTerminal)) score -= 0.18;
  if (FRAGMENT_END_RE.test(noTerminal)) score -= 0.24;
  else score += 0.08;

  if (words >= 2 && words <= 18) score += 0.16;
  else if (words === 1) score -= 0.3;
  else if (words > 28) score -= 0.12;

  if (ATTRIBUTION_ONLY_RE.test(noTerminal) && words <= 4) score -= 0.18;
  if ((normalized.match(/["“]/g) ?? []).length !== (normalized.match(/["”]/g) ?? []).length) score -= 0.06;

  return score;
}

async function selectBestLabelCandidate(
  paragraphText: string,
  eventType: NarrativeEventType,
  options: LabelSelectionOptions = {},
): Promise<SelectedEventSentence> {
  const anchors = await getEventAnchorEmbeddings();
  const anchorEmb = anchors[eventType] ?? anchors["revelation"];
  const sentences = splitSentences(paragraphText);
  const fallbackSource = paragraphText.split(/[.!?]/)[0] ?? paragraphText;
  const fallbackSentence = options.fallbackLabel ?? fallbackSource;
  const fallback = cleanLabel(fallbackSentence);

  if (sentences.length <= 1) {
    return {
      label: fallback,
      sentence: fallbackSentence.trim() || fallback,
      anchorSimilarity: 0,
      centrality: 0,
      quality: sentenceQuality(fallbackSentence),
      coverage: labelCoverage(fallback, options.fallbackLabel),
    };
  }

  const paraEmb = await embed(paragraphText.slice(0, 500));
  let best: SelectedEventSentence = {
    label: fallback,
    sentence: fallbackSentence.trim() || fallback,
    anchorSimilarity: -1,
    centrality: -1,
    quality: sentenceQuality(fallbackSentence),
    coverage: labelCoverage(fallback, options.fallbackLabel),
  };
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const sent of sentences) {
    if (sent.length < 8) continue;
    const sentEmb = await embed(sent.slice(0, 250));
    const anchorSimilarity = cosine(sentEmb, anchorEmb);
    const centrality = cosine(sentEmb, paraEmb);
    const quality = sentenceQuality(sent);
    const cleaned = cleanLabel(sent);
    const coverage = labelCoverage(cleaned, options.fallbackLabel);
    const total = anchorSimilarity * 0.58 + centrality * 0.18 + quality * 0.45 + coverage * 0.24;

    if (total > bestScore) {
      bestScore = total;
      best = {
        label: cleaned,
        sentence: sent.trim(),
        anchorSimilarity,
        centrality,
        quality,
        coverage,
      };
    }
  }

  if (best.quality < -0.04 && fallback.length >= 6) {
    return {
      label: fallback,
      sentence: fallbackSentence.trim() || fallback,
      anchorSimilarity: best.anchorSimilarity,
      centrality: best.centrality,
      quality: best.quality,
      coverage: best.coverage,
    };
  }

  return best.label.length >= 6 ? best : {
    label: fallback,
    sentence: fallbackSentence.trim() || fallback,
    anchorSimilarity: best.anchorSimilarity,
    centrality: best.centrality,
    quality: best.quality,
    coverage: best.coverage,
  };
}

// ─── Public: label selection (primary LM task) ────────────────────────────────
/**
 * Given a paragraph and the NLP-determined event type, return the sentence
 * from the paragraph that is most semantically central to that event type.
 *
 * This is the LM's focused role: sentence selection for label quality.
 * Type classification is handled by NLP (it's now well-calibrated and faster).
 */
export async function selectBestLabel(
  paragraphText: string,
  eventType: NarrativeEventType,
  options: LabelSelectionOptions = {},
): Promise<string> {
  const best = await selectBestLabelCandidate(paragraphText, eventType, options);

  if (DEV) {
    console.log(`[NarrativeLM] label:"${best.label}" (${eventType}, anchor:${best.anchorSimilarity.toFixed(2)} central:${best.centrality.toFixed(2)} quality:${best.quality.toFixed(2)} coverage:${best.coverage.toFixed(2)})`);
    console.log(`              para:"${paragraphText.slice(0, 60)}…"`);
  }

  return best.label;
}

export async function selectBestEventSentence(
  paragraphText: string,
  eventType: NarrativeEventType,
  options: LabelSelectionOptions = {},
): Promise<SelectedEventSentence> {
  return selectBestLabelCandidate(paragraphText, eventType, options);
}

export async function refineEventType(
  sentenceText: string,
  currentType: NarrativeEventType,
): Promise<NarrativeEventTypePrediction> {
  const normalized = sentenceText.replace(/\s+/g, " ").trim();
  const anchors = await getEventAnchorEmbeddings();
  const sentenceEmb = await embed(normalized.slice(0, 260));

  let bestType = currentType;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  let currentSimilarity = Number.NEGATIVE_INFINITY;

  for (const [type, anchorEmb] of Object.entries(anchors) as Array<[NarrativeEventType, Float32Array]>) {
    const similarity = cosine(sentenceEmb, anchorEmb);
    if (type === currentType) currentSimilarity = similarity;
    const biased = similarity + (type === currentType ? 0.03 : 0);
    if (biased > bestSimilarity) {
      bestType = type;
      bestSimilarity = biased;
    }
  }

  const bestRawSimilarity = bestSimilarity - (bestType === currentType ? 0.03 : 0);
  const structuralCurrent = currentType === "scene-break" || currentType === "transition";
  const canRefine = bestType !== currentType
    && bestRawSimilarity >= (structuralCurrent ? 0.33 : 0.42)
    && (bestRawSimilarity - currentSimilarity) >= (structuralCurrent ? 0.02 : 0.06);

  return {
    type: canRefine ? bestType : currentType,
    confidence: Math.max(0, Math.min(1, (Math.max(bestRawSimilarity, currentSimilarity) - 0.28) / 0.3)),
    similarity: Math.max(bestRawSimilarity, currentSimilarity),
  };
}

export async function classifyEventDetail(
  sentenceText: string,
  currentType?: NarrativeEventType,
): Promise<NarrativeEventDetailPrediction | null> {
  const normalized = sentenceText.replace(/\s+/g, " ").trim();
  if (normalized.length < 8) return null;

  const [detailAnchors, sentenceEmb] = await Promise.all([
    getEventDetailAnchorEmbeddings(),
    embed(normalized.slice(0, 260)),
  ]);

  let best: { detailType: NarrativeEventDetailType; similarity: number; biased: number } | null = null;
  let bestCurrentTypeSimilarity = Number.NEGATIVE_INFINITY;

  for (const detailType of Object.keys(EVENT_DETAIL_ANCHORS) as NarrativeEventDetailType[]) {
    const meta = EVENT_DETAIL_ANCHORS[detailType];
    const similarity = cosine(sentenceEmb, detailAnchors[detailType]);
    const biased = similarity + (currentType && meta.type === currentType ? 0.05 : 0);

    if (currentType && meta.type === currentType) {
      bestCurrentTypeSimilarity = Math.max(bestCurrentTypeSimilarity, similarity);
    }

    if (!best || biased > best.biased) {
      best = { detailType, similarity, biased };
    }
  }

  if (!best || best.similarity < 0.27) return null;

  const meta = EVENT_DETAIL_ANCHORS[best.detailType];
  const margin = currentType ? best.similarity - bestCurrentTypeSimilarity : 0;
  const canRefineType = !currentType
    || meta.type === currentType
    || (best.similarity >= 0.4 && margin >= 0.05);

  if (currentType && meta.type !== currentType && !canRefineType) {
    return null;
  }

  if (DEV) {
    console.log(`[NarrativeLM] detail:"${meta.label}" type:${meta.type} sim:${best.similarity.toFixed(2)} sentence:"${normalized.slice(0, 70)}"`);
  }

  return {
    detailType: best.detailType,
    detailLabel: meta.label,
    type: canRefineType ? meta.type : (currentType ?? meta.type),
    confidence: Math.max(0, Math.min(1, (best.similarity - 0.27) / 0.33)),
    similarity: best.similarity,
  };
}

// ─── Public: arbitrary semantic similarity ────────────────────────────────────

/**
 * Cosine similarity between `text` and a fixed anchor string.
 * Anchor embeddings are cached after first computation.
 * Used by story-graph.ts to collapse semantically duplicate labels.
 */
export async function semanticSimilarity(text: string, anchor: string): Promise<number> {
  let anchorEmb = _anchorCache.get(anchor);
  if (!anchorEmb) {
    anchorEmb = await embed(anchor);
    _anchorCache.set(anchor, anchorEmb);
  }
  const textEmb = await embed(text.slice(0, 300));
  return cosine(textEmb, anchorEmb);
}

// ─── Narrative-type classification, calibrated ────────────────────────────────
/**
 * Classify a clause into the `narrative-events.ts` taxonomy from embeddings.
 *
 * ─── WHY THIS IS SHAPED DIFFERENTLY FROM THE ANCHORS ABOVE ───────────────────
 *
 * `EVENT_ANCHORS` gives each type ONE hand-written sentence and takes a raw
 * cosine. Two documented problems with that, and neither is "embeddings are bad":
 *
 * 1. ONE ANCHOR IS HIGH-VARIANCE. A single sentence per class makes the score
 *    brittle to its exact phrasing, and label-expansion work (QZero and similar)
 *    reports consistent gains from embedding several paraphrases per class and
 *    aggregating. So each type here carries five anchors in deliberately
 *    different registers — plain, institutional, physical, interior — and the
 *    score is the MEAN of the top two, which keeps one lucky paraphrase from
 *    carrying a class while still rewarding agreement.
 *
 * 2. RAW COSINE IS UNCALIBRATED. Some anchors sit closer to all prose than
 *    others, so a class can win on generic affinity rather than on fit. The fix
 *    is the embedding-space analogue of "Calibrate Before Use" (Zhao et al.,
 *    ICML 2021): score a content-free NULL input and subtract that bias per
 *    class. Cheap, no new model, and it targets exactly the failure mode where a
 *    detector looks confident and is measuring nothing.
 *
 * ─── WHAT THE MEASUREMENT ACTUALLY SAID ──────────────────────────────────────
 *
 * `scripts/test-narrative-lm.ts` prints all three variants. On 44 gold clauses:
 *
 *   single anchor, uncalibrated (the old shape)   top-1 27.3%   top-2 34.1%
 *   five anchors, uncalibrated                    top-1 43.2%   top-2 52.3%
 *   five anchors + null calibration               top-1 40.9%   top-2 47.7%
 *
 * So: MULTI-ANCHOR IS A LARGE, REAL WIN. The single-anchor shape sat at 27.3%
 * against a 12.5% chance baseline for eight classes — it was barely working, and
 * that is the honest diagnosis of "anchor cosine is weak" rather than a property
 * of embeddings.
 *
 * NULL CALIBRATION DID NOT HELP, and `calibrate` therefore defaults to FALSE.
 * The published result it comes from ("Calibrate Before Use") is about
 * generative label scoring, and the correction evidently does not transfer to
 * cosine over multi-anchor means here. It costs ~2 points consistently. The code
 * stays because the option makes the claim testable rather than folklore; if the
 * gold set grows and the sign flips, flip the default and say so.
 *
 * AND THE CONCLUSION THAT MATTERS MOST: 43.2% is WORSE than the 55.0% that
 * `narrative-events.ts` gets by reading the clause's VERB. So this classifier is
 * NOT wired into the type path. A verb is stronger evidence of what a clause
 * does than a cosine against a description of a category. Do not "improve" the
 * engine by blending it in without re-running both suites first — at n=22 the
 * LM appeared to win, and that reversed at n=44.
 */
export type NarrativeTypeName =
  | "decision" | "revelation" | "confrontation" | "action"
  | "arrival" | "departure" | "shift" | "state-change";

const NARRATIVE_TYPE_ANCHORS: Record<NarrativeTypeName, string[]> = {
  decision: [
    "A character decides to do something and commits to it.",
    "She refuses, and the refusal cannot be walked back.",
    "The committee accepts the recommendation and adopts it as policy.",
    "He agrees to the terms and signs his name to them.",
    "She chose the harder option knowing what it would cost.",
  ],
  revelation: [
    "A character learns something that changes what they believe.",
    "She told him the truth she had been keeping.",
    "He understood, for the first time, what had actually happened.",
    "The record revealed a fact nobody had admitted before.",
    "She admitted that she had known about it for years.",
  ],
  confrontation: [
    "Two characters come into open opposition.",
    "She accused him directly and he denied it.",
    "They argued about what the decision had really meant.",
    "He challenged her account in front of everyone.",
    "She raised her voice and refused to let it pass.",
  ],
  action: [
    "A character does something physical that has consequences.",
    "She wrote the report and sealed it in the archive.",
    "He broke the seal and took the documents out.",
    "She handed over the key and closed the case.",
    "They installed the replacement and brought it online.",
  ],
  arrival: [
    "Someone arrives and their presence changes the situation.",
    "She reached the station after four days of transit.",
    "The delegation entered the chamber and took their seats.",
    "He came back into the room and everyone stopped talking.",
    "A new liaison joined the committee that morning.",
  ],
  departure: [
    "Someone leaves, and the leaving matters.",
    "She walked out of the hall and did not return.",
    "The ship departed its orbit on the twelfth day.",
    "He left the house before anyone else was awake.",
    "They withdrew from the negotiation entirely.",
  ],
  shift: [
    "Time passes or the scene moves elsewhere.",
    "The next morning the work resumed.",
    "Three weeks later the situation had changed.",
    "That evening, in a different room, the conversation continued.",
    "By the time winter came it was already settled.",
  ],
  "state-change": [
    "A condition of the world changes measurably.",
    "The affected population reached seventy-eight thousand.",
    "The deficit rose to thirty-one percent that week.",
    "One more relay went dark and the count dropped to ten.",
    "The atmospheric processors began to fail across the hemisphere.",
  ],
};

/**
 * Content-free inputs. Their similarity to each class anchor IS that class's
 * bias, and subtracting it is the whole calibration.
 */
const NULL_ANCHORS = [
  "N/A",
  "The text continues.",
  "This is a sentence from a book.",
  "Something is described here.",
];

let _typeAnchors: Record<NarrativeTypeName, Float32Array[]> | null = null;
let _typeBias: Record<NarrativeTypeName, number> | null = null;

async function getTypeAnchors(): Promise<{
  anchors: Record<NarrativeTypeName, Float32Array[]>;
  bias: Record<NarrativeTypeName, number>;
}> {
  if (_typeAnchors && _typeBias) return { anchors: _typeAnchors, bias: _typeBias };

  const anchors = {} as Record<NarrativeTypeName, Float32Array[]>;
  for (const [type, sentences] of Object.entries(NARRATIVE_TYPE_ANCHORS) as Array<[NarrativeTypeName, string[]]>) {
    anchors[type] = await Promise.all(sentences.map((s) => embed(s)));
  }

  const nulls = await Promise.all(NULL_ANCHORS.map((s) => embed(s)));
  const bias = {} as Record<NarrativeTypeName, number>;
  for (const type of Object.keys(anchors) as NarrativeTypeName[]) {
    let sum = 0;
    for (const n of nulls) sum += topTwoMean(n, anchors[type]);
    bias[type] = sum / nulls.length;
  }

  _typeAnchors = anchors;
  _typeBias = bias;
  return { anchors, bias };
}

/** Mean of the two best anchor similarities. One anchor is noisy; the max of
 *  five rewards an outlier; the top two require a little agreement. */
function topTwoMean(v: Float32Array, anchors: Float32Array[]): number {
  const sims = anchors.map((a) => cosine(v, a)).sort((x, y) => y - x);
  return sims.length >= 2 ? (sims[0] + sims[1]) / 2 : (sims[0] ?? 0);
}

export interface NarrativeTypePrediction {
  type: NarrativeTypeName;
  /** Calibrated score of the winner. */
  score: number;
  /** Gap to the runner-up. A small margin means "the LM does not really know". */
  margin: number;
  ranked: Array<{ type: NarrativeTypeName; score: number }>;
}

export async function classifyNarrativeType(
  clause: string,
  opts: { calibrate?: boolean; singleAnchor?: boolean } = {},
): Promise<NarrativeTypePrediction | null> {
  const text = clause.replace(/\s+/g, " ").trim();
  if (text.length < 8) return null;

  const { anchors, bias } = await getTypeAnchors();
  const v = await embed(text.slice(0, 300));
  const calibrate = opts.calibrate ?? false;

  const ranked = (Object.keys(anchors) as NarrativeTypeName[])
    .map((type) => {
      const raw = opts.singleAnchor
        ? cosine(v, anchors[type][0]) // the old shape, for comparison
        : topTwoMean(v, anchors[type]);
      return { type, score: calibrate ? raw - bias[type] : raw };
    })
    .sort((a, b) => b.score - a.score);

  return {
    type: ranked[0].type,
    score: ranked[0].score,
    margin: ranked[0].score - (ranked[1]?.score ?? 0),
    ranked,
  };
}

// ─── Salience: is this clause a plot event, or scene description? ─────────────
/**
 * A CONTRASTIVE two-way score, which is the shape this model is actually good at.
 *
 * `scripts/test-narrative-lm.ts` measured both jobs on the same model:
 *
 *   eight-way type classification   43.2% top-1   (worse than reading the verb)
 *   paraphrase vs unrelated         margins 0.56 to 0.85, every pair
 *
 * So the model is weak at fine categorical judgement and strong at "are these two
 * things alike". This function only ever asks it the second question. It scores a
 * clause against a set of anchors describing consequential plot events and against
 * a set describing stage business, and returns the DIFFERENCE. A single anchor set
 * with a threshold would inherit all the calibration problems that made the
 * eight-way version unreliable; a difference between two sets cancels the
 * model's generic affinity for prose.
 *
 * This is the lever aimed at precision, which the heuristic engine could not move:
 * its false positives score as high as its true positives because a change verb
 * with an agent looks the same either way at the surface.
 */
const EVENT_SALIENCE_ANCHORS = [
  "A decision is made that cannot be taken back.",
  "Someone learns a fact that changes what they believe.",
  "Two people come into open conflict about something that matters.",
  "An institution rules, votes, or formally adopts a measure.",
  "Someone dies, leaves for good, or is lost.",
  "A person admits something they had kept hidden.",
  "A measured condition crosses a threshold with consequences.",
  "Someone refuses, and the refusal changes the situation.",
];

const DESCRIPTION_ANCHORS = [
  "The room is described, its light and furniture and quiet.",
  "A character makes a small gesture with their hands.",
  "The weather changes and the season turns.",
  "Someone crosses a room, sits down, or picks up a cup.",
  "The narrator describes how something looked and smelled.",
  "A habit is described as something that happens every day.",
  "Someone remembers how things used to be.",
  "A character walks from one part of the building to another.",
];

let _salienceAnchors: { event: Float32Array[]; description: Float32Array[] } | null = null;

async function getSalienceAnchors() {
  if (_salienceAnchors) return _salienceAnchors;
  _salienceAnchors = {
    event: await Promise.all(EVENT_SALIENCE_ANCHORS.map((s) => embed(s))),
    description: await Promise.all(DESCRIPTION_ANCHORS.map((s) => embed(s))),
  };
  return _salienceAnchors;
}

/**
 * Positive means "reads like a plot event"; negative means "reads like scene
 * description". Roughly -0.3 to +0.3 in practice. Uses the mean of the top two
 * anchors on each side, so one lucky phrasing cannot carry the verdict.
 */
export async function eventSalience(clause: string): Promise<number> {
  const text = clause.replace(/\s+/g, " ").trim();
  if (text.length < 8) return 0;
  const { event, description } = await getSalienceAnchors();
  const v = await embed(text.slice(0, 300));
  return topTwoMean(v, event) - topTwoMean(v, description);
}

/** Batched, so a chapter's candidates share one anchor load and one cache. */
export async function eventSalienceBatch(clauses: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const c of clauses) out.push(await eventSalience(c));
  return out;
}
