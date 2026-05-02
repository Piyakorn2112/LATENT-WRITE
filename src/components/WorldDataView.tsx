import { useEffect, useMemo, useRef, useState } from "react";
import type {
  WorldData,
  WorldCharacter,
  WorldPlace,
  WorldFaction,
} from "../types";
import { ensureWorldData } from "../lib/world-data";
import { parseNovel } from "../lib/parser";
import {
  CloseIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
  MapPinIcon,
  FlagIcon,
} from "./Icon";

type Tab = "characters" | "places" | "factions";
type Entity = WorldCharacter | WorldPlace | WorldFaction;

interface Props {
  worldData: WorldData | undefined;
  onChange: (next: WorldData) => void;
  onRename: (oldName: string, newName: string, scope: "chapter" | "book") => void;
  onClose: () => void;
}

const TAB_META: Record<Tab, { label: string; Icon: typeof UsersIcon; roleLabel: string }> = {
  characters: { label: "Characters", Icon: UsersIcon, roleLabel: "Role" },
  places:     { label: "Places",     Icon: MapPinIcon, roleLabel: "Type" },
  factions:   { label: "Factions",   Icon: FlagIcon,   roleLabel: "Type" },
};

function newEntity(): Entity {
  return { name: "", aliases: [], role: "", description: "" } as Entity;
}

export function WorldDataView({ worldData, onChange, onRename, onClose }: Props) {
  const wd = useMemo(() => ensureWorldData({ meta: { title: "", author: "", description: "" }, chapters: [], worldData }), [worldData]);
  const [tab, setTab] = useState<Tab>("characters");
  const [selected, setSelected] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const updateList = (next: Entity[]) => {
    onChange({ ...wd, [tab]: next });
  };

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

  return (
    <div
      className="index-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="world-panel liquid-glass">
        <div className="world-header">
          <h2 className="world-title">World</h2>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              style={{ display: "none" }}
              onChange={handleImport}
            />
            <button
              className="icon-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Import world data from file"
              title="Import from .txt — appends to existing entries"
            >
              <UploadIcon size={16} />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close world data">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="world-tabs">
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

        <div className="world-body">
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
  /** Stable key for the (tab, selectedIndex) pair — re-captures originalName on switch. */
  tabKey: string;
  /** Only characters get the rename buttons; places/factions are address-only. */
  isCharacter: boolean;
}) {
  const aliasesText = (entity.aliases ?? []).join(", ");
  const roleField = (entity as WorldCharacter).role ?? (entity as WorldPlace).type ?? "";

  const setRole = (v: string) => {
    if ("role" in entity) onPatch({ role: v } as Partial<Entity>);
    else onPatch({ type: v } as Partial<Entity>);
  };

  // Capture the entity's name when this entry was first opened. The rename
  // buttons appear when the form value drifts away from this baseline.
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
