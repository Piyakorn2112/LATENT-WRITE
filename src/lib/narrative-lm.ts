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

const EMBED_DIM = 384; // all-MiniLM-L6-v2 output dimension
const MAX_LABEL_CHARS = 62;
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
// Cache for arbitrary anchor embeddings (used by semanticSimilarity)
const _anchorCache = new Map<string, Float32Array>();

function getAssetBaseHref(): string {
  if (typeof window !== "undefined" && window.location?.href) {
    return new URL("./", window.location.href).href;
  }
  return new URL("../../public/", import.meta.url).href;
}

async function getEmbeddingPipeline(): Promise<EmbedFn> {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  _loading = (async () => {
    if (DEV) console.log("[NarrativeLM] Browser fallback: initializing WASM pipeline (Electron should use IPC instead)…");
    const { pipeline, env } = await import("@xenova/transformers");

    // Resolve the app's root URL from the current page when running in the
    // renderer, or from the local workspace when loaded from node-based tools.
    const pageBase = getAssetBaseHref();

    // Point ORT to the bundled WASM files in public/ort-wasm/.
    // Using an absolute URL (not "./") avoids relative-path ambiguity in ORT's
    // internal fetch, and ensures the Vite WASM MIME-type plugin applies.
    env.backends.onnx.wasm.wasmPaths = pageBase + "ort-wasm/";

    // proxy:false — run inference on the main thread, no web worker.
    // Web workers in Electron's file:// renderer can fail to load the worker
    // script, causing the "registerBackend" undefined error.
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;

    // Use bundled model files in public/models/ — fully offline, no download.
    env.allowLocalModels = true;
    env.localModelPath   = pageBase + "models/";
    env.useBrowserCache  = false; // skip IndexedDB — local files are authoritative

    const p = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    _pipe = p as unknown as EmbedFn;
    if (DEV) console.log("[NarrativeLM] ✓ Model ready (local)");
    return _pipe;
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
  // In Electron: delegate to main process (onnxruntime-node, native binaries).
  // This completely bypasses browser WASM / web-worker restrictions.
  const api = getElectronAPI();
  if (api?.narrativeLMEmbed) {
    const arr = await api.narrativeLMEmbed(text.slice(0, 500));
    if (arr) return new Float32Array(arr);
  }
  // Browser/web fallback: use the local WASM pipeline (vite dev server only)
  const pipe = await getEmbeddingPipeline();
  const out  = await pipe(text, { pooling: "mean", normalize: true });
  return out.data.slice(0, EMBED_DIM) as Float32Array;
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
