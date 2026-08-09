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

/**
 * ?dossier=1 — the character-dossier card on the shipping component. Two
 * characters: Marlow, whom the prose describes through every channel, and
 * Osric, whom it never describes, so both the filled card and the honest
 * empty state can be driven. The browser build has no electronAPI, so this
 * exercises the DETERMINISTIC path (counted-facts role + verbatim quotes) —
 * the path that must work everywhere. The assistant pref is seeded ON,
 * because the card is hidden entirely in "off".
 */
const dossierMode = typeof location !== "undefined" && new URLSearchParams(location.search).has("dossier");
if (dossierMode) {
  try {
    const KEY = "latentwrite:prefs-v1";
    const prefs = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    prefs.assistant = { ...(prefs.assistant ?? {}), enabled: true, mode: "on" };
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* the card simply stays hidden and the probe reports it */ }
}

const DOSSIER_BODY_1 = [
  "Marlow was a tall, gaunt man with a weathered face. Marlow's grey eyes missed nothing on the water.",
  "The dockhands nodded to old Marlow at dawn. Marlow walked the tide line, and Marlow was in the habit of counting the boats twice.",
  '"You are early," murmured Marlow, folding his coat.',
  "Marlow had been born in the fishing quarter, and Marlow's brother still worked the nets there.",
  "Osric waited by the gate. Osric said nothing, and Osric left before the bell.",
].join("\n\n");

const DOSSIER_BODY_2 = [
  "Marlow came down to the harbour at noon and his thin face was scarred above the brow.",
  '"The ledger is wrong," Marlow said. Osric brought the crates in and Osric signed for them.',
  '"They say Marlow escaped a wreck off the point," the harbourmaster said.',
].join("\n\n");

// Thirty chapters, not two: a draft-sized book so the reading phase lasts
// long enough for the verifier to catch the orb indicator mid-flight, and so
// the progress label ("Reading chapter N of 30…") actually counts.
const dossierNovel: Novel = {
  meta: { title: "Tideline", author: "Harness", description: "" },
  chapters: Array.from({ length: 30 }, (_, i) => ({
    id: `ch${i + 1}`,
    number: i + 1,
    title: `Chapter ${i + 1}`,
    content: i === 0 ? DOSSIER_BODY_1 : i === 1 ? DOSSIER_BODY_2
      // Filler chapters keep both names on the page without adding new
      // descriptive spans, so the card's content stays exactly the fixture's.
      : `Marlow checked the moorings at first light. Osric kept the tally by the gate, and the day went on as the days before it had gone.`,
  })),
  worldData: undefined,
};

const DOSSIER_INITIAL: WorldData = {
  characters: [
    { name: "Marlow", aliases: [], role: "", description: "" },
    { name: "Osric", aliases: [], role: "", description: "" },
  ],
  places: [], factions: [], entities: [],
};

function Harness() {
  const [wd, setWd] = useState<WorldData>(
    dossierMode ? DOSSIER_INITIAL : scanMode ? SCAN_INITIAL : INITIAL);
  const book = dossierMode ? dossierNovel : scanMode ? scanNovel : novel;
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
  __dossierProbe?: () => Record<string, unknown>;
}

/** What the writer sees on the dossier card, plus the two fields it writes. */
(window as W).__dossierProbe = () => {
  const rows = [...document.querySelectorAll(".world-dossier-row")];
  const labels = [...document.querySelectorAll(".world-field-label")].map((n) => n.textContent ?? "");
  const buttons = [...document.querySelectorAll(".world-dossier-offer .world-alias-btn, .world-dossier-wait .world-alias-btn, .world-dossier-row .world-alias-btn, .world-dossier-foot .world-alias-btn")]
    .map((n) => n.textContent ?? "");
  const inputs = [...document.querySelectorAll<HTMLInputElement>(".world-input")];
  return {
    fieldPresent: labels.includes("From the manuscript"),
    waiting: !!document.querySelector(".world-dossier-wait"),
    waitLabel: document.querySelector(".world-dossier-wait-label")?.textContent ?? "",
    orbMounted: !!document.querySelector(".world-dossier-wait .max-ask-orb canvas, .world-dossier-wait .max-ask-orb"),
    rowCount: rows.length,
    hasDescRow: !!document.querySelector(".world-dossier-desc"),
    kinds: rows.map((r) => r.querySelector(".world-alias-kind")?.textContent ?? "(role)"),
    texts: rows.map((r) => (r.querySelector(".world-dossier-text, .world-alias-name")?.textContent ?? "").slice(0, 140)),
    noteText: document.querySelector(".world-dossier-note")?.textContent ?? "",
    buttons,
    overflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
    roleValue: inputs[2]?.value ?? "",
    descriptionValue: document.querySelector<HTMLTextAreaElement>(".world-textarea")?.value ?? "",
    castNames: [...document.querySelectorAll(".world-row-name")].map((n) => n.textContent ?? ""),
  };
};

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
