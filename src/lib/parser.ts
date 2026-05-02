import type { Novel, Chapter, NovelMeta, WorldData } from "../types";
import { emptyWorldData } from "./world-data";

const uid = () => Math.random().toString(36).slice(2, 10);

export function parseNovel(raw: string): Novel {
  const lines = raw.split("\n");
  const meta: NovelMeta = { title: "", subtitle: "", author: "", description: "" };
  const chapters: Chapter[] = [];
  const worldData: WorldData = emptyWorldData();

  let section:
    | "title" | "subtitle" | "author" | "description"
    | "chapter" | "index"
    | "world-json"
    | null = null;
  let currentChapter: Chapter | null = null;
  let buffer: string[] = [];
  let worldBuffer: string[] = [];

  const flush = () => {
    if (currentChapter) {
      while (buffer.length && buffer[buffer.length - 1].trim() === "") buffer.pop();
      currentChapter.content = buffer.join("\n");
      chapters.push(currentChapter);
      currentChapter = null;
      buffer = [];
    }
    if (section === "world-json") {
      const text = worldBuffer.join("\n").trim();
      if (text) {
        try {
          const parsed = JSON.parse(text) as Partial<WorldData>;
          if (Array.isArray(parsed.characters)) worldData.characters = parsed.characters;
          if (Array.isArray(parsed.places)) worldData.places = parsed.places;
          if (Array.isArray(parsed.factions)) worldData.factions = parsed.factions;
        } catch {
          /* malformed JSON — silently drop, novel still loads */
        }
      }
      worldBuffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "===TITLE===")       { flush(); section = "title"; continue; }
    if (trimmed === "===SUBTITLE===")    { flush(); section = "subtitle"; continue; }
    if (trimmed === "===AUTHOR===")      { flush(); section = "author"; continue; }
    if (trimmed === "===DESCRIPTION===") { flush(); section = "description"; continue; }
    if (trimmed === "===INDEX===")       { flush(); section = "index"; continue; }
    if (trimmed === "===WORLD-DATA===")  { flush(); section = "world-json"; continue; }

    const m = trimmed.match(/^===CHAPTER\s+(\d+):\s*(.+?)===$/);
    if (m) {
      flush();
      section = "chapter";
      currentChapter = {
        id: uid(),
        number: parseInt(m[1], 10),
        title: m[2].trim(),
        content: "",
      };
      continue;
    }

    if (section === "title" && trimmed) { meta.title = trimmed; section = null; continue; }
    if (section === "subtitle" && trimmed) { meta.subtitle = trimmed; section = null; continue; }
    if (section === "author" && trimmed) { meta.author = trimmed; section = null; continue; }
    if (section === "description") {
      if (trimmed) meta.description += (meta.description ? " " : "") + trimmed;
      continue;
    }
    if (section === "chapter") buffer.push(line);
    if (section === "world-json") worldBuffer.push(line);
    // index lines are ignored — re-derived from chapters on serialize
  }

  flush();
  const novel: Novel = { meta, chapters };
  if (
    worldData.characters.length || worldData.places.length || worldData.factions.length
  ) {
    novel.worldData = worldData;
  }
  return novel;
}

export function serializeNovel(novel: Novel): string {
  const out: string[] = [];
  out.push("===TITLE===", novel.meta.title || "Untitled", "");
  if (novel.meta.subtitle) out.push("===SUBTITLE===", novel.meta.subtitle, "");
  if (novel.meta.author) out.push("===AUTHOR===", novel.meta.author, "");
  if (novel.meta.description) out.push("===DESCRIPTION===", novel.meta.description, "");

  // World data — embedded as a JSON block so the .txt round-trips losslessly
  const wd = novel.worldData;
  if (wd && (wd.characters?.length || wd.places?.length || wd.factions?.length)) {
    out.push("===WORLD-DATA===");
    out.push(JSON.stringify(
      {
        characters: wd.characters ?? [],
        places: wd.places ?? [],
        factions: wd.factions ?? [],
      },
      null,
      2,
    ));
    out.push("");
  }

  if (novel.chapters.length) {
    out.push("===INDEX===");
    for (const c of novel.chapters) out.push(`${c.number}: ${c.title || `Chapter ${c.number}`}`);
    out.push("");
  }

  for (const c of novel.chapters) {
    out.push(`===CHAPTER ${c.number}: ${c.title || `Chapter ${c.number}`}===`);
    out.push(c.content || "");
    out.push("");
  }
  return out.join("\n");
}

export function newChapter(number: number, title = ""): Chapter {
  return { id: uid(), number, title, content: "" };
}

export function emptyNovel(): Novel {
  return {
    meta: { title: "Untitled", subtitle: "", author: "", description: "" },
    chapters: [],
  };
}
