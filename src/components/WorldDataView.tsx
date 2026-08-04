import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Novel,
  WorldData,
  WorldCharacter,
  WorldGenericEntity,
  WorldFaction,
  WorldPlace,
} from "../types";
import { ensureWorldData, scanAndClassify, resolveSpeakerCandidates, autoExtractEntities, type ScanProgress, type ScanResult } from "../lib/world-data";
import { proposeAliases, proposalsFor, type AliasProposal } from "../lib/alias-propose";
import { parseNovel } from "../lib/parser";
import { loadPrefs } from "../lib/preferences";
import { assistantAvailable, assistantRunJSON, cancelWhere } from "../lib/assistant-client";
import {
  ENTITY_REVIEW_TASK,
  applyProposalsToScanResult,
  reviewEntities,
  selectReviewable,
  type EntityReviewChange,
  type EntityReviewEntry,
} from "../lib/entity-review";
import {
  CloseIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
  MapPinIcon,
  FlagIcon,
  SparklesIcon,
  BookOpenIcon,
  ListIcon,
} from "./Icon";

type Tab = "characters" | "places" | "factions" | "entities";
type Entity = WorldCharacter | WorldPlace | WorldFaction | WorldGenericEntity;
type ScanCategory = "characters" | "places" | "factions" | "entities";
type ScanLabel = "character" | "place" | "faction" | "entity";
type ScanPhase = "pick" | "scanning" | "review";

type IntelMode = "off" | "fast" | "default" | "high" | "auto";

interface Props {
  novel: Novel;
  currentChapterId: string | null;
  worldData: WorldData | undefined;
  intelMode: IntelMode;
  adaptiveContext?: AdaptiveInferenceContext;
  onChange: (next: WorldData) => void;
  onEntityPredictionBatch?: (scopeId: string, predictions: AdaptivePredictionTrace[]) => void;
  onEntityPredictionFeedback?: (
    scopeId: string,
    decisions: Array<{ prediction: AdaptivePredictionTrace; correctedLabel: string | null }>,
  ) => void;
  onRename: (oldName: string, newName: string, scope: "chapter" | "book") => void;
  onClose: () => void;
}

const TAB_META: Record<Tab, { label: string; singular: string; Icon: typeof UsersIcon; roleLabel: string }> = {
  characters: { label: "Characters", singular: "character", Icon: UsersIcon, roleLabel: "Role" },
  places:     { label: "Places", singular: "place", Icon: MapPinIcon, roleLabel: "Type" },
  factions:   { label: "Factions", singular: "faction", Icon: FlagIcon, roleLabel: "Type" },
  entities:   { label: "Entities", singular: "entity", Icon: ListIcon, roleLabel: "Type" },
};

const SCAN_CATEGORY_META: Record<ScanCategory, { label: string; Icon: typeof UsersIcon }> = {
  characters: { label: "Characters", Icon: UsersIcon  },
  places:     { label: "Places",     Icon: MapPinIcon },
  factions:   { label: "Factions",   Icon: FlagIcon   },
  entities:   { label: "Entities",   Icon: ListIcon   },
};

// Orb color per intel mode — vivid but not over-saturated
const ORB_COLOR: Record<IntelMode, string> = {
  off:     "#888888",
  auto:    "#2EA84A",
  fast:    "#DC7B19",
  default: "#1071D8",
  high:    "#A828B8",
};

const emptySelected = (): Record<ScanCategory, Set<string>> => ({
  characters: new Set(),
  places:     new Set(),
  factions:   new Set(),
  entities:   new Set(),
});

const scanCategoryForLabel = (label: string | null): ScanCategory | null => {
  if (label === "character") return "characters";
  if (label === "place") return "places";
  if (label === "faction") return "factions";
  if (label === "entity") return "entities";
  return null;
};

// ── Assistant refinement of the scan (invisible) ──────────────────────────
//
// After the deterministic scan finishes, the local model is handed ONLY the
// names the scan itself flagged as uncertain, sees two ±140-char snippets of
// each, and may move them between buckets or drop them entirely as
// "not-a-name". The writer sees a better list and nothing else: no badges, no
// chatter, no new controls. The deterministic result is first-class — it is
// what ships whenever the assistant is off, absent, slow, or wrong-shaped.
//
// The same three helpers exist in CastConfirmOverlay.tsx. They are duplicated
// rather than shared because these two scan surfaces are the only consumers
// and neither owns the other.

/** Share of the progress bar the deterministic scan keeps when a review may
 *  follow; the review coda owns the rest. Never reached in browser mode. */
const REVIEW_PROGRESS_SPLIT = 0.9;

/** The half of the gate that is knowable synchronously, before the scan starts.
 *  False in the browser build, which is what keeps that path unchanged. */
