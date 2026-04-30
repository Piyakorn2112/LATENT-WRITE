import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { WorldData, WorldCharacter } from "../types";
import { findEntityIndex } from "../lib/world-data";
import { CloseIcon } from "./Icon";

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
  // Resolve which world-data record this click maps to (or null if unknown).
  const found = useMemo(
    () => findEntityIndex(worldData, initialName),
    [worldData, initialName],
  );

  // Local working copy. Initialized from world data, or as a stub for new entities.
  const [draft, setDraft] = useState<WorldCharacter>(() => {
    if (found && worldData) {
      const list = worldData[found.kind] as WorldCharacter[];
      return { ...list[found.index] };
    }
    return { name: initialName, aliases: [], role: "", description: "" };
  });

  // The "saved" name the document currently uses. Rename buttons only show
  // when the user has actually changed the name in the form.
  const originalNameRef = useRef(found && worldData
    ? (worldData[found.kind] as WorldCharacter[])[found.index].name
    : initialName,
  );
  const originalName = originalNameRef.current;
  const nameChanged = draft.name.trim().length > 0 && draft.name !== originalName;

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
  // Each edit commits straight through so the textarea highlight refreshes
  // with the new info on the next analysis cycle.
  const commit = (patch: Partial<WorldCharacter>) => {
    const next = { ...draft, ...patch };
    setDraft(next);

    // Resolve current world data shape (default empty)
    const wd: WorldData = {
      characters: worldData?.characters ?? [],
      places: worldData?.places ?? [],
      factions: worldData?.factions ?? [],
    };

    if (found) {
      const list = [...(wd[found.kind] as WorldCharacter[])];
      list[found.index] = next;
      onUpdate({ ...wd, [found.kind]: list });
    } else {
      // New entity — add as a character by default (most common case).
      onUpdate({ ...wd, characters: [...wd.characters, next] });
    }
  };

  const aliasesText = (draft.aliases ?? []).join(", ");

  const doRename = (scope: "chapter" | "book") => {
    onRename(originalName, draft.name.trim(), scope);
    // After rename completes, the entity record's name is already the new
    // value (committed in `commit`). Roll the original ref forward so the
    // buttons hide.
    originalNameRef.current = draft.name.trim();
  };

  return (
    <div ref={cardRef} className="entity-popover liquid-glass" style={pos}>
      <div className="entity-popover-header">
        <span className="entity-popover-eyebrow">
          {found ? "Edit entity" : "New entity"}
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
          onChange={(e) => commit({ name: e.target.value })}
          /* No autoFocus — keep the textarea focused so the user can keep
             typing / deleting without the popover stealing keyboard input.
             They tap into the popover only when they want to edit it. */
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
        <span className="world-field-label">Role</span>
        <input
          className="world-input"
          value={draft.role ?? ""}
          onChange={(e) => commit({ role: e.target.value })}
          placeholder="e.g. Protagonist"
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
