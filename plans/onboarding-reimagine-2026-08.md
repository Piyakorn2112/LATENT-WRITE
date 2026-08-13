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

## 4. The redesign (to be completed from the research)

Direction under evaluation, pending the two research syntheses:
philosophy compressed to 1-2 cards; the tour's remaining teaching moved
INTO the real app over a purpose-built sample story (learn by doing:
spotlight steps that ask for the real gesture on real prose); the cast
dialog absorbed into the flow instead of stacked after it; a small
finishable checklist for J1-J3; every remaining illustration rendered
from real components or real classes, gated by structural diffs.
