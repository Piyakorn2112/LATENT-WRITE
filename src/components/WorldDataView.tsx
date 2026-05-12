import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Novel,
  WorldData,
  WorldCharacter,
  WorldPlace,
  WorldFaction,
} from "../types";
import { ensureWorldData, scanAndClassify, type ScanResult } from "../lib/world-data";
import { parseNovel } from "../lib/parser";
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

type Tab = "characters" | "places" | "factions";
type Entity = WorldCharacter | WorldPlace | WorldFaction;
type ScanCategory = "characters" | "places" | "factions";
type ScanPhase = "pick" | "scanning" | "review";

type IntelMode = "off" | "low" | "default" | "high" | "auto";

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

const TAB_META: Record<Tab, { label: string; Icon: typeof UsersIcon; roleLabel: string }> = {
  characters: { label: "Characters", Icon: UsersIcon, roleLabel: "Role" },
  places:     { label: "Places",     Icon: MapPinIcon, roleLabel: "Type" },
  factions:   { label: "Factions",   Icon: FlagIcon,   roleLabel: "Type" },
};

const SCAN_CATEGORY_META: Record<ScanCategory, { label: string; Icon: typeof UsersIcon }> = {
  characters: { label: "Characters", Icon: UsersIcon  },
  places:     { label: "Places",     Icon: MapPinIcon },
  factions:   { label: "Factions",   Icon: FlagIcon   },
};

// Orb color per intel mode — vivid but not over-saturated
const ORB_COLOR: Record<IntelMode, string> = {
  off:     "#888888",
  auto:    "#2EA84A",
  low:     "#DC7B19",
  default: "#1071D8",
  high:    "#A828B8",
};

function newEntity(): Entity {
  return { name: "", aliases: [], role: "", description: "" } as Entity;
}

const emptySelected = (): Record<ScanCategory, Set<string>> => ({
  characters: new Set(),
  places:     new Set(),
  factions:   new Set(),
});

export function WorldDataView({
  novel, currentChapterId, worldData, intelMode, adaptiveContext,
  onChange, onEntityPredictionBatch, onEntityPredictionFeedback, onRename, onClose,
}: Props) {
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
  const [scanResults,  setScanResults]  = useState<ScanResult>({ characters: [], places: [], factions: [] });
  const [scanSelected, setScanSelected] = useState<Record<ScanCategory, Set<string>>>(emptySelected);
  const [scanPredictions, setScanPredictions] = useState<AdaptivePredictionTrace[]>([]);

  // Run heavy computation after the "scanning" loading state has painted
  useEffect(() => {
    if (scanPhase !== "scanning") return;
    let raf1: number, raf2: number, timer: ReturnType<typeof setTimeout>;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          const text =
            scanMode === "chapter"
              ? (novel.chapters.find((c) => c.id === currentChapterId)?.content ?? "")
              : novel.chapters.map((c) => c.content).join("\n\n");
          const predictionTraceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
          const results = scanAndClassify(text, wd, scanMode === "chapter" ? 2 : 3, {
            adaptiveContext,
            predictionTraceOut,
          });
          setScanResults(results);
          setScanPredictions(predictionTraceOut.value);
          const scopeId = scanMode === "chapter"
            ? `entity-scan:chapter:${currentChapterId ?? "none"}`
            : "entity-scan:novel";
          onEntityPredictionBatch?.(scopeId, predictionTraceOut.value);
          setScanSelected({
            characters: new Set(results.characters),
            places:     new Set(results.places),
            factions:   new Set(results.factions),
          });
          setScanPhase("review");
        }, 0);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [adaptiveContext, currentChapterId, novel.chapters, onEntityPredictionBatch, scanMode, scanPhase, wd]);

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
      });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const list: Entity[] = wd[tab] as Entity[];
  const current = selected !== null ? list[selected] : null;

  const updateList = (next: Entity[]) => onChange({ ...wd, [tab]: next });

  const handleAdd = () => {
    const next = [...list, newEntity()];
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

  const startScan = (mode: "chapter" | "novel") => {
    setScanMode(mode);
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
    scanSelected.characters.size + scanSelected.places.size + scanSelected.factions.size;

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
    });
    const scopeId = scanMode === "chapter"
      ? `entity-scan:chapter:${currentChapterId ?? "none"}`
      : "entity-scan:novel";
    onEntityPredictionFeedback?.(
      scopeId,
      scanPredictions.map((prediction) => {
        const correctedLabel =
          prediction.predictedLabel && scanSelected[`${prediction.predictedLabel}s` as ScanCategory]?.has(prediction.spanText)
            ? prediction.predictedLabel
            : null;
        return { prediction, correctedLabel };
      }),
    );
    setScanPhase(null);
  };

  const hasScanResults =
    scanResults.characters.length + scanResults.places.length + scanResults.factions.length > 0;

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
                title="Auto-scan for characters, places & factions"
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
              Scan the text and auto-register characters,<br />places, and factions.
            </p>
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
          </div>
        )}

        {/* ── Scan: Review results ── */}
        {scanPhase === "review" && (
          <div className="world-scan-results" style={{ position: "relative", zIndex: 1 }}>
            {hasScanResults ? (
              <>
                <p className="world-scan-pick-title world-scan-pick-title--sm">
                  {scanResults.characters.length + scanResults.places.length + scanResults.factions.length} new
                  {" "}{scanMode === "chapter" ? "in this chapter" : "across the novel"} — uncheck any to skip.
                </p>
                <div className="world-scan-list">
                  {(["characters", "places", "factions"] as ScanCategory[]).map((cat) => {
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
                      (e as WorldCharacter).role ?? (e as WorldPlace).type ?? "";
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
                  <span>Add {TAB_META[tab].label.slice(0, -1).toLowerCase()}</span>
                </button>
              </div>

              <div className="world-edit">
                {current ? (
                  <EntityForm
                    entity={current}
                    roleLabel={TAB_META[tab].roleLabel}
                    onPatch={patchCurrent}
                    onRename={onRename}
                    tabKey={`${tab}:${selected}`}
                    isCharacter={tab === "characters"}
                  />
                ) : (
                  <div className="world-edit-empty">
                    {list.length === 0
                      ? `Add a ${TAB_META[tab].label.slice(0, -1).toLowerCase()} to begin.`
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

function EntityForm({
  entity, roleLabel, onPatch, onRename, tabKey, isCharacter,
}: {
  entity: Entity;
  roleLabel: string;
  onPatch: (patch: Partial<Entity>) => void;
  onRename: (oldName: string, newName: string, scope: "chapter" | "book") => void;
  tabKey: string;
  isCharacter: boolean;
}) {
  const aliasesText = (entity.aliases ?? []).join(", ");
  const roleField = (entity as WorldCharacter).role ?? (entity as WorldPlace).type ?? "";

  const setRole = (v: string) => {
    if ("role" in entity) onPatch({ role: v } as Partial<Entity>);
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
    </div>
  );
}
