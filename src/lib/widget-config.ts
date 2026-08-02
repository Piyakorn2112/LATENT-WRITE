import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

export interface WidgetMeta {
  id: string;
  label: string;
  /** Short label for the reorder list. */
  description: string;
  /**
   * What the card SHOWS and HOW TO READ IT, in the writer's language.
   *
   * ★ This is the answer to "I don't know what this widget is telling me".
   *   Two sentences at most: sentence one names the quantity on screen,
   *   sentence two says what a reading of it means. No feature-marketing, no
   *   restating the title. Widgets render it behind a "?" so a writer who
   *   already knows never pays for it.
   */
  help?: string;
}

export interface WidgetConfigEntry {
  id: string;
  enabled: boolean;
}

/**
 * Bump this whenever the SHAPE or the DEFAULT ORDER of the registry changes in
 * a way that a previously-saved profile cannot inherit on its own. See
 * `rebaseToRegistryOrder` for what a bump costs the user (nothing but their
 * hand-sorted order).
 */
export const WIDGET_CONFIG_VERSION = 2 as const;

export interface WidgetConfig {
  version: typeof WIDGET_CONFIG_VERSION;
  order: WidgetConfigEntry[];
}

/** What a load may find on disk: any past version, possibly malformed. */
interface PersistedWidgetConfig {
  version?: number;
  order?: WidgetConfigEntry[];
}

/**
 * The panel's default reading order, top to bottom.
 *
 * The sequence is deliberate, not alphabetical: what's WRONG first
 * (diagnostics), then the chapter's own shape (tension, cast, continuity),
 * then how it sits against its neighbours (cross-arc, role), then craft
 * detail at descending grain (shaping → prose → voice → rhythm → repetition →
 * style → per-character).
 */
export const WIDGET_REGISTRY: WidgetMeta[] = [
  {
    id: "diagnostics", label: "Diagnostics",
    description: "Writer diagnostics and warnings",
    help: "Specific problems found in this chapter, such as unclear attribution or a stalled opening. Each line names the thing to go and look at.",
  },
  {
    id: "tension", label: "Tension",
    description: "Scene tension arc, beat structure, momentum, and cliffhanger",
    help: "How much pressure each paragraph carries, from the first to the last. The peak marks where the chapter turns, and a flat line means nothing is escalating.",
  },
  {
    id: "cast", label: "Cast",
    description: "Speaker frequency and presence",
    help: "Who speaks and how much of the dialogue each character holds. One dominant slice means a single voice is carrying the scene.",
  },
  {
    id: "continuity", label: "Continuity",
    description: "Cross-chapter continuity signals",
    help: "Things that may contradict earlier chapters, including timeline slips, place and time hand-offs, objects introduced and never used again, and knowledge a character could not have yet.",
  },
  {
    id: "cross-arc", label: "Cross Arc",
    description: "Neighbouring chapters' tension arcs and cast shifts",
    help: "This chapter's tension shape beside the chapters before and after it, with who left the story and who arrived. Shows whether it varies the rhythm or repeats it.",
  },
  {
    id: "role", label: "Role",
    description: "Narrative role distribution",
    help: "The job this chapter does in the book, such as buildup, breather or climax, and how its length, tension and dialogue compare with your average chapter.",
  },
  {
    id: "shaping", label: "Shaping",
    description: "Narrative shaping analysis",
    help: "Whether the chapter delivers the effect its structure promises. Over-structured means the scaffolding is doing more work than the prose is.",
  },
  {
    id: "prose-profile", label: "Prose Profile",
    description: "POV, tense, and prose style",
    help: "Point of view and tense as the text actually reads, not as intended, with reading grade, sentence variety, and how much you show against how much you tell.",
  },
  {
    id: "voice", label: "Voice",
    description: "Dialogue voice, tag patterns, and sensory channels",
    help: "The dominant mode of the writing, whether sensory, action or dialogue, which senses you write through most, and the register the prose sits in.",
  },
  {
    id: "rhythm", label: "Rhythm",
    description: "Sentence rhythm and cadence",
    help: "Every sentence in the chapter as one bar, in the order you wrote them. Bars of similar height read monotonous, mixed heights read varied.",
  },
  {
    id: "repetition", label: "Repetition",
    description: "Phrase and word echo finder",
    help: "Exact phrases used more than once, with where each one first appears. Useful for catching echoes you did not intend.",
  },
  {
    id: "style-watch", label: "Style Watch",
    description: "Style pattern detection",
    help: "Habits worth a second look, counting filter words, passive voice, adverbs and clichés, plus sentence openers you repeat.",
  },
  {
    id: "character-voice", label: "Character Voice",
    description: "Per-character voice profiles",
    help: "How each character's dialogue differs, by average line length and how often they speak. Also flags pronouns that do not match a character's profile.",
  },
];

/* The "-v1" here is the STORAGE KEY's own generation, not the schema version —
   they are independent, and this one must not move or every existing profile
   is silently orphaned. Schema versioning lives in the payload. */
const LS_KEY = "latentwrite:widget-config-v1";
const PROJECT_KEY = "widget-config";

