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

## 6. Built (2026-08-13, commit "Onboarding reimagined")

Everything in §5 shipped. The engineering shape, for the next reader:

- **The sandbox contract is a LATCH, double-guarded.** sample-mode.ts
  holds a module flag; every derived store's save function checks it
  (storage, story-graph, annotations, adaptive, knowledge, review
  store, review results) AND the App effects check it (daily words),
  so a missed call site degrades to a no-op, never to sample prose in
  a real book. Undo history resets at the boundary in both directions
  (a stack that crossed it could resurrect sample prose into the real
  book and autosave it). Import exits the sandbox BEFORE its explicit
  saves. The draft-guard nag is forced off in sample mode. Enter
  flushes the real book first; exit restores from stores that were
  never written (or re-hydrates the project).
- **The pile-up effect is deleted, not deferred.** The cast question's
  two moments: fresh import (kept) and World-panel first-open, where
  answering opens the panel it feeds (worldAfterCastRef). The sample
  never asks — its WORLD-DATA block ships castReviewed with 7
  characters and 5 places confirmed.
- **The hero is the production OrbEngine** (the toolbar's canvas, with
  its vibrance/aberration character) at hero size. An earlier pass
  swapped it for the legacy gradient mesh dot on the judgment that the
  six-petal flower "decomposed" at scale — the owner overturned that:
  the flower IS the product's identity mark, and the welcome must show
  exactly the orb the writer meets in the toolbar. Taste calls about
  brand marks belong to the owner.
- **onboarding-log.ts** stores first-occurrence timestamps per event
  kind, idempotent, bounded; the checklist derives from it via
  useSyncExternalStore, the dock reads it live (watched it tick 2/4
  in the app capture when World opened).
- **verify-onboarding.cjs**: 45 gates — source facts (the four sample
  plants, the seven latches, the sequencing shapes, the gesture gates)
  paired with rendered gates (two doors, accent-first, title, word
  band 18..62, no scroll, no console errors), desktop AND browser
  builds, plus THEME=light run. capture-app-shots.cjs walks the new
  flow (welcome → sample door → editor → World → Index).
- ~1,100 lines of dead carousel CSS pruned after pixels were verified.

**Deliberately not done:** per-paragraph hover affordances over the
textarea (the rail twin + one-time hint satisfy the redundancy rule at
a fraction of the surgery); a Renderer-panel guard in sample mode (the
panel operates on the real project; a first-run sample user has
neither project nor login, noted as a residual); the 5-writer
moderated protocol (a template in §3, to be run with real writers).

**Owner round (2026-08-14):** four corrections, all shipped. The rail
"ask" sparkles button is REMOVED (owner: bad design, doesn't fit the
UI flow — the checklist's one-time hint is the gesture teaching; the
NN/g redundancy rule waits for a better-integrated form if ever). The
welcome hero is the OrbEngine flower (above). The subtitle→doors gap
was a CASCADE LOSS, not a taste gap: `.onb-subtitle--welcome`'s margin
AND max-width were silently beaten by the base `.onb-subtitle` rule
sitting later in the sheet — fixed by doubling the class; the app-
cascade-beats-component lesson again. The doors were redesigned as
icon-chip rows (book / pen chips, accent grammar kept, hover-reveal
chevron, content centered so a returning writer's one-line door reads
composed).

**Icon pipeline (2026-08-14, later):** the Icon Composer bundle is now
wired to WORK the moment it can: `electron:build` runs
scripts/electron-build.cjs, which probes `actool --version` and
overrides the icon to the `.icon` bundle when Xcode 26+ is present,
falling back to build/icon.icns otherwise — both branches tested (the
Xcode branch via a faked actool probe). The only remaining step is the
human one: installing Xcode from the App Store; the very next build
then ships the authored liquid-glass icon with zero config changes.
There is no actool substitute — Icon Composer.app authors but cannot
compile, and Command Line Tools never include actool.

**Packaged-build round (2026-08-14):** `electron:build` was broken on
this machine — electron-builder 26.8's Icon Composer path compiles the
`.icon` bundle with Xcode's actool, and only Command Line Tools are
installed. Fix that keeps the mark: build/icon.icns generated from the
bundle's own recipe (orb SVG at 0.9 on the white-gradient squircle,
rendered offscreen in Electron, compiled with sips + iconutil — system
tools); the yml documents the `.icon` line to restore when Xcode
exists. NEW CONVENTION: scripts/verify-packaged.cjs (`npm run
verify:packaged`) launches the actual release/.app with a scratch
userData and a CDP port, drives the first run via playwright-core
(welcome → sample door → editor → World), and asserts each surface —
9/9 on the fresh DMG, including "no cast dialog on World open" and the
populated 7-row cast, from inside the packaged renderer.

