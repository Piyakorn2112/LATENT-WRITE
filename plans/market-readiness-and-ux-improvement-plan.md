# Latent Write — Market Readiness & UX Improvement Plan

*Assessed against: Ulysses, Scrivener, iA Writer, Dabble, Atticus, Vellum, Bear*

---

## 1. Current Feature Inventory

Before gaps, a full accounting of what exists today.

### Writing Core
- Chapter-based document model (title + body)
- Auto-growing plain-text textarea
- Find & Replace (in-chapter and project-wide)
- Focus mode (hides toolbar + side panels)
- Auto-paragraph formatting pass
- Auto-scene-break insertion
- Chapter navigation (prev/next, keyboard: `⌥←/→`)
- Chapter index view
- Novel metadata (title, subtitle, author, description)
- Autosave (350 ms debounce)
- Daily word count tracking (carries across midnight, 60-day history)
- Daily writing goal (word target)

### Analysis (Intelligence Panel)
Twenty-plus live widgets: Tension, Style Watch, Rhythm, Repetition, Prose Profile, Continuity, Character Voice, Shaping, Structure, Voice, Cast, Role, Cross-Arc, Momentum, Sensory Balance, Cross-Pacing, Diagnostics, Deep Analysis, Comparative, Dialogue, Pacing, Register, Texture, Title Suggester.

### Intelligence System
- Modes: Fast / Default / High / Auto / Off
- Auto-mode: lightweight prescan per chapter → picks the right tier automatically
- Live grammar/style check overlay
- Entity highlighting with click-to-popover
- Annotation mode: click speech/action spans → correct speaker attribution
- Adaptive learning: model retrained from user corrections (per-chapter + global)

### Story Graph
- Accumulates NLP data per chapter after analysis settles (tension peak, prose register, major events, characters present, content hash dedup)
- Timeline / arc visualization panel
- Enrichment via LM background pass

### World Data
- Characters (name, aliases, role, description)
- Places, Factions, Generic Entities
- Book-wide or chapter-scoped name rename
- Entity prediction feedback loop

### Import / Export
- Import: `.txt`
- Export: `.txt`, `.pdf`
- PDF export: 6 format presets (Classic Trade, Mass Market, Literary Modern, Manuscript, Hardcover Cloth, Minimalist Indie), multiple paper sizes (US Trade, US Letter, A4, Mass Market, Digest), TOC, running headers, page-number placement

### Renderer (Desktop)
- Full-screen Claude AI workspace
- Slash commands: `/scan`, `/draft`, `/review`, `/lore`, `/assemble`, `/update`, `/context`, `/init`
- Persistent session with file tree and preview
- Custom tool plugin system (tools/ directory)

### UI & Preferences
- Liquid glass design system
- Font family: Georgia, Iowan, System, SF Pro, Menlo
- Font size, line height, measure (ch-width)
- Side panel document shift compensation
- Grouped toolbar mode
- Fun mode easter egg (animated orb eyes)
- Debug panel

---

## 2. Market Gap Analysis

### 2.1 Import / Export Compatibility — Critical Gaps

| Format | Ulysses | Scrivener | iA Writer | Latent Write |
|---|---|---|---|---|
| `.docx` (Word) | ✅ | ✅ | ✅ | ❌ |
| Markdown `.md` | ✅ | ✅ | ✅ | ❌ |
| EPUB | ✅ | ✅ | ❌ | ❌ |
| RTF | ✅ | ✅ | ❌ | ❌ |
| Final Draft `.fdx` | ❌ | ✅ | ❌ | ❌ |
| Scrivener `.scriv` | ❌ | — | ❌ | ❌ |
| HTML | ✅ | ✅ | ✅ | ❌ (internal only) |

