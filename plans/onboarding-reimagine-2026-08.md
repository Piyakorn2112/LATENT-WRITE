# Onboarding, reimagined: audit, job definition, measures

**Brief.** The owner wants the onboarding massively upgraded and possibly
entirely reimagined; the first illustration is "not even accurate in
skeleton and positioning"; deep UX research first; a principled way to
measure whether it does its job; pixel-level craft consistent with the app.

## 1. The audit (real app, really booted, 2026-08-13)

Method: `scripts/capture-app-shots.cjs` seeds a scratch userData plus a
real on-disk project (the sample novel at `<project>/novel.txt` in the
shipping serialization) and requires `electron/main.cjs` — the true main
process, every IPC surface production. Shots in `bench-results/shots-app/`.

### Finding 1 — the first-run is a MODAL PILE-UP (structural, worst)

The moment the 7-page tour closes, the cast-confirm dialog ("Your cast —
2 of 2 confirmed as people") drops over the blurred editor, and it BLOCKS
every surface until answered — the writer who just finished a tour about
exploring panels cannot explore anything. Two modal layers before a single
word can be written. Whatever shape the redesign takes, the sequencing is
the first thing it must own end to end.

### Finding 2 — the page-1 editor mock is wrong in every particular

Real editor (shot 10): a FLOATING PILL toolbar, not window chrome — orb on
the LEFT edge, then reader and cast icons, undo/redo, chapter arrows
flanking a CENTER TITLE FIELD ("The Beginning of the End"), a "1 / 5"
counter, then five action icons (add, open, export, highlight, notes). A
RIGHT-EDGE TOOL RAIL (collapse chevron with a count, ¶, spacing, layers,
wand, settings). The body opens with a letterspaced "CHAPTER 1" kicker, a
large serif title, a hairline rule, an indigo section chip ("| WEIGHTED
SILENCE"), then serif prose carrying the REAL product surface: analysis
wash highlights, orange character/dialogue marks, dotted pronoun
underlines. Bottom-left: "392 words · 2,243 chars · 2 min read".

The mock: macOS traffic dots (the app has none), a centered static
"Chapter 1 · The Bridge" strip (the real center is an editable title
field), the orb on the RIGHT (real: left), grey placeholder bars for the
body (the real body is the product's whole point — marked-up prose), no
rail, no kicker/title/rule, no status line. A writer who learned this
picture learned a different app.

### Finding 3 — the World mock misses the panel's anatomy

Real panel (shot 11): serif "World" title with a header icon cluster
(cast, sparkle, share, close), icon tabs with count badges, then TWO
COLUMNS — an entry list (Marcus, Kael, dashed "+ Add character") and a
detail pane with the empty-state hint "Select an entry to edit." The mock
has the tabs and rows but no header cluster, no add affordance, no
list+detail split.

### Finding 4 — the sample novel exercises the engine thinly

The seeded sample produced 2 characters, 1 place, a handful of chips. A
sample built FOR onboarding should light up every surface the tour
teaches: a contradiction for the check gesture, a rich cast for the world
panel, tension variation for the widgets.

## 2. The job, defined

The onboarding's job is not "show seven cards". It is to cause, in the
first session:

  J1  words in the editor — typed or imported (the writer's words, or the
      sample's, being edited)
  J2  the reader seen reacting — at least one analysis surface observed
      after a change (chips updating, a widget moving)
  J3  one AI gesture performed — right-click ask, a rewrite, or a dossier
      read, whichever tier is available
  J4  the writer knows where things live — panels open/close without hunting
  J5  trust established — local-first understood, nothing overwritten
      without consent

## 3. Success measures (fully local, privacy-first — no telemetry)

1. **A local funnel record** in prefs (device-only, never transmitted,
   inspectable by the writer): tour pages seen/skipped with dwell times,
   and first-session flags for J1-J4 (first edit, first panel open, first
   AI gesture, sample vs own project). Read in dev and support only.
2. **Mechanical gates** (verify-onboarding.cjs, extended): every mock
   surface diffed structurally against the REAL component's markup
   (classes, geometry) — the accuracy failures of Finding 2/3 become
   assertions; promise-vs-code truthfulness gates stay (a tour claim must
   match shipping behavior); the modal-sequencing gate (no second modal
   within N seconds of tour close).
3. **A usability script** (5-writer protocol, in the doc): tasks J1-J4
   cold, observed; pass = 4/5 complete each without help. For a
   cohort-of-one project this is the honest substitute for A/B.
4. **Design review**: the designers-package critics against the app's
   glass system, to the pixel.

## 4. The research, landed (2026-08-13)

Two syntheses: a creative-tool teardown (Scrivener, Obsidian, Notion,
Superhuman, Cursor, Logic, Linear and peers) and a deep UX pass over NN/g
primary pages, CHI papers and the large onboarding benchmark reports.
The convergent findings that decide the design:

- **No serious tool ships a card slideshow any more.** The pattern is a
  real, resettable practice space (Scrivener's tutorial IS a project;
  Obsidian's sandbox vault resets on reopen and advertises it), teaching
  inside the real workspace (Notion), one flagship personalized moment
  (Superhuman), and convention-matching to reduce tutorial need at all.
- **Auto-fired linear tours lose 2-3x to user-triggered contextual help**
  (Chameleon, 550M interactions); a tour launched FROM a checklist item
  converts ~67% vs ~23% standalone. Working memory holds an unused
  instruction ~20 seconds (NN/g), so a page-4 gesture card is forgotten
  before the editor ever opens.
- **In-place contextual teaching produces durable learning**: ToolClips
  (CHI 2010) users completed 7x more unfamiliar tasks and stayed faster a
  week later; trial-and-error is professionals' preferred mode (CHI 2022,
  Autodesk), improved by TRACKING what the user has and hasn't tried.
- **Invisible gestures need redundancy** (NN/g contextual-menus rule):
  every right-click action must also exist as a visible affordance;
  a gesture taught once in a card and never reinforced is lost within the
  session (forgetting-curve + marking-menu literature).
- **Checklists**: median completion 10-19%; 3-5 items is the cliff edge;
  pre-completing one item nearly doubles completion for identical effort
  (endowed progress, Nunes & Dreze 2006, field experiment); non-blocking,
  collapsible, guilt-free skip, never nags.
- **A philosophy screen survives only as a single screen with a few
  sentences** that set the one mental model the doing will lean on.
- **Activation for a no-telemetry tool**: define it qualitatively (the
  moment the tool demonstrably improved the writer's own work), check it
  as local proxy gates against an on-device log, validate with 5-writer
  moderated sessions (NN/g: 5 users surface ~85% of problems) plus a
  written heuristic self-audit.

## 5. The design

The 7-card carousel retires. The onboarding becomes four cooperating
pieces, all inside the real app:

**A. One welcome screen** (the only full-screen moment). The orb hero,
the app's one mental model in a few sentences (a novel editor with a
reader built in; everything runs on this machine), and two doors:
**"Open the sample story"** and **"Start your own book"** (plus the
quiet import path). No forced order, Esc works, skip is guilt-free.
The Pro-code row survives here, folded quiet.

**B. The sample story, purpose-built.** "The Ferrier Light", ~1,400
words, 4 chapters, written FOR the surfaces: 7 named characters, 5
places, dialogue density for the marks, tension shaped low/rise/simmer/
peak, and four planted teaching moments the flow points at, each doubling
as story texture (a stranger whose eye colour contradicts itself Ch2 vs
Ch3; the Lantern Bridge renamed Lamplight in Ch3; "three days on his
feet" against "two nights ago" in the same scene; one ledger sentence
misspelled for Proofread). It lives in its own scratch project,
resettable in one click, edits never touch a real project, and the
safety is ADVERTISED in its own description text.

**C. Teaching at the moment of relevance, not in advance.** Single
anchored hints (never a sequence): the right-click hint appears once,
only when the caret first rests in a paragraph, only on tiers where the
menu exists; each hinted gesture also has its visible affordance so the
invisible path is never the only path; a local record of which gestures
have actually been tried gates one respectful re-surface. The cast
dialog is ABSORBED: it stops firing as a stacked modal at tour close and
becomes the World panel's own first-open moment (Finding 1 dies by
sequencing ownership, not by a timer).

**D. A 4-item checklist, finishable.** Corner widget, collapsible,
re-summonable from help, never blocking, never nagging. Items map to
J1-J3: open a story (pre-checked at creation, the endowed-progress
lift), try one gesture on the sample's flagged spots, watch the reader
react in World/Analysis, write your own first words. Completing it
offers the "first session" recap drawn from the local log, so the
instrumentation is a feature, not hidden telemetry.

**Local funnel log** (J-gates, §3) records structural events only, on
device, inspectable. Activation = the five proxy gates checked against
it in moderated sessions; ship-gate = 4/5 writers clear all gates
unassisted.