**Critic round (designers-package visual critic, 2026-08-13):** verdict
ship-after-should-fixes; all fixed same day. The blocker — the sample
badge's single-row pill ran 400px+ into the prose column at the default
window size and its buttons stole clicks from live text — became a
252px two-row card sharing the checklist's edge (which also healed the
dock's ragged left edge, finding 3). Door 2's top-anchored short copy
(one line for a returning writer) read as an unloaded box → doors
center their content in the stretched cell. Light-theme dock captured
to close the coverage gap (THEME env on capture-app-shots). Accepted
as-is: the app-wide --text-tertiary quiet register (~3:1, a system
token used consistently, duplicated information at full contrast
nearby) and the badge's fuller glass vs the word-count pill (it is
interactive and temporary; the pill is inert and permanent).

**Icon shipped for real (2026-08-18):** Xcode 27 beta went on the
machine, and the build still chose the fallback. Installing Xcode is
not the same as being able to run its tools: `xcode-select -p` stays
pointed at /Library/Developer/CommandLineTools until someone runs
`sudo xcode-select -s`, and the /usr/bin/actool on PATH is only a shim
that forwards to whatever that setting names, so it exited non-zero
with Xcode sitting in /Applications. scripts/electron-build.cjs now
resolves a developer directory that actually CONTAINS actool (explicit
LW_DEVELOPER_DIR, then DEVELOPER_DIR, then xcode-select, then a scan of
/Applications and ~/Applications preferring release over beta) and
hands it to electron-builder on both DEVELOPER_DIR and PATH, because
electron-builder spawns a bare `actool` while anything going through
xcrun reads the env var. No sudo, and a beta Xcode counts.

The packaged app now carries Contents/Resources/Assets.car (1.77 MB)
with CFBundleIconName=Icon: three layer stacks, three layer groups, the
orb as a Vector rather than a raster, dark and tintable renditions, and
a 1024 master. That is the authored liquid-glass document, not a plate
with an SVG on it.

REGRESSION FOUND IN THE FIX: actool's companion Icon.icns stops at
256px (ic04/ic11/ic07/ic13 and nothing above), because on macOS 26+
nothing reads it higher. The flat build/icon.icns went to 1024. On any
older macOS the icns is the ONLY icon the system has and Finder asks
for 512 and 1024, so switching to the authored icon would have traded a
crisp wrong icon for a blurry right one on every pre-26 machine.
scripts/after-pack.cjs (wired as electron-builder's afterPack, which
runs before signing and before the DMG) renders the full ladder out of
the compiled catalog with `iconutil --convert icns Assets.car Icon`,
gaining ic05/ic08/ic09/ic10/ic12/ic14. Same authored artwork, carried
down to the older API. It refuses any conversion that loses a size
class or lacks 1024, and never fails the build.

METHOD, because neither artifact is byte-reproducible: the catalog
header carries a timestamp and the rasteriser jitters, so 7 of 22 asset
digests move between identical compiles and icns chunk lengths move up
to 0.571% across four runs. verify:app-icon therefore compares only the
reproducible parts. Every catalog asset that is not a rendered bitmap
(the vector, the colours, the gradients, the groups) is matched by its
own SHA1 against a fresh actool compile of the source .icon, and all 12
match exactly. The icns is matched against a fresh iconutil render of
the app's OWN catalog by size-class set plus per-class length inside a
5% band, about 9x the measured jitter. A band that accepts everything
proves nothing, so the same comparison is run against build/icon.icns
and required to FAIL: the shipped icns sits 0.4% off, the flat fallback
121.1% off, a 300x separation. The DMG is mounted and checked too,
since that is what anyone actually receives.

Gates: verify:icon-toolchain 12/12 (the no-Xcode branch is exercised ON
a machine that has Xcode, via LW_XCODE_SEARCH_ROOTS plus a stub actool,
along with the version floor, release-over-beta ordering and the
override), verify:app-icon 33/33, verify:packaged 9/9 on the rebuilt
DMG.
