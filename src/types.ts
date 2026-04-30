export interface Chapter {
  id: string;
  number: number;
  title: string;
  content: string;
}

export interface NovelMeta {
  title: string;
  author: string;
  description: string;
}

// ── World data — characters, places, factions ─────────────────────────────
// Mirrors the novel-reader's worldData JSON shape so the same speech-detect
// + entity-highlight pipeline can be fed by it.
export interface WorldCharacter {
  name: string;
  aliases?: string[];
  role?: string;
  description?: string;
}

export interface WorldPlace {
  name: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface WorldFaction {
  name: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface WorldData {
  characters: WorldCharacter[];
  places: WorldPlace[];
  factions: WorldFaction[];
}

export interface Novel {
  meta: NovelMeta;
  chapters: Chapter[];
  worldData?: WorldData;
}