function assistantMayReview(): boolean {
  try {
    return (
      loadPrefs().assistant?.enabled === true &&
      typeof window !== "undefined" &&
      !!window.electronAPI
    );
  } catch {
    return false;
  }
}

const REVIEWABLE_TYPES = new Set(["character", "place", "faction", "entity"]);

/** Scan traces → review entries. The scan's own uncertainty rides along;
 *  `selectReviewable` (not this) decides what is worth a model run. */
function reviewEntriesFromTraces(
  traces: readonly AdaptivePredictionTrace[],
): EntityReviewEntry[] {
  const seen = new Set<string>();
  const entries: EntityReviewEntry[] = [];
  for (const trace of traces) {
    const name = trace.spanText;
    const label = trace.predictedLabel;
    if (!name || seen.has(name) || !label || !REVIEWABLE_TYPES.has(label)) continue;
    seen.add(name);
    entries.push({
      name,
      currentType: label as EntityReviewEntry["currentType"],
      needsReview: trace.needsReview,
      ambiguityGap: trace.ambiguityGap,
    });
  }
  return entries;
}

/**
 * Never throws, never rejects, never blocks the scan on the model: every exit
 * that is not a clean set of proposals returns the scan untouched.
 *
 * `text` is the scanned span in full, but only `usageSnippets` reads it — the
 * model is sent two short windows per name, never the manuscript.
 */
async function refineScanWithAssistant(
  scan: ScanResult,
  traces: readonly AdaptivePredictionTrace[],
  text: string,
  signal: AbortSignal,
  onReviewProgress: (done: number, total: number) => void,
): Promise<{ scan: ScanResult; changes: EntityReviewChange[] }> {
  const untouched = { scan, changes: [] as EntityReviewChange[] };
  try {
    if (!(await assistantAvailable()) || signal.aborted) return untouched;
    // Selection needs the text: the usage counts are what promote a name the
    // scan was CONFIDENTLY wrong about, which its own flags never surface.
    const selected = selectReviewable(reviewEntriesFromTraces(traces), { text });
    if (selected.length === 0) return untouched;

    let done = 0;
    onReviewProgress(done, selected.length);
    const proposals = await reviewEntities(
      { entries: selected, text },
      {
        run: assistantRunJSON,
        isCancelled: () => signal.aborted,
        onProposal: () => onReviewProgress((done += 1), selected.length),
      },
    );
    if (signal.aborted || proposals.length === 0) return untouched;
    return applyProposalsToScanResult(scan, proposals);
  } catch {
    return untouched;
  }
}

/**
 * Keep the traces agreeing with the list the writer is about to tick. The
 * feedback pass reads `predictedLabel` to find the bucket a name was shown in;
 * left stale, every accepted move would be filed as a rejection. Names dropped
 * as `not-a-name` keep their old label on purpose — they are gone from the
 * list, so they read as rejected, which is exactly the signal.
 */
function applyChangesToTraces(
  traces: AdaptivePredictionTrace[],
  changes: readonly EntityReviewChange[],
): AdaptivePredictionTrace[] {
  const moved = new Map<string, string>();
  for (const change of changes) {
    if (change.to !== "not-a-name") moved.set(change.name, change.to);
  }
  if (moved.size === 0) return traces;
  return traces.map((trace) => {
    const label = moved.get(trace.spanText);
    return label ? { ...trace, predictedLabel: label } : trace;
  });
}

function entityRoleValue(entity: Entity | undefined): string {
  if (!entity) return "";
  return (entity as WorldCharacter).role
    ?? (entity as WorldPlace).type
    ?? (entity as WorldFaction).type
    ?? (entity as WorldGenericEntity).type
    ?? "";
}

function mergeEntityAliases(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const group of groups) {
    for (const alias of group ?? []) {
      const trimmed = alias.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      aliases.push(trimmed);
    }
  }
  return aliases;
}

function buildMovedEntity(target: Tab, source: Entity, existingTarget?: Entity): Entity {
  const shared = {
    name: source.name,
    aliases: mergeEntityAliases(existingTarget?.aliases, source.aliases),
    description: existingTarget?.description?.trim() ? existingTarget.description : source.description,
  };
  const movedRole = entityRoleValue(existingTarget) || entityRoleValue(source);

  if (target === "characters") {
    return { ...shared, role: movedRole } satisfies WorldCharacter;
  }

  return { ...shared, type: movedRole } satisfies WorldPlace | WorldFaction | WorldGenericEntity;
}

