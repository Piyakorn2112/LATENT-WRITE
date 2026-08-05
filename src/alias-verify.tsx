/**
 * Dev-only harness: the REAL <WorldDataView/> with a synthetic novel whose cast
 * is deliberately fragmented, so the alias suggestions can be verified against
 * the shipping component instead of a hand-built imitation of it.
 *
 * Driven by scripts/verify-alias-ui.cjs. Not imported by the app.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { WorldDataView } from "./components/WorldDataView";
import { CHAPTER, CHAPTER_TITLE, CAST } from "../scripts/fixtures/alias-stress-chapter";
import type { Novel, WorldData } from "./types";

// Prose that gives every rule something to fire on, and every veto something
// to refuse: a nickname, a duplicate cast entry, a titled form, and a sister
// who shares her brother's surname.
const BODY = [
  `Mr. Darcy said very little that evening. "Is Miss Darcy much grown since the spring?" asked Charlotte.`,
  `Mr. Darcy bowed. Miss Darcy had been at school in town, and Mr. Darcy wrote to her every week.`,
  `"I hope Mr. Bingley will like it, Lizzy," said her mother, and Lizzy said nothing at all.`,
  `Elizabeth had heard it before. Lizzy was used to her mother by now, and Elizabeth had stopped answering.`,
  `Sherlock Holmes took the paper and read it twice. "You see," said Holmes, "the thing is plain."`,
  `Holmes had been at the window since dawn. Sherlock Holmes was never idle, and Holmes never slept.`,
  `I have known Holmes for years, and Sherlock Holmes remains a puzzle to me even now.`,
  `Uncle Pumblechook came with us. Pumblechook had opinions, and Pumblechook shared every one of them.`,
  `Nobody contradicted Uncle Pumblechook. Uncle Pumblechook would not have noticed if they had.`,
].join("\n\n");

const novel: Novel = {
  meta: { title: "Fragments", author: "Harness", description: "" },
  chapters: Array.from({ length: 3 }, (_, i) => ({
    id: `ch${i + 1}`, number: i + 1, title: `Chapter ${i + 1}`, content: BODY,
  })),
  worldData: undefined,
};

const INITIAL: WorldData = {
  characters: [
    { name: "Elizabeth", aliases: [], role: "Protagonist", description: "" },
    { name: "Darcy", aliases: [], role: "", description: "" },
    // ★ TWO ENTRIES, ONE MAN. This is the fragmentation the presence probe
    //   measured on every DEV book, and the case the UI must offer to merge.
    { name: "Holmes", aliases: [], role: "", description: "" },
    { name: "Sherlock Holmes", aliases: [], role: "", description: "" },
    { name: "Pumblechook", aliases: [], role: "", description: "" },
  ],
  places: [], factions: [], entities: [],
};

/**
 * ?scan=1 swaps in the alias-scan stress chapter and its cast, so the SCAN
 * button can be driven on the shipping component without disturbing the
 * fragmented-cast fixture the original gates measure. Same page, same entry —
 * a second harness would be a second thing to keep in step.
 */
const scanMode = typeof location !== "undefined" && new URLSearchParams(location.search).has("scan");

const scanNovel: Novel = {
  meta: { title: "The Ash Road", author: "Harness", description: "" },
  chapters: [{ id: "ch1", number: 1, title: CHAPTER_TITLE, content: CHAPTER }],
  worldData: undefined,
};

const SCAN_INITIAL: WorldData = {
  characters: CAST.map((c) => ({ name: c.name, aliases: [], role: "", description: "" })),
  places: [], factions: [], entities: [],
};

function Harness() {
  const [wd, setWd] = useState<WorldData>(scanMode ? SCAN_INITIAL : INITIAL);
  const book = scanMode ? scanNovel : novel;
  return (
    <WorldDataView
      novel={{ ...book, worldData: wd }}
      currentChapterId="ch1"
      worldData={wd}
      intelMode="high"
      onChange={setWd}
      onRename={() => {}}
      onClose={() => {}}
    />
  );
}

document.body.style.margin = "0";
createRoot(document.getElementById("stage")!).render(
  <StrictMode><Harness /></StrictMode>,
);

interface W extends Window {
  __probe?: () => Record<string, unknown>;
  __scanProbe?: () => Record<string, unknown>;
}

/** What the writer sees after pressing the scan button. */
(window as W).__scanProbe = () => {
  const rows = [...document.querySelectorAll(".world-scan-row--alias")];
  const sectionTitles = [...document.querySelectorAll(".world-scan-section-title")]
    .map((n) => n.querySelector("span")?.textContent ?? "");
  const registerBtn = document.querySelector<HTMLButtonElement>(".world-scan-register-btn");
  return {
    phaseTitle: document.querySelector(".world-title")?.textContent ?? "",
    rowCount: rows.length,
    // ★ A COUNT BESIDE EVERY ASSERTION. `every()` over an empty list is true,
    //   and this repo has certified a feature that rendered nothing on
    //   exactly that shape — twice.
    names: rows.map((r) => r.querySelector(".world-scan-row-name")?.textContent ?? ""),
    whys: rows.map((r) => r.querySelector(".world-alias-why")?.textContent ?? ""),
    ticked: rows.filter((r) => r.querySelector<HTMLInputElement>("input")?.checked).length,
    tickedNames: rows.filter((r) => r.querySelector<HTMLInputElement>("input")?.checked)
      .map((r) => r.querySelector(".world-scan-row-name")?.textContent ?? ""),
    evidenceCount: rows.filter((r) => (r.querySelector(".world-alias-evidence")?.textContent ?? "").length > 0).length,
    sections: sectionTitles,
    registerLabel: registerBtn?.textContent ?? "",
    registerDisabled: !!registerBtn?.disabled,
    // Every row must fit its container — a suggestion nobody can read is not one.
    overflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
    // What the cast looks like NOW, so "Add" can be proved to have applied.
    castAliases: [...document.querySelectorAll(".world-row-name")].map((n) => n.textContent ?? ""),
  };
};
(window as W).__probe = () => {
  const rows = [...document.querySelectorAll(".world-alias-row")];
  const labels = [...document.querySelectorAll(".world-field-label")].map((n) => n.textContent ?? "");
  return {
    fieldPresent: labels.some((t) => t.startsWith("Also called")),
    rowCount: rows.length,
    names: rows.map((r) => r.querySelector(".world-alias-name")?.textContent ?? ""),
    whys: rows.map((r) => r.querySelector(".world-alias-why")?.textContent ?? ""),
    mergeBadges: [...document.querySelectorAll(".world-alias-kind")].map((n) => n.textContent ?? ""),
    buttons: [...document.querySelectorAll(".world-alias-btn")].map((n) => n.textContent ?? ""),
    evidenceCount: document.querySelectorAll(".world-alias-evidence").length,
    // Every row must fit its container — a suggestion that overflows the pane
    // is a suggestion nobody can read.
    overflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
  };
};