**Highest-impact additions (ranked):**
1. **Markdown import/export** — near-zero implementation cost; unlocks migration from Bear, Obsidian, iA Writer; markdown is how writers export from Claude sessions too.
2. **DOCX export** — the universal hand-off format for editors, agents, beta readers. Not having it is a hard blocker for professional use.
3. **DOCX import** — allows writers to migrate existing manuscripts into Latent Write without copy/paste.
4. **EPUB export** — direct self-publishing path; partners naturally with the existing PDF export system.

### 2.2 Writing Features — Functional Gaps

**Version control / snapshots**
The internal `chapter-diff.ts` lib exists but has no UI. Writers need "save a snapshot before I rewrite this section" — not git, just named checkpoints per chapter. Scrivener's Snapshots are its most-loved feature. Without it, a destructive rewrite has no recovery path other than undo.

**Chapter metadata fields (missing but expected)**
- Synopsis / logline field per chapter — the first thing Scrivener has, the first thing power users miss
- Status label (Draft / Revised / Final / Cut) — enables "colour my index by status" views
- Chapter-level target word count — complements the existing daily goal with a structural goal ("this chapter should be 4,000 words")
- Chapter notes / scratchpad — a small private field for reminders, outline points, or research snippets per chapter

**Reading view**
No way to read the prose as formatted output without the textarea (no font/spacing override, no pagination). iA Writer's Preview and Ulysses's Preview are heavily used. Writers want to "read it as it will look" before exporting.

**Drag-and-drop chapter reordering**
The chapter index is a list but chapters can only be navigated, not restructured. Scrivener's Binder and Ulysses's sheet sidebar are entirely drag-and-drop. This is a fundamental structural editing capability.

**Split-screen / reference pane**
No way to view two chapters simultaneously, or keep world notes visible while writing. Even iA Writer (the minimalist option) offers split-screen on iPad.

**Comments / marginalia**
Writers and editors need a way to pin a note to a passage without altering the prose. The current annotation mode is for speaker-attribution training, not editorial notes.

**Writing statistics**
- Session timer (how long did I write today?)
- Words per hour / writing velocity
- Streak counter (N consecutive days with goal met)
- Historical calendar view of daily totals (60 days of data is already stored — just needs a chart)

**Auto-save conflict handling**
When using the desktop app without an open project, the "unsaved local draft" warning exists but there is no in-app "save to project" flow. A writer who is unaware of the project system can lose a session's work.

### 2.3 Collaboration & Sharing — Gaps

- No shared URL or collaboration link
- No comment export in a format editors recognize (DOCX comments, PDF annotations)
- No "send chapter for review" flow

These are v2+ features; the primary gap today is the export compatibility that editors require.

### 2.4 Platform & Sync — Gaps

- **No cloud sync** between sessions. In the browser version, refreshing without an open project drops all state.
- **No iPad / iOS app.** Writers on iPad represent a significant segment; iA Writer's iPad version is its most-downloaded platform.
- **Font availability on non-Mac platforms.** Iowan Old Style is macOS/iOS exclusive; the Windows build silently falls back without communicating this to the user.
- **No dark/light mode toggle.** The app has one theme. Light mode for day, dark for night is an expectation in every modern writing app.

---

## 3. UX Improvement Areas

### 3.1 Discoverability — The Invisible Feature Problem

The app has ~20 analysis widgets, an adaptive learning system, an annotation mode, a story graph, a full AI renderer, and a plugin system. None of these are surfaced from the main view. A new user will write a chapter, notice the orb button, click it, see a list of widgets — and then stop. The gap between features and discoverability is severe.

**Specific issues:**
- The Analysis Panel opens to a wall of widgets with no explanatory text. Most writers don't know what "Sensory Balance", "Cross-Arc", or "Register" means in this context.
- Annotation mode is accessed via the toolbar icon (pencil-annotate) but is never mentioned in the onboarding. Writers who don't know it exists will never train the adaptive model.
- The Story Graph / Timeline lives inside the Analysis Panel's tab system and is only populated after analysis has run. There is no empty-state message explaining what it will become.
- The Renderer is shown on onboarding page 4 but only on desktop and only after a project is open — many users will see the page but never find the feature.
- Preferences live deep inside the Analysis Panel sidebar, accessible by scrolling past all widgets. Most users will never find the typography controls.
- The daily word count widget in the toolbar shows a number but doesn't explain the goal or how to set one.

