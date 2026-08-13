// User preferences persisted to localStorage.
// Kept minimal — just typography + writing goals.

export interface Typography {
  fontFamily: "georgia" | "iowan" | "system" | "sf-pro" | "menlo";
  fontSize: number;     // px
  lineHeight: number;   // unitless multiplier
  measure: number;      // editor max width in ch units
}

export interface WritingGoals {
  dailyWords: number;   // 0 = no goal
}

export interface Preferences {
  typography: Typography;
  goals: WritingGoals;
  /** Set to true once the user dismisses the welcome flow. Missing on first
   *  launch — we use that to decide whether to auto-show onboarding. */
  hasSeenOnboarding?: boolean;
  /** The getting-started dock's dismissal. True = the writer closed it (or
   *  finished the recap); the Help menu's "Getting Started" flips it back. */
  onbChecklistHidden?: boolean;
  funMode?: boolean;
  debugPanel?: boolean;
  sidePanelCompensation?: boolean;
  /** Anthropic API key for Renderer review pass. Stored locally only. */
  apiKey?: string;
  /** Model ID for Renderer review. Defaults to Haiku if unset. */
  reviewModel?: string;
  /** Enable background NLP story graph analysis. Default true. */
  storyNlpEnabled?: boolean;
  /** Enable custom tool plugins from project's tools/ directory. Default false. */
  customToolsEnabled?: boolean;
  /** Split the top toolbar into separate glass groups. Default false. */
  groupTools?: boolean;
  /** Show two chapters side by side. Default false. */
  splitView?: boolean;
  /** Persisted intelligence mode. Default "auto". */
  intelMode?: "off" | "fast" | "default" | "high" | "auto";
  /** Local continuity assistant. Absent = never opted in = dormant. The whole
   *  feature is off until `enabled` is explicitly true, so an old prefs blob
   *  can never turn a model download on by accident. */
  assistant?: {
    enabled: boolean;
    /**
     * ★ THREE NAMED STATES, and `enabled` is now derived from this rather than
     *   the other way round. `off` runs the deterministic engines alone and
     *   downloads nothing; `on` is the 1.7B every prompt in this repo was
     *   measured against; `max` is the 4B thinking model, a bigger download and
     *   a different set of prompts.
     *
     * ★★ `enabled` IS KEPT AND KEPT TRUTHFUL. Half a dozen call sites gate on
     *    it, and a migration that leaves a stale `true` beside `mode: "off"`
     *    would have the model loading for a writer who just switched it off.
     *    Both are written together, always, in `readAssistant`.
     */
    mode?: AssistantMode;
    tier?: "auto" | "small" | "max";
    /** A writer-supplied model URL, used when the pinned source is unreachable. */
    sourceUrl?: string;
  };
}

const DEFAULTS: Preferences = {
  typography: {
    fontFamily: "georgia",
    fontSize: 18,
    lineHeight: 1.7,
    measure: 70,
  },
  goals: {
    dailyWords: 0,
  },
  funMode: false,
  debugPanel: false,
  sidePanelCompensation: false,
  customToolsEnabled: false,
  groupTools: false,
  splitView: false,
  intelMode: "auto",
};

const KEY = "latentwrite:prefs-v1";

export type AssistantMode = "off" | "on" | "max";

/** The registry tier each mode loads. `off` loads nothing. */
export const MODE_TIER: Record<Exclude<AssistantMode, "off">, "small" | "max"> = {
  on: "small",
  max: "max",
};

/** Absent, malformed, or half-written assistant prefs all read as "not opted in".
 *  Returning undefined (rather than `{enabled:false}`) keeps "never asked" and
 *  "asked and declined" the same state — the feature is dormant either way. */
function readAssistant(raw: Preferences["assistant"] | undefined): Preferences["assistant"] {
  if (!raw || typeof raw !== "object") return undefined;
  // ★ MIGRATION, IN THE DIRECTION THAT CANNOT SURPRISE ANYONE. A prefs blob
  //   written before modes existed has `enabled: true` and no mode — that
  //   writer opted into the 1.7B, so they get "on", never "max": a silent
  //   upgrade would start a 2.5 GB download nobody asked for.
  const mode: AssistantMode | undefined =
    raw.mode === "off" || raw.mode === "on" || raw.mode === "max"
      ? raw.mode
      : raw.enabled === true ? "on" : undefined;
  if (!mode || mode === "off") return undefined;
  const tier = mode === "max" ? "max" : raw.tier === "small" ? "small" : "auto";
  // `enabled` is derived, never trusted from disk — see the note on the field.
  return { enabled: true, mode, tier, sourceUrl: raw.sourceUrl };
}

/** The mode a Preferences blob represents. Absent assistant prefs = off. */
export function assistantMode(prefs: Preferences): AssistantMode {
  return prefs.assistant?.mode ?? (prefs.assistant?.enabled ? "on" : "off");
}

export function loadPrefs(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Preferences>;
    return {
      typography: { ...DEFAULTS.typography, ...(p.typography ?? {}) },
      goals: { ...DEFAULTS.goals, ...(p.goals ?? {}) },
      hasSeenOnboarding: p.hasSeenOnboarding,
      onbChecklistHidden: p.onbChecklistHidden === true ? true : undefined,
      funMode: p.funMode ?? DEFAULTS.funMode,
      debugPanel: p.debugPanel ?? DEFAULTS.debugPanel,
      sidePanelCompensation: p.sidePanelCompensation ?? DEFAULTS.sidePanelCompensation,
      apiKey: p.apiKey,
      reviewModel: p.reviewModel,
      storyNlpEnabled: p.storyNlpEnabled ?? true,
      customToolsEnabled: p.customToolsEnabled ?? false,
      groupTools: p.groupTools ?? false,
      splitView: p.splitView ?? false,
      intelMode: (["off", "fast", "default", "high", "auto"] as const).includes(p.intelMode as never)
        ? p.intelMode
        : "auto",
      assistant: readAssistant(p.assistant),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Preferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); }
  catch { /* quota — ignore */ }
}

// Daily totals — keyed by ISO date (YYYY-MM-DD).
const DAILY_KEY = "latentwrite:daily-words-v1";

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadDailyTotal(date: string): number {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    return map[date] ?? 0;
  } catch {
    return 0;
  }
}

export function saveDailyTotal(date: string, words: number): void {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[date] = words;
    // Keep only the last 60 days to bound size.
    const dates = Object.keys(map).sort();
    if (dates.length > 60) {
      for (const d of dates.slice(0, dates.length - 60)) delete map[d];
    }
    localStorage.setItem(DAILY_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

// Body font-family CSS values for the editor.
export const FONT_STACKS: Record<Typography["fontFamily"], string> = {
  georgia: `'Georgia', 'Iowan Old Style', 'Times New Roman', serif`,
  iowan:   `'Iowan Old Style', 'Georgia', 'Times New Roman', serif`,
  system:  `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`,
  "sf-pro":`'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
  menlo:   `'Menlo', 'SF Mono', 'Consolas', 'Monaco', monospace`,
};

export const FONT_LABELS: Record<Typography["fontFamily"], string> = {
  georgia: "Georgia",
  iowan:   "Iowan Old Style",
  system:  "System",
  "sf-pro":"SF Pro",
  menlo:   "Menlo (mono)",
};
