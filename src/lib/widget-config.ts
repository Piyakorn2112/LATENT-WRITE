import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

export interface WidgetMeta {
  id: string;
  label: string;
  description: string;
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
  { id: "diagnostics",     label: "Diagnostics",       description: "Writer diagnostics and warnings" },
  { id: "tension",         label: "Tension",           description: "Scene tension arc, beat structure, momentum, and cliffhanger" },
  { id: "cast",            label: "Cast",              description: "Speaker frequency and presence" },
  { id: "continuity",      label: "Continuity",        description: "Cross-chapter continuity signals" },
  { id: "cross-arc",       label: "Cross Arc",         description: "Neighbouring chapters' tension arcs and cast shifts" },
  { id: "role",            label: "Role",              description: "Narrative role distribution" },
  { id: "shaping",         label: "Shaping",           description: "Narrative shaping analysis" },
  { id: "prose-profile",   label: "Prose Profile",     description: "POV, tense, and prose style" },
  { id: "voice",           label: "Voice",             description: "Dialogue voice, tag patterns, and sensory channels" },
  { id: "rhythm",          label: "Rhythm",            description: "Sentence rhythm and cadence" },
  { id: "repetition",      label: "Repetition",        description: "Phrase and word echo finder" },
  { id: "style-watch",     label: "Style Watch",       description: "Style pattern detection" },
  { id: "character-voice", label: "Character Voice",   description: "Per-character voice profiles" },
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