### 3.2 Empty States

| Surface | Current state | Needed |
|---|---|---|
| Story Graph with no analysis | Blank panel | "Run analysis on at least one chapter to start building your story graph." |
| Renderer with no project open | Error or blank | "Open a project first. The renderer needs a filesystem context." |
| World Data with no entries | Empty list | First-use prompt with a one-click "add your first character" |
| Analysis Panel with intel=off | Widgets still shown, no data | Contextual message linking to the orb button |
| Chapter index with 1 chapter | Just the chapter | Nudge toward adding a second chapter or structuring the novel |

### 3.3 Onboarding — Detailed Critique & Redesign Plan

**Current 5 pages:**
1. Welcome (orb animation)
2. Intelligence modes
3. Live analysis widgets (static demo)
4. Renderer workspace (desktop-only feature)
5. Keyboard shortcuts

**Problems:**
- Page 1 is visually beautiful but tells the writer almost nothing about what the app does. "A focused, intelligent home for your novel" is a tagline, not an orientation.
- Page 2 dives into implementation details (Fast/Default/High/Auto modes) before the user has seen the editor. The mode distinction only matters after the user has written something.
- Page 3 shows four widgets simultaneously, which is overwhelming. It doesn't explain how to open the panel or which widget to look at first.
- Page 4 (Renderer) is desktop-only content shown to all users. Browser users see a full page about a feature they can't access.
- Page 5 (shortcuts) is useful but placed last, which means most users skip it. Shortcuts need to be discoverable in-context, not memorized from a pre-use list.
- None of the 5 pages show a user what to do next. The last action is "Get started" — which lands on a blank editor with no guidance.

**Redesign proposal — 6 pages, task-oriented:**

```
Page 1 — "Write your novel" (not a tagline, a frame)
  Hero: animated screenshot of the editor with a chapter open
  Text: "Latent Write is an editor that reads as you write. Start with a 
         chapter title and some prose — the intelligence panel runs quietly 
         in the background."
  CTA: "Let's start"

Page 2 — "Your novel's structure" (Chapter Index + World Data)
  Hero: index view with 3-4 chapters visible; world data panel alongside
  Text: "Every chapter lives in the index. Add characters, places, and 
         factions to the World panel — the editor uses them to track who's 
         speaking and what objects are present."
  Highlight: index icon + world icon in toolbar

Page 3 — "Intelligence that adapts" (the orb, modes briefly)
  Hero: editor with highlight overlay showing coloured speech/entity spans
  Text: "The intelligence layer highlights speech, actions, and named 
         entities in real time. Use Auto to let the app choose the right 
         depth per chapter — or pin a mode when you know you need deep 
         analysis."
  Interactive: single click-to-cycle orb demo

Page 4 — "The Analysis Panel" (one widget at a time)
  Hero: analysis panel with Tension widget prominently visible
  Text: "Open the panel with the ◫ button (or ⌘⇧A). Start with Tension — 
         it shows you where the chapter's energy rises and falls. Add more 
         widgets as you need them."
  Note: "Each widget card has a ? button that explains the metric."

Page 5 — "Renderer (desktop)" / "Export" (branch by platform)
  Desktop: renderer panel screenshot with a /review command
  Text: "The Renderer keeps a Claude session inside the same project so 
         context never gets lost. Use /review to get a structured prose 
         critique or /draft to generate a new chapter from your outline."
  Browser: export options screenshot
  Text: "Export as .txt for backup, .pdf for print-ready output with 
         professional typesetting presets, or use the Markdown export to 
         bring your draft anywhere."

Page 6 — "Three things to do first"
  Checklist style:
  ☐ Add a chapter title and write at least one paragraph
  ☐ Open the Intelligence panel and let it analyse your chapter
  ☐ Add one character to World Data so the editor can track them
  CTA: "Open the editor"
```

