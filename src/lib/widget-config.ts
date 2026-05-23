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

export interface WidgetConfig {
  version: 1;
  order: WidgetConfigEntry[];
}

export const WIDGET_REGISTRY: WidgetMeta[] = [
  { id: "diagnostics",     label: "Diagnostics",       description: "Writer diagnostics and warnings" },
  { id: "shaping",         label: "Shaping",           description: "Narrative shaping analysis" },
  { id: "tension",         label: "Tension",           description: "Scene tension arc and cliffhanger" },
  { id: "structure",       label: "Structure",         description: "Chapter structural analysis" },
  { id: "momentum",        label: "Momentum",          description: "Narrative momentum segments" },
  { id: "cross-arc",       label: "Cross Arc",         description: "Cross-chapter arc comparison" },
  { id: "cross-pacing",    label: "Cross Pacing",      description: "Cross-chapter pacing comparison" },
  { id: "continuity",      label: "Continuity",        description: "Cross-chapter continuity signals" },
  { id: "prose-profile",   label: "Prose Profile",     description: "POV, tense, and prose style" },
  { id: "sensory-balance", label: "Sensory Balance",   description: "Sensory channel distribution" },
  { id: "style-watch",     label: "Style Watch",       description: "Style pattern detection" },
  { id: "rhythm",          label: "Rhythm",            description: "Sentence rhythm and cadence" },
  { id: "repetition",      label: "Repetition",        description: "Phrase and word echo finder" },
  { id: "title-suggester", label: "Title Suggester",   description: "Chapter title suggestions" },
  { id: "character-voice", label: "Character Voice",   description: "Per-character voice profiles" },
  { id: "voice",           label: "Voice",             description: "Dialogue voice and tag patterns" },
  { id: "cast",            label: "Cast",              description: "Speaker frequency and presence" },
  { id: "role",            label: "Role",              description: "Narrative role distribution" },
];

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

export function loadWidgetConfig(extraMetas: WidgetMeta[] = []): WidgetConfig {
  const defaults = mergeWithDefaults([], extraMetas);
  if (isDesktopApp()) return { version: 1, order: defaults };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { version: 1, order: defaults };
    const parsed = JSON.parse(raw) as WidgetConfig;
    if (parsed.version !== 1 || !Array.isArray(parsed.order)) {
      return { version: 1, order: defaults };
    }
    return { version: 1, order: mergeWithDefaults(parsed.order, extraMetas) };
  } catch {
    return { version: 1, order: defaults };
  }
}

export async function loadWidgetConfigFromProject(extraMetas: WidgetMeta[] = []): Promise<WidgetConfig> {
  const persisted = await loadProjectState<WidgetConfig>(PROJECT_KEY);
  if (persisted?.version === 1 && Array.isArray(persisted.order)) {
    return { version: 1, order: mergeWithDefaults(persisted.order, extraMetas) };
  }
  return { version: 1, order: mergeWithDefaults([], extraMetas) };
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
