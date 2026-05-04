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
  /** Easter-egg "fun mode" — toggles whimsical animations on the toolbar
   *  intel orb (bouncy gooey eyes that move and blink). Off by default;
   *  surfaced as a toggle in the settings panel. */
  funMode?: boolean;
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
};

const KEY = "latentwrite:prefs-v1";

export function loadPrefs(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Preferences>;
    return {
      typography: { ...DEFAULTS.typography, ...(p.typography ?? {}) },
      goals: { ...DEFAULTS.goals, ...(p.goals ?? {}) },
      hasSeenOnboarding: p.hasSeenOnboarding,
      funMode: p.funMode ?? DEFAULTS.funMode,
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