**Supplemental: in-context tooltips**
Rather than front-loading all information, add contextual hints at the first time each feature is encountered:
- First time analysis panel opens → "These widgets update as you write. Start with Tension to see the chapter's shape."
- First time intel highlight renders → "Coloured spans show speech (blue), actions (amber), and named entities (teal). Click a span in annotation mode to correct the attribution."
- First time world data has a character → "Characters here are tracked in the editor. The app learns speaker patterns from your corrections."

---

## 4. Feature Priority Matrix

Grouped by effort vs impact for a solo/small-team release cycle.

### Tier 1 — Ship before "market ready" label (high impact, moderate effort)

| Feature | Why now |
|---|---|
| Markdown import/export | Zero new UI; unlocks migration and Claude workflow handoff |
| DOCX export | Hard blocker for professional hand-off to editors/agents |
| Chapter synopsis field | Expected by every Scrivener/Ulysses migrant |
| Chapter status labels | Enables basic project management in the index |
| Drag-and-drop chapter reorder | Index is unusable for structural editing without it |
| Onboarding redesign (6-page plan above) | Directly controls day-1 retention |
| In-panel widget help text / ? button | Unlocks the 20+ widgets that currently go unexplored |
| Preferences as a dedicated panel | The typography controls are too buried to be usable |
| Dark / light mode toggle | Table stakes for any writing app |
| Empty states for Story Graph, Renderer, World Data | Converts confusion into action |

### Tier 2 — Next minor release (high impact, higher effort)

| Feature | Why |
|---|---|
| Chapter snapshots (named checkpoints) | Rewrites without recovery paths are a trust problem |
| DOCX import | Completes the migration story |
| EPUB export | Direct self-publishing; complements existing PDF system |
| Writing statistics calendar | The 60-day data is already stored; just needs a chart UI |
| Reading view | Writers want to "see the printed page" without exporting |
| Chapter word count target | Pairs structural goals with the existing daily goal |

### Tier 3 — Planned future work

| Feature | Notes |
|---|---|
| iPad / iOS app | Major platform bet; requires React Native or redesign |
| Cloud sync | Architecture decision: first-party sync vs iCloud/Dropbox handoff |
| Comments / marginalia | Useful for revision; complex to implement without rich text |
| Collaboration / shared review | v2 or v3 feature |
| Streak counter + motivation layer | Low engineering cost; high retention impact |
| Split-screen / reference pane | Architecturally complex in current single-pane layout |

---

## 5. Onboarding Re-trigger Triggers

Beyond first launch, expose the onboarding / feature discovery at:
- Help menu → "Welcome & Feature Tour" (already re-openable via `setOnboardingOpen(true)` in menu handler; make it visible in the toolbar overflow menu too)
- After 7 days of use → offer "Discover what you haven't tried" modal with a checklist of unused features (annotation mode, story graph, renderer)
- After the first PDF export → surface markdown export as a lighter alternative
- After the first 5,000 words written → suggest setting a daily word goal if `prefs.goals.dailyWords === 0`

---

## 6. The One-Line Summary Per Gap

For prioritization conversations with the team:

> **Compatibility:** writers cannot hand off to editors without DOCX export.
> **Structure:** the chapter index is read-only — no synopsis, no status, no reorder.
> **Onboarding:** 5 pages about the app's architecture, 0 pages about what to do first.
> **Discoverability:** 20+ widgets exist; most users see 2 before closing the panel.
> **Version safety:** destructive rewrites have no snapshot recovery.
> **Theme:** no dark mode in 2026 is a notable absence for a premium writing app.
