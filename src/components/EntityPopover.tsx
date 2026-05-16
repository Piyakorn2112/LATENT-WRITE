import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { WorldData, WorldCharacter, WorldFaction, WorldGenericEntity, WorldPlace } from "../types";
import { findEntityIndex } from "../lib/world-data";
import { CloseIcon } from "./Icon";

type DraftEntity = WorldCharacter | WorldPlace | WorldFaction | WorldGenericEntity;

interface Props {
  /** Name as clicked in the document — may match a name OR an alias. */
  initialName: string;
  /** Bounding rect of the clicked chip (viewport coordinates). */
  anchor: DOMRect;
  worldData: WorldData | undefined;
  onUpdate: (next: WorldData) => void;
  onRename: (oldName: string, newName: string, scope: "chapter" | "book") => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 300;
const GAP = 8;

export function EntityPopover({
  initialName, anchor, worldData, onUpdate, onRename, onClose,
}: Props) {
  // Stable ref: resolved once at mount, never re-derived from worldData changes.
  // This prevents the stale-found bug where a rename updates the entity's name
  // in worldData and the next useMemo call returns null (old name no longer found),
  // causing subsequent commits to create a new entity instead of updating the slot.
  const foundRef = useRef(findEntityIndex(worldData, initialName));

  // Local working copy. Initialized from world data, or as a stub for new entities.
  const [draft, setDraft] = useState<DraftEntity>(() => {
    if (foundRef.current && worldData) {
      const list = worldData[foundRef.current.kind] as DraftEntity[];
      return { ...list[foundRef.current.index] };
    }
    return { name: initialName, aliases: [], role: "", description: "" };
  });

  // The "saved" name the document currently uses. Rename buttons only show
  // when the user has actually changed the name in the form.
  const originalNameRef = useRef(foundRef.current && worldData
    ? (worldData[foundRef.current.kind] as DraftEntity[])[foundRef.current.index].name
    : initialName,
  );
  const originalName = originalNameRef.current;
  const nameChanged = draft.name.trim().length > 0 && draft.name !== originalName;
  const isCharacterKind = foundRef.current?.kind === "characters" || !("type" in draft);

  // ── Position the popover relative to the anchor ──
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const cardH = card.offsetHeight;
    const winH = window.innerHeight;
    const winW = window.innerWidth;

    // Prefer below the anchor; flip up if not enough room.
    const below = anchor.bottom + GAP;
    const above = anchor.top - cardH - GAP;
    const top = (below + cardH > winH - 16 && above >= 16) ? above : below;

    let left = anchor.left + anchor.width / 2 - POPOVER_WIDTH / 2;
    left = Math.max(12, Math.min(winW - POPOVER_WIDTH - 12, left));

    setPos({
      top: Math.max(12, top) + window.scrollY,
      left: left + window.scrollX,
      visibility: "visible",
    });
  }, [anchor]);

  // Close on Escape and on outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    // Defer mousedown registration so the click that opened the popover
    // doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // ── Persist draft → world data ──
  // Pushes `{ ...draft, ...patch }` to world data immediately. Called for
  // all fields EXCEPT name — the name field only updates local draft state
  // on each keystroke, then calls flushToWorld() on blur/Enter/rename to
  // avoid partial names lighting up in the text mid-typing.
  const commit = (patch: Partial<DraftEntity>) => {
    const next = { ...draft, ...patch };
    setDraft(next);

    const wd: WorldData = {
      characters: worldData?.characters ?? [],
      places: worldData?.places ?? [],
      factions: worldData?.factions ?? [],
      entities: worldData?.entities ?? [],
    };

    if (foundRef.current) {
      const list = [...(wd[foundRef.current.kind] as DraftEntity[])];
      list[foundRef.current.index] = next;
      onUpdate({ ...wd, [foundRef.current.kind]: list });
    } else {
      // Track the slot so subsequent edits (role, aliases, etc.) update the
      // same record instead of creating another new entity each time.
      foundRef.current = { kind: "characters", index: wd.characters.length };
      onUpdate({ ...wd, characters: [...wd.characters, next] });
    }
  };

  // Flush the current draft (including any pending name edit) to world data.
  // Called on name-field blur, Enter, and before rename so the entity record
  // is always up-to-date when the rename runs.
  const flushToWorld = () => commit({});

  const aliasesText = (draft.aliases ?? []).join(", ");

  const doRename = (scope: "chapter" | "book") => {
    // Ensure the new name is committed before the rename runs — both
    // handleWorldChange and handleRename queue React state updates and
    // React applies them in order, so the final state is consistent.
    flushToWorld();
    onRename(originalName, draft.name.trim(), scope);
    originalNameRef.current = draft.name.trim();
  };

  return (
    <div ref={cardRef} className="entity-popover liquid-glass" style={pos}>
      <div className="entity-popover-header">
        <span className="entity-popover-eyebrow">
          {foundRef.current ? "Edit entity" : "New entity"}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close" style={{ width: 26, height: 26 }}>
          <CloseIcon size={14} />
        </button>
      </div>

      <label className="world-field">
        <span className="world-field-label">Name</span>
        <input
          className="world-input"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={flushToWorld}
          onKeyDown={(e) => { if (e.key === "Enter") { flushToWorld(); e.currentTarget.blur(); } }}
          /* No autoFocus — keep the textarea focused so the user can keep
             typing / deleting without the popover stealing keyboard input. */
        />
      </label>

      {nameChanged && (
        <div className="entity-popover-rename">
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
            commit({ aliases });
          }}
          placeholder="comma-separated"
        />
      </label>

      <label className="world-field">
        <span className="world-field-label">{isCharacterKind ? "Role" : "Type"}</span>
        <input
          className="world-input"
          value={(isCharacterKind ? (draft as WorldCharacter).role : (draft as WorldPlace).type) ?? ""}
          onChange={(e) => commit(isCharacterKind ? { role: e.target.value } : { type: e.target.value })}
          placeholder={isCharacterKind ? "e.g. Protagonist" : "e.g. Doctrine"}
        />
      </label>

      <label className="world-field">
        <span className="world-field-label">Description</span>
        <textarea
          className="world-textarea"
          value={draft.description ?? ""}
          onChange={(e) => commit({ description: e.target.value })}
          rows={3}
        />
      </label>
    </div>
  );
}