function mergeWithDefaults(persisted: WidgetConfigEntry[], extraMetas: WidgetMeta[] = []): WidgetConfigEntry[] {
  const allMetas = [...WIDGET_REGISTRY, ...extraMetas];
  const knownIds = new Set(allMetas.map((w) => w.id));
  const seen = new Set<string>();
  const merged: WidgetConfigEntry[] = [];

  for (const entry of persisted) {
    if (!knownIds.has(entry.id)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }

  for (const w of allMetas) {
    if (seen.has(w.id)) continue;
    merged.push({ id: w.id, enabled: true });
  }

  return merged;
}

/**
 * ONE-TIME v1 → v2 re-base.
 *
 * WHY THIS EXISTS. `mergeWithDefaults` is a pure append-new-at-the-end merge:
 * it preserves whatever order the user has saved and only ever adds unseen ids
 * to the tail. That is exactly right for ADDING a widget, and exactly wrong for
 * REORDERING the registry — a saved profile pins its own sequence, so a new
 * default order would be invisible to every existing user forever. The v2
 * consolidation both removed five widgets and re-sorted the survivors into a
 * deliberate reading order, so it needs a one-shot re-base.
 *
 * WHAT IS OURS VS THEIRS. The *enabled flags are the user's* — a widget they
 * switched off stays off through the migration, no exceptions. The *order
 * default is ours* — it is a design decision, and a profile that predates the
 * decision has no opinion worth preserving about it. So: adopt the new registry
 * order wholesale, carry every surviving id's enabled flag across, drop the ids
 * that no longer exist, and keep persisted tool-plugin widgets (ids outside the
 * registry) at the tail in their persisted relative order — those are the
 * user's installed tools, not our layout, so we never resequence them.
 *
 * Runs once: the next `saveWidgetConfig` writes `version: 2` and this path is
 * never taken again for that profile.
 */
function rebaseToRegistryOrder(persisted: WidgetConfigEntry[]): WidgetConfigEntry[] {
  const enabledById = new Map<string, boolean>();
  for (const e of persisted) {
    if (!e || typeof e.id !== "string") continue;
    if (enabledById.has(e.id)) continue; // first occurrence wins
    enabledById.set(e.id, e.enabled !== false);
  }

  const registryIds = new Set(WIDGET_REGISTRY.map((w) => w.id));
  // Registry order is the new base; the user's on/off choice rides along.
  // An id the profile never saw (a widget added between their last save and
  // now) defaults to enabled, matching mergeWithDefaults.
  const rebased: WidgetConfigEntry[] = WIDGET_REGISTRY.map((w) => ({
    id: w.id,
    enabled: enabledById.get(w.id) ?? true,
  }));

  // Tool-plugin ids: appended in persisted relative order. mergeWithDefaults
  // then drops any whose meta is no longer registered, which is also what
  // retires the five removed widget ids.
  const seen = new Set(registryIds);
  for (const e of persisted) {
    if (!e || typeof e.id !== "string") continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    rebased.push({ id: e.id, enabled: e.enabled !== false });
  }

  return rebased;
}

/**
 * Normalise anything read from storage into a current-version config.
 * Pre-v2 payloads get the one-time re-base; v2+ payloads keep their order and
 * only pick up newly-registered widgets at the tail.
 */
function normalise(parsed: PersistedWidgetConfig, extraMetas: WidgetMeta[]): WidgetConfig {
  const order = Array.isArray(parsed.order) ? parsed.order : [];
  const base = parsed.version === WIDGET_CONFIG_VERSION ? order : rebaseToRegistryOrder(order);
  return { version: WIDGET_CONFIG_VERSION, order: mergeWithDefaults(base, extraMetas) };
}

export function loadWidgetConfig(extraMetas: WidgetMeta[] = []): WidgetConfig {
  const defaults = mergeWithDefaults([], extraMetas);
  if (isDesktopApp()) return { version: WIDGET_CONFIG_VERSION, order: defaults };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { version: WIDGET_CONFIG_VERSION, order: defaults };
    const parsed = JSON.parse(raw) as PersistedWidgetConfig;
    if (!parsed || !Array.isArray(parsed.order)) {
      return { version: WIDGET_CONFIG_VERSION, order: defaults };
    }
    return normalise(parsed, extraMetas);
  } catch {
    return { version: WIDGET_CONFIG_VERSION, order: defaults };
  }
}

export async function loadWidgetConfigFromProject(extraMetas: WidgetMeta[] = []): Promise<WidgetConfig> {
  const persisted = await loadProjectState<PersistedWidgetConfig>(PROJECT_KEY);
  if (persisted && Array.isArray(persisted.order)) {
    return normalise(persisted, extraMetas);
  }
  return { version: WIDGET_CONFIG_VERSION, order: mergeWithDefaults([], extraMetas) };
}

export function saveWidgetConfig(config: WidgetConfig): void {
  if (isDesktopApp()) {
    void saveProjectState(PROJECT_KEY, config);
    return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(config));
  } catch { /* quota */ }
}

export function getWidgetLabel(id: string, extraMetas: WidgetMeta[] = []): string {
  return WIDGET_REGISTRY.find((w) => w.id === id)?.label
    ?? extraMetas.find((w) => w.id === id)?.label
    ?? id;
}

export function getWidgetDescription(id: string, extraMetas: WidgetMeta[] = []): string {
  return WIDGET_REGISTRY.find((w) => w.id === id)?.description
    ?? extraMetas.find((w) => w.id === id)?.description
    ?? "";
}
