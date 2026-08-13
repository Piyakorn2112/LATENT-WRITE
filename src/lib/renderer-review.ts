import { isSampleModeActive } from "./sample-mode";
import type { ReviewFlag, ReviewResult } from "../types";
import { saveProjectState, loadProjectState, stateTarget } from "./project-manager";

const REVIEW_RESULTS_KEY = "glass-editor:review-results-v1";

export function loadReviewResults(): Record<string, ReviewResult> {
  if (stateTarget() === "project") return {};
  try {
    const raw = localStorage.getItem(REVIEW_RESULTS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ReviewResult>;
  } catch { return {}; }
}

export async function loadReviewResultsFromProject(): Promise<Record<string, ReviewResult> | null> {
  return loadProjectState<Record<string, ReviewResult>>("review-results");
}

export function saveReviewResults(results: Record<string, ReviewResult>): void {
  if (isSampleModeActive()) return;
  if (stateTarget() === "project") {
    // ★ A REFUSED WRITE MUST NOT DROP THE PAYLOAD. The project can close under
    // a live session; route the data to local storage rather than losing it.
    void saveProjectState("review-results", results).then((ok) => { if (!ok) writeLocalResults(results); });
    return;
  }
  writeLocalResults(results);
}

function writeLocalResults(results: Record<string, ReviewResult>): void {
  try { localStorage.setItem(REVIEW_RESULTS_KEY, JSON.stringify(results)); }
  catch { /* quota — ignore */ }
}

const SYSTEM_PROMPT = `You are a prose editor applying the Renderer review protocol. Identify passages that match the failure patterns below. Return a JSON array of found issues only. Do not flag passages that are working correctly.

PATTERNS:
over-explanation — Shows an action or image then immediately explains its meaning in the same sentence or paragraph.
ai-register — Clinical, technical, or documentary prose where physical or emotional grounding belongs instead.
acquisition-backstory — Mid-scene information dump about a character's history, interrupting the present action.
belief-elaboration — A character states a belief or feeling; the narrator then explains what it means, removing reader space.
crowd-quantification — A specific number applied to a group where the count serves no dramatic function.
emotion-label — An abstract emotion word (love, grief, fear, rage) used where a physical gesture or sensation already carries it.

Return JSON array only, no other text:
[{"type":"<pattern-key>","quote":"<exact phrase from text, max 70 chars>","fix":"<one-sentence concrete fix, max 90 chars>"}]
If no issues found, return [].`;

interface IpcParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
}

interface IpcResult {
  ok: boolean;
  status: number;
  body: {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };
}

type ElectronAPI = {
  rendererReview?: (params: IpcParams) => Promise<IpcResult>;
};

function getElectronAPI(): ElectronAPI | undefined {
  return (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
}

export async function runRendererReview(
  chapterId: string,
  chapterText: string,
  apiKey: string,
  model: string,
): Promise<ReviewResult> {
  const api = getElectronAPI();
  if (!api?.rendererReview) {
    throw new Error("Renderer review requires the desktop app. Open in Latent Write to use this feature.");
  }

  const result = await api.rendererReview({
    apiKey,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `Chapter text:\n\n${chapterText.slice(0, 8000)}`,
  });

  if (!result.ok) {
    const msg = result.body?.error?.message;
    if (result.status === 401) throw new Error("Invalid API key. Check your key at console.anthropic.com.");
    if (result.status === 429) throw new Error("Rate limit reached. Wait a moment and try again.");
    throw new Error(msg ?? `API error ${result.status}`);
  }

  const text = result.body?.content?.[0]?.text ?? "[]";
  let flags: ReviewFlag[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) flags = parsed as ReviewFlag[];
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { flags = JSON.parse(match[0]) as ReviewFlag[]; } catch { /* return empty */ }
    }
  }

  return { chapterId, model, timestamp: Date.now(), flags };
}

export const REVIEW_MODELS: Array<{ id: string; label: string; note: string }> = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fast · ~$0.001/review" },
  { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", note: "Recommended · ~$0.015/review" },
  { id: "claude-opus-4-7",           label: "Opus 4.7",  note: "Highest quality · ~$0.08/review" },
];

export const FLAG_COLORS: Record<string, { bg: string; text: string }> = {
  "over-explanation":      { bg: "rgba(251,191,36,0.12)",  text: "#d97706" },
  "ai-register":           { bg: "rgba(96,165,250,0.12)",  text: "#3b82f6" },
  "acquisition-backstory": { bg: "rgba(167,139,250,0.12)", text: "#8b5cf6" },
  "belief-elaboration":    { bg: "rgba(251,191,36,0.12)",  text: "#b45309" },
  "crowd-quantification":  { bg: "rgba(156,163,175,0.12)", text: "#6b7280" },
  "emotion-label":         { bg: "rgba(244,63,94,0.12)",   text: "#e11d48" },
  "annotation":            { bg: "rgba(52,211,153,0.12)",  text: "#059669" },
  "nia":                   { bg: "rgba(251,146,60,0.12)",  text: "#c2410c" },
};

export { type ReviewFlag, type ReviewResult };