export function WorldDataView({
  novel, currentChapterId, worldData, intelMode, adaptiveContext,
  onChange, onEntityPredictionBatch, onEntityPredictionFeedback, onRename, onClose,
}: Props) {
  // ── Alias suggestions ───────────────────────────────────────────────────
  //
  // ★ COMPUTED ONLY WHILE THE CHARACTERS TAB IS OPEN, and keyed on the cast
  //   rather than on the manuscript object. proposeAliases walks the whole book
  //   once per candidate name; running it on every keystroke in a description
  //   field would be a scan the writer never asked for.
  const [dismissedAliases, setDismissedAliases] = useState<Set<string>>(() => new Set());
  const hasElectronNarrativeLM = typeof window !== "undefined" && !!((window as Window & {
    electronAPI?: { narrativeLMEmbed?: ((text: string) => Promise<number[] | null>) | undefined };
  }).electronAPI?.narrativeLMEmbed);
  const wd = useMemo(
    () => ensureWorldData({ meta: { title: "", author: "", description: "" }, chapters: [], worldData }),
    [worldData],
  );
  const [tab, setTab]         = useState<Tab>("characters");
  const [selected, setSelected] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Scan state ──────────────────────────────────────────────────────────
  const [scanPhase,    setScanPhase]    = useState<ScanPhase | null>(null);
  const [scanMode,     setScanMode]     = useState<"chapter" | "novel">("chapter");
  const [scanResults,  setScanResults]  = useState<ScanResult>({ characters: [], places: [], factions: [], entities: [] });
  const [scanSelected, setScanSelected] = useState<Record<ScanCategory, Set<string>>>(emptySelected);
  const [scanPredictions, setScanPredictions] = useState<AdaptivePredictionTrace[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  // Run heavy computation after the "scanning" loading state has painted
  useEffect(() => {
    if (scanPhase !== "scanning") return;
    let raf1 = 0;
    let raf2 = 0;
    const controller = new AbortController();

    const scanTexts =
      scanMode === "chapter"
        ? [(novel.chapters.find((c) => c.id === currentChapterId)?.content ?? "")]
        : novel.chapters.map((c) => c.content);

    // Decided before the first byte is scanned so the progress bar can leave
    // room for the review coda instead of jumping backwards from 100%.
    const mayReview = assistantMayReview();

    setScanProgress({
      stage: "extract",
      label: "Preparing scan",
      detail: scanMode === "chapter"
        ? "Chapter 1 / 1"
        : `Chapter 0 / ${Math.max(1, novel.chapters.length)}`,
      completed: 0,
      total: Math.max(1, scanTexts.length),
      fraction: 0,
    });

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void (async () => {
          const predictionTraceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
          const reportReview = (done: number, total: number) =>
            setScanProgress({
              stage: "classify",
              label: "Reviewing ambiguous names",
              detail: `Name ${Math.min(done + 1, total)} / ${total}`,
              completed: done,
              total,
              fraction:
                REVIEW_PROGRESS_SPLIT +
                (1 - REVIEW_PROGRESS_SPLIT) * (done / Math.max(1, total)),
            });
          try {
            const scanned = await scanAndClassify(scanTexts, wd, scanMode === "chapter" ? 1 : 2, {
              adaptiveContext,
              predictionTraceOut,
              onProgress: mayReview
                ? (progress) =>
                    setScanProgress({
                      ...progress,
                      fraction: progress.fraction * REVIEW_PROGRESS_SPLIT,
                    })
                : setScanProgress,
              signal: controller.signal,
              semanticEntityAssist: hasElectronNarrativeLM,
            });
            if (controller.signal.aborted) return;

            const refined = mayReview
              ? await refineScanWithAssistant(
                  scanned,
                  predictionTraceOut.value,
                  scanTexts.join("\n\n"),
                  controller.signal,
                  reportReview,
                )
              : { scan: scanned, changes: [] as EntityReviewChange[] };
            if (controller.signal.aborted) return;

            const results = refined.scan;
            const predictions = applyChangesToTraces(predictionTraceOut.value, refined.changes);
            setScanResults(results);
            setScanPredictions(predictions);
            const scopeId = scanMode === "chapter"
              ? `entity-scan:chapter:${currentChapterId ?? "none"}`
              : "entity-scan:novel";
            onEntityPredictionBatch?.(scopeId, predictions);
            setScanSelected({
              characters: new Set(results.characters),
              places:     new Set(results.places),
              factions:   new Set(results.factions),
              entities:   new Set(results.entities),
            });
            setScanPhase("review");
          } catch (error) {
            if ((error as Error)?.name !== "AbortError") {
              console.error(error);
              setScanPhase(null);
            }
          }
        })();
      });
    });
    return () => {
      controller.abort();
      // `isCancelled` stops the loop between names; this releases the request
      // already in flight so a closed panel cannot hold the single-flight queue.
      if (mayReview) cancelWhere((job) => job.task === ENTITY_REVIEW_TASK);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [adaptiveContext, currentChapterId, hasElectronNarrativeLM, novel.chapters, onEntityPredictionBatch, scanMode, scanPhase, wd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (scanPhase) setScanPhase(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, scanPhase]);

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (!text) return;
      const imported = parseNovel(text).worldData;
      if (!imported) return;
      const mergeList = <T extends { name: string }>(existing: T[], incoming: T[]): T[] => {
        const seen = new Set(existing.map((e) => e.name.toLowerCase()));
        return [...existing, ...incoming.filter((e) => !seen.has(e.name.toLowerCase()))];
      };
      onChange({
        characters: mergeList(wd.characters, imported.characters ?? []),
        places:     mergeList(wd.places,     imported.places     ?? []),
        factions:   mergeList(wd.factions,   imported.factions   ?? []),
        entities:   mergeList(wd.entities ?? [], imported.entities ?? []),
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const list: Entity[] = wd[tab] as Entity[];
  const current = selected !== null ? list[selected] : null;

  const updateList = (next: Entity[]) => onChange({ ...wd, [tab]: next });

  const handleAdd = () => {
    const created = tab === "characters"
      ? ({ name: "", aliases: [], role: "", description: "" } as Entity)
      : ({ name: "", aliases: [], type: "", description: "" } as Entity);
    const next = [...list, created];
    updateList(next);
    setSelected(next.length - 1);
  };

  const handleDelete = (i: number) => {
    const e = list[i];
    if (e.name && !confirm(`Delete "${e.name}"?`)) return;
    const next = list.filter((_, idx) => idx !== i);
    updateList(next);
    if (selected === i) setSelected(null);
    else if (selected !== null && selected > i) setSelected(selected - 1);
  };

  const patchCurrent = (patch: Partial<Entity>) => {
    if (selected === null) return;
    const next = list.map((e, i) => (i === selected ? { ...e, ...patch } : e));
    updateList(next);
  };

  // ── Alias suggestions ───────────────────────────────────────────────────
  //
  // Computed only while the CHARACTERS tab is open and keyed on the cast's
  // names, not on the novel object: proposeAliases walks the whole book once
  // per candidate name, and re-running it on every keystroke in a description
  // field would be a scan nobody asked for.
  const castKey = wd.characters.map((c) => `${c.name}|${(c.aliases ?? []).join(",")}`).join("¶");
  const aliasResult = useMemo(() => {
    if (tab !== "characters" || wd.characters.length === 0) return null;
    const text = novel.chapters.map((c) => c.content).join("\n");
    if (text.trim().length < 200) return null;
    try {
      // ★★ THE UNION, AND THE UNION IS THE WHOLE FIX. resolveSpeakerCandidates
      //    goes through resolveKnownNames, which returns the writer's OWN cast
      //    once worldData is non-empty — so on any real book the proposer would
      //    only ever see names already in the list. It could offer to merge two
      //    entries and could never offer "Lizzy", which is the case the feature
      //    exists for. autoExtractEntities is what reads the manuscript.
      //    Caught only by looking at a render that showed nothing.
      const candidates = [...new Set([
        ...resolveSpeakerCandidates(novel),
        ...autoExtractEntities(novel, 3, 60),
      ])];
      return proposeAliases(wd.characters, candidates, text);
    } catch (err) {
      // ★ SAY SO OUT LOUD. A bare `catch {}` here would report "no suggestions"
      //   for a thrown error and for a book with genuinely nothing to suggest,
      //   identically and forever. This repo has already lost months to that
      //   shape once, in the story-graph LM pass.
      console.warn("[WorldData] alias proposals failed —", err);
      return null;   // a proposal list is a nicety; it never breaks the editor
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, castKey, novel]);

  /** Fold a proposed name into a character, and for a merge remove the entry
   *  it came from. Everything the writer confirms happens HERE — alias-propose
   *  never touches worldData. */
  const acceptAlias = (proposal: AliasProposal) => {
    const characters = wd.characters.map((c) => {
      if (c.name.trim().toLowerCase() !== proposal.character.trim().toLowerCase()) return c;
      const aliases = mergeEntityAliases(c.aliases, [proposal.alias]);
      return { ...c, aliases };
    });
    // A MERGE also removes the duplicate cast entry, carrying its aliases and
    // any description across rather than dropping work the writer has done.
    const next = proposal.kind === "merge"
      ? (() => {
          const doomed = characters.find(
            (c) => c.name.trim().toLowerCase() === proposal.alias.trim().toLowerCase());
          if (!doomed) return characters;
          return characters
            .map((c) => (c.name.trim().toLowerCase() === proposal.character.trim().toLowerCase()
              ? {
                  ...c,
                  aliases: mergeEntityAliases(c.aliases, doomed.aliases, [doomed.name]),
                  description: c.description?.trim() ? c.description : doomed.description,
                  role: (c as WorldCharacter).role?.trim()
                    ? (c as WorldCharacter).role
                    : (doomed as WorldCharacter).role,
                }
              : c))
            .filter((c) => c.name.trim().toLowerCase() !== proposal.alias.trim().toLowerCase());
        })()
      : characters;
    onChange({ ...wd, characters: next as WorldCharacter[] });
    if (proposal.kind === "merge") setSelected(null);
  };

  const dismissAlias = (proposal: AliasProposal) => {
    setDismissedAliases((prev) => {
      const nextSet = new Set(prev);
      nextSet.add(`${proposal.character.toLowerCase()}|${proposal.alias.toLowerCase()}`);
      return nextSet;
    });
  };

  const moveCurrentTo = (targetTab: Tab) => {
    if (selected === null || !current || targetTab === tab) return;

    const buckets: Record<Tab, Entity[]> = {
      characters: [...wd.characters],
      places: [...wd.places],
      factions: [...wd.factions],
      entities: [...(wd.entities ?? [])],
    };

    buckets[tab].splice(selected, 1);

    const existingIndex = buckets[targetTab].findIndex(
      (entry) => entry.name.trim().toLowerCase() === current.name.trim().toLowerCase(),
    );
    const moved = buildMovedEntity(targetTab, current, existingIndex >= 0 ? buckets[targetTab][existingIndex] : undefined);
    if (existingIndex >= 0) buckets[targetTab][existingIndex] = moved;
    else buckets[targetTab].push(moved);

    onChange({
      characters: buckets.characters as WorldCharacter[],
      places: buckets.places as WorldPlace[],
      factions: buckets.factions as WorldFaction[],
      entities: buckets.entities as WorldGenericEntity[],
    });
    setTab(targetTab);
    setSelected(existingIndex >= 0 ? existingIndex : buckets[targetTab].length - 1);
  };

  const startScan = (mode: "chapter" | "novel") => {
    setScanMode(mode);
    setScanResults({ characters: [], places: [], factions: [], entities: [] });
    setScanPredictions([]);
    setScanSelected(emptySelected());
    setScanProgress(null);
    setScanPhase("scanning");
  };

  const toggleScanItem = (cat: ScanCategory, name: string) => {
    setScanSelected((prev) => {
      const next = { ...prev, [cat]: new Set(prev[cat]) };
      if (next[cat].has(name)) next[cat].delete(name);
      else next[cat].add(name);
      return next;
    });
  };

  const totalScanSelected =
    scanSelected.characters.size + scanSelected.places.size + scanSelected.factions.size + scanSelected.entities.size;

  const doRegister = () => {
    const mergeNew = <T extends { name: string }>(
      existing: T[],
      names: string[],
      make: (n: string) => T,
    ): T[] => {
      const seen = new Set(existing.map((e) => e.name.toLowerCase()));
      return [...existing, ...names.filter((n) => !seen.has(n.toLowerCase())).map(make)];
    };
    onChange({
      characters: mergeNew(
        wd.characters,
        [...scanSelected.characters],
        (name) => ({ name, aliases: [], role: "", description: "" } as WorldCharacter),
      ),
      places: mergeNew(
        wd.places,
        [...scanSelected.places],
        (name) => ({ name, aliases: [], type: "", description: "" } as WorldPlace),
      ),
      factions: mergeNew(
        wd.factions,
        [...scanSelected.factions],
        (name) => ({ name, aliases: [], type: "", description: "" } as WorldFaction),
      ),
      entities: mergeNew(
        wd.entities ?? [],
        [...scanSelected.entities],
        (name) => ({ name, aliases: [], type: "", description: "" } as WorldGenericEntity),
      ),
    });
    const scopeId = scanMode === "chapter"
      ? `entity-scan:chapter:${currentChapterId ?? "none"}`
      : "entity-scan:novel";
    onEntityPredictionFeedback?.(
      scopeId,
      scanPredictions.map((prediction) => {
        const category = scanCategoryForLabel(prediction.predictedLabel as ScanLabel | null);
        const correctedLabel =
          category && scanSelected[category]?.has(prediction.spanText)
            ? prediction.predictedLabel
            : null;
        return { prediction, correctedLabel };
      }),
    );
    setScanPhase(null);
  };

  const hasScanResults =
    scanResults.characters.length + scanResults.places.length + scanResults.factions.length + scanResults.entities.length > 0;

  const currentChapter = novel.chapters.find((c) => c.id === currentChapterId);
  const orbColor = ORB_COLOR[intelMode] ?? ORB_COLOR.default;
  const orbActive = scanPhase === "scanning";

  return (
    <div
      className="index-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="world-panel">

        {/* ── Ambient orb — always mounted, CSS-transitioned in/out ── */}
        <div
          className={`world-scan-orb${orbActive ? " world-scan-orb--visible" : ""}`}
          style={{ "--orb-color": orbColor } as CSSProperties}
          aria-hidden="true"
        />

        {/* ── Header ── */}
        <div className="world-header" style={{ position: "relative", zIndex: 1 }}>
          <h2 className="world-title">
            {scanPhase === "pick"     ? "Auto-Scan"   :
             scanPhase === "scanning" ? "Scanning…"   :
             scanPhase === "review"   ? `Scan — ${scanMode === "chapter" ? "Chapter" : "Novel"}` :
             "World"}
          </h2>
          <div style={{ display: "flex", gap: 4 }}>
            {scanPhase === null && (
              <button
                className="icon-btn"
                onClick={() => setScanPhase("pick")}
                aria-label="Auto-scan text for entities"
                title="Auto-scan for characters, places, factions, and entities"
              >
                <SparklesIcon size={16} />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              style={{ display: "none" }}
              onChange={handleImport}
            />
            {scanPhase === null && (
              <button
                className="icon-btn"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Import world data from file"
                title="Import from .txt — appends to existing entries"
              >
                <UploadIcon size={16} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => { if (scanPhase) setScanPhase(null); else onClose(); }}
              aria-label={scanPhase ? "Cancel scan" : "Close world data"}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* ── Scan: Pick mode ── */}
        {scanPhase === "pick" && (
          <div className="world-scan-pick" style={{ position: "relative", zIndex: 1 }}>
            <p className="world-scan-pick-title">
              Scan the text and auto-register characters,<br />places, factions, and institutional entities.
            </p>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "0 2px 10px",
              }}
            >
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--panel-text-4)" }}>
                Entity LM
              </span>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--panel-text-4)" }}>
                {hasElectronNarrativeLM ? "Available" : "Electron required"}
              </span>
            </div>
            <div className="world-scan-mode-row">
              <button
                className="world-scan-mode-btn"
                onClick={() => startScan("chapter")}
                disabled={!currentChapter}
                title={!currentChapter ? "No chapter open" : `Scan "${currentChapter.title || "current chapter"}"`}
              >
                <BookOpenIcon size={14} />
                Current Chapter
              </button>
              <button
                className="world-scan-mode-btn"
                onClick={() => startScan("novel")}
                disabled={novel.chapters.length === 0}
              >
                <ListIcon size={14} />
                Whole Novel
              </button>
            </div>
          </div>
        )}

        {/* ── Scan: Loading ── */}
        {scanPhase === "scanning" && (
          <div className="world-scan-loading" style={{ position: "relative", zIndex: 1 }}>
            <div
              className="world-scan-spinner"
              style={{ "--spinner-color": orbColor } as CSSProperties}
            />
            <span className="world-scan-loading-label">
              Scanning {scanMode === "chapter" ? "chapter" : "novel"}…
            </span>
            {scanProgress && (
              <div className="world-scan-progress-shell">
                <div className="world-scan-progress-head">
                  <span className="world-scan-progress-stage">{scanProgress.label}</span>
                  <span className="world-scan-progress-percent">{Math.round(scanProgress.fraction * 100)}%</span>
                </div>
                <div className="world-scan-progress-track" aria-hidden="true">
                  <div
                    className="world-scan-progress-fill"
                    style={{
                      width: `${Math.max(3, Math.round(scanProgress.fraction * 100))}%`,
                      "--spinner-color": orbColor,
                    } as CSSProperties}
                  />
                </div>
                <div className="world-scan-progress-detail">{scanProgress.detail}</div>
              </div>
            )}
          </div>
        )}

        {/* ── Scan: Review results ── */}
        {scanPhase === "review" && (
          <div className="world-scan-results" style={{ position: "relative", zIndex: 1 }}>
            {hasScanResults ? (
              <>
                <p className="world-scan-pick-title world-scan-pick-title--sm">
                  {scanResults.characters.length + scanResults.places.length + scanResults.factions.length + scanResults.entities.length} new
                  {" "}{scanMode === "chapter" ? "in this chapter" : "across the novel"} — uncheck any to skip.
                </p>
                <div className="world-scan-list">
                  {(["characters", "places", "factions", "entities"] as ScanCategory[]).map((cat) => {
                    const items = scanResults[cat];
                    if (items.length === 0) return null;
                    const { label, Icon } = SCAN_CATEGORY_META[cat];
                    return (
                      <div key={cat} className="world-scan-section">
                        <div className="world-scan-section-title">
                          <Icon size={12} />
                          <span>{label}</span>
                          <span className="world-tab-count">{scanSelected[cat].size}/{items.length}</span>
                        </div>
                        {items.map((name) => (
                          <label key={name} className="world-scan-row">
                            <input
                              type="checkbox"
                              checked={scanSelected[cat].has(name)}
                              onChange={() => toggleScanItem(cat, name)}
                            />
                            <span className="world-scan-row-name">{name}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="world-scan-empty-full">
                No new entities found in {scanMode === "chapter" ? "this chapter" : "the novel"}.
              </div>
            )}
            <div className="world-scan-actions">
              <button
                className="world-scan-register-btn"
                onClick={doRegister}
                disabled={totalScanSelected === 0}
              >
                Register {totalScanSelected > 0 ? `${totalScanSelected} selected` : ""}
              </button>
              <button className="world-scan-back-btn" onClick={() => setScanPhase("pick")}>
                Back
              </button>
            </div>
          </div>
        )}

        {/* ── Normal view ── */}
        {scanPhase === null && (
          <>
            <div className="world-tabs" style={{ position: "relative", zIndex: 1 }}>
              {(Object.keys(TAB_META) as Tab[]).map((t) => {
                const { label, Icon } = TAB_META[t];
                const count = (wd[t] as Entity[]).length;
                return (
                  <button
                    key={t}
                    className={`world-tab ${tab === t ? "world-tab--active" : ""}`}
                    onClick={() => { setTab(t); setSelected(null); }}
                  >
                    <Icon size={14} />
                    <span>{label}</span>
                    {count > 0 && <span className="world-tab-count">{count}</span>}
                  </button>
                );
              })}
            </div>

            <div className="world-body" style={{ position: "relative", zIndex: 1 }}>
              <div className="world-list">
                {list.length === 0 ? (
                  <div className="world-list-empty">
                    No {TAB_META[tab].label.toLowerCase()} yet
                  </div>
                ) : (
                  list.map((e, i) => {
                    const roleish =
                      (e as WorldCharacter).role ?? (e as WorldPlace).type ?? (e as WorldGenericEntity).type ?? "";
                    return (
                      <button
                        key={i}
                        className={`world-row ${selected === i ? "active" : ""}`}
                        onClick={() => setSelected(i)}
                      >
                        <span className="world-row-name">
                          {e.name || <em className="world-row-blank">Untitled</em>}
                        </span>
                        {roleish && <span className="world-row-role">{roleish}</span>}
                        <span
                          className="world-row-delete"
                          onClick={(ev) => { ev.stopPropagation(); handleDelete(i); }}
                          role="button"
                          aria-label="Delete"
                        >
                          <span className="icon-btn" style={{ width: 26, height: 26 }}>
                            <TrashIcon size={14} />
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
                <button className="world-add-btn" onClick={handleAdd}>
                  <PlusIcon size={14} />
                  <span>Add {TAB_META[tab].singular}</span>
                </button>
              </div>

              <div className="world-edit">
                {current ? (
                  <EntityForm
                    entity={current}
                    currentTab={tab}
                    roleLabel={TAB_META[tab].roleLabel}
                    onPatch={patchCurrent}
                    onMoveTo={moveCurrentTo}
                    onRename={onRename}
                    tabKey={`${tab}:${selected}`}
                    isCharacter={tab === "characters"}
                    aliasProposals={
                      tab === "characters" && aliasResult
                        ? proposalsFor(aliasResult, current.name).filter(
                            (pr) => !dismissedAliases.has(
                              `${pr.character.toLowerCase()}|${pr.alias.toLowerCase()}`),
                          )
                        : []
                    }
                    onAcceptAlias={acceptAlias}
                    onDismissAlias={dismissAlias}
                  />
                ) : (
                  <div className="world-edit-empty">
                    {list.length === 0
                      ? `Add a ${TAB_META[tab].singular} to begin.`
                      : "Select an entry to edit."}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ★ SHORT ENOUGH TO SURVIVE THE COLUMN. The first wording ("shares the
 *   surname") truncated to "shares the surn…" between the name and the two
 *   buttons — a reason nobody can read is not a reason. The full phrasing lives
 *   in the row's tooltip, where width is free.
 */
const ALIAS_RULE_WHY: Record<AliasProposal["rule"], string> = {
  "given-name":     "same first name",
  "family-name":    "same surname",
  "title-stripped": "same name, titled",
  hypocorism:       "short form",
  initial:          "initial + surname",
};
const ALIAS_RULE_LONG: Record<AliasProposal["rule"], string> = {
  "given-name":     "shares the given name with this character",
  "family-name":    "shares this character's surname",
  "title-stripped": "the same name, with a title in front of it",
  hypocorism:       "a derivable short form of this name",
  initial:          "an initial plus the same surname",
};

function EntityForm({
  entity, currentTab, roleLabel, onPatch, onMoveTo, onRename, tabKey, isCharacter,
  aliasProposals, onAcceptAlias, onDismissAlias,
}: {
  entity: Entity;
  currentTab: Tab;
  roleLabel: string;
  onPatch: (patch: Partial<Entity>) => void;
  onMoveTo: (target: Tab) => void;
  onRename: (oldName: string, newName: string, scope: "chapter" | "book") => void;
  tabKey: string;
  isCharacter: boolean;
  aliasProposals: AliasProposal[];
  onAcceptAlias: (proposal: AliasProposal) => void;
  onDismissAlias: (proposal: AliasProposal) => void;
}) {
  const aliasesText = (entity.aliases ?? []).join(", ");
  const roleField = (entity as WorldCharacter).role ?? (entity as WorldPlace).type ?? "";

  const setRole = (v: string) => {
    if (isCharacter) onPatch({ role: v } as Partial<Entity>);
    else onPatch({ type: v } as Partial<Entity>);
  };

  const originalNameRef = useRef(entity.name);
  const lastKeyRef = useRef(tabKey);
  if (lastKeyRef.current !== tabKey) {
    lastKeyRef.current = tabKey;
    originalNameRef.current = entity.name;
  }
  const originalName = originalNameRef.current;
  const trimmed = entity.name.trim();
  const showRename = isCharacter && trimmed.length > 0 && trimmed !== originalName;

  const doRename = (scope: "chapter" | "book") => {
    onRename(originalName, trimmed, scope);
    originalNameRef.current = trimmed;
  };

  return (
    <div className="world-form">
      <label className="world-field">
        <span className="world-field-label">Name</span>
        <input
          className="world-input"
          value={entity.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="e.g. Iris Valen"
          autoFocus
        />
      </label>

      {showRename && (
        <div className="world-rename-row">
          <button className="rename-btn" onClick={() => doRename("chapter")}>
            Rename in chapter
          </button>
          <button className="rename-btn" onClick={() => doRename("book")}>
            Rename in entire book
          </button>
        </div>
      )}

      <label className="world-field">
        <span className="world-field-label">Aliases</span>
        <input
          className="world-input"
          value={aliasesText}
          onChange={(e) => {
            const aliases = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            onPatch({ aliases });
          }}
          placeholder="comma-separated, e.g. Iris, The Listener"
        />
      </label>

      {/* Proposals from alias-propose.ts. They sit UNDER the field they write
          into, carry the rule that fired and a verbatim line from the book, and
          do nothing until the writer clicks — the module never touches
          worldData. A merge says so before it is clicked, because it removes an
          entry from the cast. */}
      {isCharacter && aliasProposals.length > 0 && (
        <div className="world-field">
          <span className="world-field-label">
            Also called{aliasProposals.some((p) => p.kind === "merge") ? " · possible duplicate" : ""}
          </span>
          <div className="world-alias-suggest">
            {aliasProposals.map((proposal) => (
              <div key={`${proposal.character}|${proposal.alias}`}>
                <div className="world-alias-row">
                  <span className="world-alias-name">{proposal.alias}</span>
                  {proposal.kind === "merge" && (
                    <span className="world-alias-kind" title="Accepting removes the other cast entry">
                      duplicate
                    </span>
                  )}
                  <span
                    className="world-alias-why"
                    title={`${ALIAS_RULE_LONG[proposal.rule]} · appears ${proposal.occurrences} times`}
                  >
                    {ALIAS_RULE_WHY[proposal.rule]} · {proposal.occurrences}&#215;
                    {proposal.uncertain ? " · unsure" : ""}
                  </span>
                  <span className="world-alias-actions">
                    <button
                      className="world-alias-btn"
                      onClick={() => onAcceptAlias(proposal)}
                      title={proposal.kind === "merge"
                        ? `Fold "${proposal.alias}" into "${proposal.character}" and remove the duplicate entry`
                        : `Add "${proposal.alias}" as an alias`}
                    >
                      {proposal.kind === "merge" ? "Same person" : "Add"}
                    </button>
                    <button className="world-alias-btn" onClick={() => onDismissAlias(proposal)}>
                      No
                    </button>
                  </span>
                </div>
                {proposal.evidence && (
                  <div className="world-alias-evidence" title={proposal.evidence}>
                    &#8230;{proposal.evidence}&#8230;
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <label className="world-field">
        <span className="world-field-label">{roleLabel}</span>
        <input
          className="world-input"
          value={roleField}
          onChange={(e) => setRole(e.target.value)}
          placeholder={roleLabel === "Role" ? "e.g. Protagonist" : "e.g. City"}
        />
      </label>

      <label className="world-field">
        <span className="world-field-label">Description</span>
        <textarea
          className="world-textarea"
          value={entity.description ?? ""}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="A short note that helps you (and the analysis) keep track of this entity."
          rows={5}
        />
      </label>

      <div className="world-field">
        <span className="world-field-label">Move To</span>
        <div className="world-rename-row">
          {(Object.keys(TAB_META) as Tab[])
            .filter((target) => target !== currentTab)
            .map((target) => (
              <button
                key={target}
                className="rename-btn"
                onClick={() => onMoveTo(target)}
                title={`Move this ${TAB_META[currentTab].singular} into ${TAB_META[target].label.toLowerCase()}`}
              >
                {TAB_META[target].label}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
