# Knowledge Ledger & Local Adjudicator — execution-ready spec

> Status: SPEC — no production code written yet. The only artifact that exists is
> `scripts/probe-knowledge-ledger.ts` (measurement, commit `449575b`).
> Written 2026-08-02. Every number in §1 was measured, not asserted.
> Prerequisite reading: `ARCHITECTURE.md` (systems 1–4), `plans/narrative-event-engine.md` §"what a real LLM would add".

---

## 0 · One paragraph of intent

The app learns, chapter by chapter, **who knows what, and since when** — presence,
exposure, and first-reference facts derived from engines that already run. When a
character references an entity they have never met and never been told about, that
is a *candidate* continuity break. The deterministic layer is a high-recall
candidate generator (measured ~1.55/chapter); it is **wrong roughly 7 times in 8**,
so it never talks to the writer directly. A tiny local model (1.7B–4B, grammar-
constrained, fully offline) adjudicates each candidate against a dynamically
assembled evidence pack and is allowed three answers: *break*, *plausibly known
offscreen*, or *unsure*. Only a confident *break* ever surfaces, and it surfaces
quietly. The harness — evidence assembly, output grammar, abstention, caching,
gates — is the product; the model is a swappable part.

---

## 1 · The measurement this is built on

`scripts/probe-knowledge-ledger.ts`, 7 corpus books, 141 chapters, 1049
speaker→entity reference pairs:

| Funnel stage | Count | Note |
|---|---|---|
| speaker→entity pairs found | 1049 | reference = speaker names entity inside own dialogue |
| no prior scene, narrow presence (raw) | 620 (59.1%) | "present" = spoke with ≥0.65 confidence — too narrow |
| − had a chance once presence is widened | 155 | 25% of raw were presence bugs, not story facts |
| − direct address, not a knowledge claim | 68 | "Good evening, Dance" is talking TO, not ABOUT |
| = survives both filters | 397 (37.8%) | |
| …and the entity appears mid-book | 219 (20.9%) | first-chapter entities are cast, not secrets |
| **surfaced per chapter** | **1.55** | in the reviewable band |

Reading the survivors: **roughly 1 in 8 is a real candidate.** Residual failure
classes, in order of observed frequency:

1. **Attribution errors upstream** — a line of Anne's credited to Marilla because
   Marilla is the *addressee* named in the tag.
2. **Entity-type confusion** — Netherfield and Whitby are places. Artifact of the
   corpus lacking types; the app has `worldData.type` via `scanAndClassify`.
3. **Vocatives the probe regex missed** — "Now Joseph, you know the case."
4. **Legitimate offscreen/backstory knowledge** — pirates discussing Flint; a
   client briefing Holmes on people he has never met. **Not a lexical problem.**

Classes 1–3 are deterministic fixes (M0). Class 4 is a judgment about the story
and is precisely the adjudicator's job. Shipping the generator without the
adjudicator would put a confident wrong flag in front of the writer 8 times in 9,
which is the defect class the scene-label rebuild existed to remove.

---

## 2 · What the writer experiences (the invisibility contract)

Everything below inherits the `story-arc-insights.ts` rule: **silence is the
default.** The feature must feel like the app quietly knows the story, not like a
linter.

- **Nothing appears while typing.** Adjudication is idle-time work; a keystroke in
  the affected chapter retires any in-flight result for it.
- **Only a confirmed break surfaces.** `verdict === "break"` and
  `confidence ≥ 0.75` and the candidate survived every deterministic guard.
  *unsure* and *plausible_offscreen* render nothing anywhere (debug panel only).
- Where it surfaces (three places, all existing vocabulary, no new chrome):
  1. A **"Knowledge" group inside `ContinuityWidget`** — one plain sentence per
     finding, same register as the existing out-of-order/Chekhov rows:
     *"Pew names Flint in chapter 5, but has never met him or heard of him."*
  2. A **review-band margin pill** on the offending paragraph, reusing the
     existing `renderReviewPill` pattern in `HighlightLayer.tsx` (max one per
     chapter view, lowest paragraph index wins).
  3. An **`ArcInsight` of kind `"knowledge-break"`** (severity `attention`),
     flowing through the existing cap-of-5 and the timeline insights strip.
- Clicking any of the three opens an anchored popover (reuse the
  `AnnotationPopover` pattern): the claim quote, the model's one-line reason, and
  jump links to the cited evidence (jump by stored verbatim sentence + `indexOf`,
  same mechanism as timeline event jumps). Three actions:
  - **Go to it** — jump to the claim.
  - **They knew already** — records a durable `KnowledgeFact` with
    `how: "author-asserted"`. The pair is settled forever; the ledger treats it
    as evidence in future packs. This is the anti-resurrection rule: a writer's
    dismissal is a decision, and no re-scoring pass may undo it.
  - **Good catch** — keeps the flag pinned until the text changes; the writer
    fixes it in prose, the anchor dies, the flag retires itself.
- **Model download is opt-in.** A single settings row (see §9). Until the model
  is present the whole feature is dormant; the ledger still accumulates facts
  (they are free), so the day the model arrives it has a full book to work with.
- **StatusPill** is the only progress surface: "downloading assistant model · 43%"
  during fetch; nothing at all during routine adjudication (it is seconds of
  background work; a pill for it would be noise).

---

## 3 · Architecture

Four layers, two processes. Renderer stays UI + cheap set algebra; all NLP stays
in the existing analysis worker; all inference goes to a new Electron
`utilityProcess`.

```
┌─ renderer ──────────────────────────────────────────────────────────┐
│ analysis worker (existing)      main thread                         │
│  runChapterAnalysis ──result──▶ L1 fact extraction (cheap, derived) │
│                                 L2 candidate generation (pure fn)   │
│                                 L3 evidence assembler (pure fn)     │
│                                 adjudicator-client (queue/schedule) │
└───────────────────────────────────────│─────────────────────────────┘
                     preload/IPC (adjudicator:*)
┌─ electron main ───────────────────────▼─────────────────────────────┐
│ electron/adjudicator.cjs  — IPC registry, lifecycle, model manager  │
│        │ utilityProcess.fork + MessagePort                          │
│ electron/adjudicator-host.cjs — node-llama-cpp, grammar, one queue  │
└──────────────────────────────────────────────────────────────────────┘
```

Why a `utilityProcess` and not the analysis web worker: node-llama-cpp is a native
Node addon; the docs sanction Electron **main process only** and the Electron
org's own reference (`github.com/electron/llm`) hosts it in a `utilityProcess`
with MessagePort streaming. A renderer web worker cannot load it at all. A
utilityProcess keeps model load, token generation, and any native crash out of
both the UI and the main process. Fallback if the M3 spike finds a utilityProcess
blocker: host in main process behind the identical IPC surface (the renderer
cannot tell the difference) and record the decision here.

New files:

| File | Layer | Mirrors |
|---|---|---|
| `src/lib/knowledge-ledger.ts` | L1+L2 pure functions | `story-graph.ts` build half |
| `src/lib/knowledge-store.ts` | persistence | `annotation-store.ts` exactly |
| `src/lib/evidence-pack.ts` | L3 pure assembler | none (new, fully unit-testable) |
| `src/lib/adjudicator-client.ts` | renderer queue/schedule | `analysis-worker-client.ts` |
| `electron/adjudicator.cjs` | main: IPC + lifecycle + model manager | `claude-code.cjs` registration shape |
| `electron/adjudicator-host.cjs` | utilityProcess entry | `electron/llm` reference |

Touched files: `electron/preload.cjs` (new bridge methods), `electron/main.cjs`
(one `registerAdjudicator()` call), `src/lib/project-manager.ts` (ElectronAPI
interface), `src/lib/preferences.ts` (one pref field), `src/lib/storage.ts`
(one localStorage key in `ALL_LS_KEYS`), `AnalysisPanel.tsx` (settings row),
`ContinuityWidget.tsx` (knowledge group), `HighlightLayer.tsx` (margin pill),
`story-arc-insights.ts` (`knowledge-break` kind), `TimelineGraphFull.tsx`
(knowledge lens), `App.tsx` (wiring effect, ~30 lines).

Per the keep-core-lean rule: `speech-detect.ts`, `chapter-analysis-runner.ts`,
and the worker protocol are **not modified**. L1 derives everything from
`ChapterAnalysisResult` fields that already exist.

---

## 4 · L1 — the ledger: facts, not opinions

Derived on the main thread in the same effect that runs `buildChapterEntry`
(`App.tsx` ~line 615), debounced 120ms behind analysis, gated by the same
`contentHash` freshness check. Cost is set algebra plus one alias-aware regex walk
per changed chapter (the same walk `buildTimelineCharacterTracks` already does).

```ts
// knowledge-store.ts
export interface KnowledgeFact {
  subject: string;            // canonical character name (worldData characters only, v1)
  entity: string;             // canonical entity name (characters only, v1 — see §5 class-2 fix)
  chapterId: string;
  chapterNumber: number;
  how: "present"              // subject and entity share a scene (wide presence)
     | "told"                 // entity named in dialogue while subject present in scene
     | "reference-implied"    // subject referenced entity; adjudicated plausible_offscreen
     | "author-asserted";     // writer clicked "They knew already"
  sentence?: string;          // verbatim anchor for jumps (present for told/reference)
}

export interface ChapterKnowledgeFacts {
  chapterId: string;
  contentHash: string;        // `${content.length}|${content.slice(0,60)}` — same recipe as StoryGraph
  present: string[];          // WIDE presence: spoke (any conf ≥ ROSTER floor) ∪ named in narration ∪ charactersPresent
  exposed: string[];          // entity named anywhere in chapter (alias-aware)
  references: KnowledgeReference[];
}

export interface KnowledgeReference {
  speaker: string; entity: string;
  paragraphIndex: number; sentence: string;  // verbatim, for re-anchoring
  speakerConfidence: number;                 // from the SpeechSegment
  grammaticalRole: "about" | "possessive" | "subject-of-knowing-verb" | "bare-mention";
}

export interface KnowledgeLedgerStore {
  version: 1;
  chapters: Record<string, ChapterKnowledgeFacts>;   // keyed chapterId
  facts: KnowledgeFact[];                            // the cross-chapter ledger
  candidates: KnowledgeCandidate[];                  // §5
  decisions: Record<string, WriterDecision>;         // keyed candidateKey — durable
}
```

Persistence follows `annotation-store.ts` byte-for-byte in shape: desktop via
`saveProjectState("knowledge-ledger", …)` → `.renderer/knowledge-ledger.json`;
browser fallback key `glass-editor:knowledge-ledger-v1` registered in
`storage.ts` `ALL_LS_KEYS`.

**Presence is WIDE by definition** (the probe's biggest single error class, 25% of
raw noise, was narrow presence): `present = speakers(conf ≥ 0.65) ∪ names
appearing in narration (stripQuotes'd text) ∪ ChapterGraphEntry.charactersPresent`.
Widening presence can only suppress candidates, never create them, so it is
strictly precision-positive.

**Invalidation.** A chapter edit changes `contentHash` → recompute that chapter's
facts → rebuild derived candidates. References re-anchor by `sentence.indexOf`;
an anchor that no longer matches retires its reference and any candidate built on
it. Chapter identity survives reordering via the existing `chapter-id-map`
rehydration.

---

## 5 · L2 — candidate generation, with the deterministic fixes first

A candidate exists when a reference has **no supporting fact**:

```
candidate(speaker S, entity E, chapter C) ⇔
  reference(S names E in own dialogue in C)
  ∧ ¬∃ fact(S, E, chapter ≤ C)            // never present-with, told, implied, or asserted
  ∧ firstExposure(E) > chapter 1           // mid-book entities only (cast ≠ secrets)
  ∧ passes the M0 guards below
```

M0 guards, one per measured failure class:

- **Class 1 (attribution)**: require `speakerConfidence ≥ 0.78` (the engine's
  `ATTESTED_FLOOR`) and skip any span whose `AdaptivePredictionTrace` says
  `needsReview`. Additionally reject when E is the likely *addressee*: E appears
  as a vocative anywhere in the same paragraph's quotes, or the surrounding
  narration names E as the person spoken to.
- **Class 2 (entity types)**: v1 restricts E to `worldData.characters` (the
  probe's place-noise disappears by construction). Places/factions are a later
  flag, off by default.
- **Class 3 (vocatives)**: port the probe's vocative regex, then go further —
  classify the reference's grammatical role and keep only `about` ("about
  Flint"), `possessive` ("Flint's fist"), and `subject-of-knowing-verb` ("I knew
  Flint", "you've heard of Flint", verb table shared with the addressee-fallback
  table from the attribution work). `bare-mention` inside dialogue is generated
  but marked low-band; it can only surface if the adjudicator confirms AND a
  second reference exists in a later chapter.

Candidate identity: `candidateKey = ${canon(S)}→${canon(E)}` (book-scoped; canon
via the existing alias map). A pair is one candidate no matter how many times it
re-fires; the anchor is the *earliest* surviving reference.

```ts
export interface KnowledgeCandidate {
  key: string;                       // "Pew→Flint"
  speaker: string; entity: string;
  chapterId: string; chapterNumber: number;
  paragraphIndex: number; sentence: string;
  band: "normal" | "low";            // class-3 bare-mention demotion
  status: "pending" | "adjudicated" | "retired";
  verdict?: AdjudicationVerdict;     // §7
  verdictKey?: string;               // cache key that produced it (§8)
}
```

**M0 exit gate (measured, before any model work):** re-run the probe with the
guards; precision on a hand-labeled DEV sample must reach **≥ 1 in 3** (from
1 in 8) with volume still in the 0.5–3.0/chapter band. If deterministic fixes
alone reach ~1 in 2, the adjudicator's job shrinks and the model tier decision
(§10) revisits. Cheap fixes are never delegated to the model.

---

## 6 · L3 — the dynamic evidence assembler (the harness core)

`evidence-pack.ts` is a **pure function** from
`(candidate, ledger, novel, storyGraph, worldData, budget)` to an `EvidencePack`.
Pure means deterministic, snapshot-testable, and measurable without a model —
this is where "the harness matters more than the model" becomes code.

**Dynamic** means the pack is assembled per candidate from a priority ladder
under a token budget, not a fixed template. The model never searches and never
sees the manuscript; it sees only what the assembler selected.

Budget: `CPU tier 1200 tokens, Metal tier 2000` (estimate `chars/4`; the pack
serializer re-measures and trims). Fill in rung order, drop from the bottom:

| Rung | Content | Source | Always? |
|---|---|---|---|
| 1 | The claim — quote, full enclosing paragraph, chapter number | candidate anchor | yes |
| 2 | Fact block — compact structured lines: chapters where S present; chapters where E exposed; the intersection (empty, by construction); E's first-exposure chapter | ledger | yes |
| 3 | E's dossier — worldData role + description + the first-exposure paragraph verbatim | worldData, novel | yes |
| 4 | S's dossier — role + description | worldData | budget |
| 5 | Timeline events where E is `agent` or appears in `sentence`, up to 3, chosen by `rank` (the sanctioned selector, never raw order) | StoryGraph `MajorEvent` | budget |
| 6 | Related paragraphs — MiniLM retrieval via the existing `narrativeLMEmbed` IPC: query = claim sentence; pool = paragraphs mentioning E in chapters where S is present, plus E-mentioning paragraphs adjacent to the first exposure; top-k by cosine until budget | embeddings | budget |
| 7 | Prior decisions — any author-asserted or adjudicated facts touching S or E | ledger | budget |

Rung 6 is what the request "sometimes a whole paragraph, sometimes related
content" resolves to: retrieval decides *which* prose earns a seat, the budget
decides *how much*. When the embedder is unavailable (`hasEmbedder()` false —
same silent-degrade contract as `enrichChapterEntryWithLM`), rung 6 is skipped
and the pack still stands on rungs 1–5.

Pack serialization is labeled plain text (`CLAIM / KNOWN FACTS / WHO ${E} IS /
STORY EVENTS / RELATED PASSAGES / PRIOR RULINGS`), chapters always numbered, no
markdown tables (small models read labeled blocks more reliably than tables).

`packHash = sha1(serialized pack + promptVersion)` — part of the verdict cache
key, so any change to assembly or prompt invalidates exactly the affected
verdicts and nothing else.

---

## 7 · L4 — the adjudicator runtime

### Process & protocol

`electron/adjudicator.cjs` (main) registers IPC and forks
`electron/adjudicator-host.cjs` (utilityProcess) on demand. Renderer bridge via
preload:

| IPC channel | Direction | Payload |
|---|---|---|
| `adjudicator:status` | invoke | → `{ state: "no-model"\|"downloading"\|"ready"\|"loading"\|"busy"\|"low-memory"\|"error", model?: {id,tier,bytes}, progress?: number }` |
| `adjudicator:ensure-model` | invoke | `{tier}` → starts/reuses download, resolves when verified |
| `adjudicator:adjudicate` | invoke | `{ requestId, candidateKey, pack: string, schemaVersion }` → `AdjudicationVerdict` |
| `adjudicator:cancel` | invoke | `{ requestId }` |
| `adjudicator:unload` | invoke | frees model (TTL or memory pressure) |
| `adjudicator:progress` | event | download progress → StatusPill |

**One in-flight request, ack-based.** The client sends the next candidate only
after the previous verdict (or cancellation ack) returns — the same backpressure
lesson as the worker-composite migration: tick-driven producers with no ack
eventually flood a slow consumer. The host itself also enforces a queue depth of
1 and rejects overlapping requests (defense in both layers).

Unlike `analysis-worker-client.ts` (documented gap: no timeout), every
adjudication carries a **hard 30s timeout** on the client; on timeout the request
is cancelled, the candidate stays `pending`, and a counter increments — three
consecutive timeouts latch the runtime off for the session and report state
`error` (visible in settings, never as a writer-facing flag).

### Inference contract

```ts
export interface AdjudicationVerdict {
  verdict: "break" | "plausible_offscreen" | "unsure";
  confidence: number;          // 0..1
  reason: string;              // ≤ 160 chars, shown verbatim in the popover
  citedChapter: number | null; // where the knowledge plausibly came from, if offscreen
}
```

Enforced by `llama.createGrammarForJsonSchema(...)` → `session.prompt(pack,
{grammar, signal, stopOnAbortSignal: true, maxTokens: 96})`. The grammar
guarantees the *shape*; the prompt states the schema and semantics anyway
(documented node-llama-cpp caveat: the model is not aware of the grammar).

System prompt (v1, `promptVersion: 1`, frozen in `adjudicator-host.cjs`):

```
You judge continuity of knowledge in a novel. The question is always:
could SPEAKER plausibly know about ENTITY at this point in the story?

Rules:
- "break": the story so far gives SPEAKER no way to know ENTITY exists,
  and the reference reads as familiarity, not hearsay.
- "plausible_offscreen": the story implies a channel — shared background,
  reputation, an offscreen report, membership in the same world — or the
  reference itself is hearsay/second-hand. When the entity is famous or
  the speaker's role implies acquaintance, choose this.
- "unsure": evidence is thin either way. PREFER unsure over a guess.
  A wrong "break" wastes the writer's trust; "unsure" costs nothing.
- Judge only from the evidence given. Do not invent story events.
Answer as JSON: {"verdict","confidence","reason","citedChapter"}.
reason: one plain sentence a writer can act on, ≤160 characters.
/no_think
```

The final `/no_think` is the Qwen3 thinking-mode toggle; for other model
families the host maps an equivalent (Gemma/Granite need nothing). Temperature
0, `maxTokens: 96`.

**Abstention is load-bearing.** The scene-label rebuild proved the pattern:
gate → floor → silence beats a decorative answer. `unsure` must remain cheap for
the model (the prompt says so explicitly) and free for the writer (renders
nothing). Eval (§11) gates the *unsure rate band* so the model can neither
rubber-stamp everything nor hide in abstention.

### Memory discipline

- Load: `useMmap: true`, `gpuLayers` auto (Metal on arm64, CPU on Intel per the
  prebuilt matrix), context 2048 (CPU tier) / 4096 (Metal tier), KV cache
  `q8_0` on the 8 GB tier.
- Guard before load: `os.freemem() ≥ weights + KV + 0.5 GB` headroom, else report
  `low-memory` and retry on the next idle window — never evict the writer's OS
  cache to run a background nicety.
- TTL unload: model freed after 5 minutes with an empty queue; also on
  `window-all-closed`-adjacent lifecycle and on `adjudicator:unload`.
- The utilityProcess exits entirely when unloaded (fork is cheap; resident host
  processes are how 8 GB machines die).

Honest footprint at the writer's expense, stated in settings copy:

| Tier | Model (default) | Weights | Resident @ ctx | Machines |
|---|---|---|---|---|
| small | Qwen3-1.7B Q4_K_M | 1.11 GB | ≈1.5 GB @ 2k | 8 GB minimum |
| large | Qwen3-4B-Instruct-2507 Q4_K_M | 2.50 GB | ≈3.4 GB @ 4k | 12–16 GB recommended |

Both Apache-2.0 (bundle/auto-download clean, no attribution clause). Granite 4.0
Micro (Apache-2.0, best published IFEval/structured-output numbers in class) is
the designated challenger in the M3 bake-off; Gemma 3 is excluded from
*defaults* on license friction (Gemma ToU pass-through), remains a manual option
later if eval ever justifies it.

### Model manager

- Storage: `app.getPath('userData')/models/<file>.gguf` + `<file>.sha256`.
- Download: HF `resolve/main` URL pinned to a specific revision, Range-resume,
  sha256 verify before first load, temp-file rename on completion. Progress
  events throttled to 500ms → StatusPill.
- Nothing is bundled in the DMG (keeps the installer at its current size; the
  entitlements note in `build/entitlements.mas.plist` about networking-by-
  omission must be revisited if a MAS build ever ships this — DMG unaffected).

---

## 8 · Scheduling, caching, lifecycle

**When adjudication runs** (all conditions, renderer-side in
`adjudicator-client.ts`):

1. The feature is enabled and status is `ready`.
2. The **high-tier** analysis for the candidate's chapter has landed (converge
   refine, 1600ms), not just the fast pass — candidates from fast-tier
   attribution are provisional and never queued.
3. The writer has been idle ≥ 3s (reuse the input-event listeners the
   scroll-edge idle timer already installs; do not add new global listeners).
4. `!document.hidden` in the driving renderer (the host process is invisible to
   the OS-level app nap heuristics; the renderer is the scheduler, so hidden =
   no new work; in-flight work completes).
5. No export/print in progress.

Queue order: current chapter's candidates first, then outward by chapter
distance (mirrors the adjacent-chapter pre-scan's neighbour-first instinct).
Pace: one request at a time, ≥ 1s gap, so a 30-chapter backfill (~46 verdicts
measured) completes in a few unobtrusive minutes on Metal and under ~15 on an
8 GB CPU machine, all invisible.

**Verdict cache.** `verdictKey = sha1(candidateKey | packHash | modelId |
promptVersion | schemaVersion)` stored on the candidate. A verdict is reused as
long as its key matches; any input change (evidence, model, prompt) recomputes
exactly the affected candidates. The memo key carries **every output-affecting
option** — the color-taxonomy and extractive-label lessons both paid for this
rule.

**Decisions beat verdicts.** `decisions[candidateKey]` (writer clicked
*They knew already* / *Good catch*) short-circuits everything: no pack, no
inference, no surfacing changes until the underlying anchor text changes
materially (anchor retired AND a new reference appears with different sentence
text — then it is a new question and may be asked again).

---

## 9 · Settings & preferences

`preferences.ts`:

```ts
adjudicator?: {
  enabled: boolean;               // default false — dormant until opted in
  tier?: "auto" | "small" | "large";  // auto: os.totalmem() ≥ 12 GB → large
};
```

Settings panel, **Intelligence** section (directly under the existing intel-mode
control, matching the `settings-toggle-row` pattern):

- Row "Continuity assistant" + one-line desc "Checks who could know what, using a
  small model that runs entirely on this Mac." `GlassToggle`.
- On first enable: inline state line replaces the desc — "downloading Qwen3 1.7B
  · 1.1 GB · 43%" → "ready · uses ≈1.5 GB of memory while checking". Errors
  render here too ("paused: not enough free memory right now"), never as
  dialogs.
- Tier override lives in **Advanced** ("Assistant model size: Auto / Small /
  Large") — auto is right for almost everyone; the row exists so a 16 GB owner
  on battery can pin small.

---

## 10 · Timeline & story-system integration

The ledger is the timeline's missing dimension: the graph knows *where everyone
is*; the ledger knows *what everyone knows*. Integration is read-only selectors
over the ledger store — StoryGraph's schema is not touched.

- **`buildKnowledgeTracks(ledger, storyGraph): KnowledgeTrack[]`** in
  `knowledge-ledger.ts` — per character, the ordered list of
  `{entity, chapterNumber, how}` acquisition events. Rendered in
  `TimelineGraphFull`'s cast ledger as a **knowledge lens**: selecting a
  character dims presence bars and draws acquisition ticks ("learns of the Root
  Crown · ch 7"), with `author-asserted` facts marked distinctly (the writer's
  own canon, visually senior to inference).
- **`ArcInsight` kind `"knowledge-break"`** — built in `story-arc-insights.ts`
  from adjudicated breaks, severity `attention`, same 5-cap, same click-to-jump.
- **First-meeting beats** (free, no model): the first chapter where two major
  characters are co-present is a `ChapterGraphEntry`-derivable fact the
  chapter brief (`chapter-observation.ts`) may mention once: "Nora and Elias
  share a scene for the first time." Behind the same feature flag, shippable in
  M1 as the ledger's first visible value.
- **Character arcs, later**: `KnowledgeTrack` + `TimelineCharacterTrack` +
  `MajorEvent.agent` is the substrate a future per-character arc view composes
  over (who acts, who appears, who learns — the third axis is what this spec
  adds). Out of scope v1; the store shapes above are designed so this needs no
  migration.

---

## 11 · Verification (gates, not vibes)

House rules apply: DEV = pride, sherlock, anne, dracula, carol, webnovel;
TEST = gatsby, antonia, treasure, awakening, expectations, frankenstein, worlds.
**Never tune against TEST.** All gates `process.exit(1)`.

| Harness | Gates |
|---|---|
| `scripts/test-knowledge-ledger.ts` (M0/M1) | volume band 0.5–3.0 candidates/chapter on DEV; synthetic-break recall ≥ 0.85 (inject references to late-introduced entities into early chapters — ground truth by construction); zero candidates for chapter-1 cast; presence-widening monotonicity (widening never creates a candidate); anchor-retirement on edit |
| `scripts/test-evidence-pack.ts` (M2) | determinism (same inputs → identical bytes); budget never exceeded; rungs 1–3 always present; degrades correctly with embedder absent; snapshot fixtures |
| `scripts/test-adjudicator-eval.ts` (M3) | frozen gold: ~120 hand-labeled survivors from the M0 run on DEV books, labeled once, frozen like the stress-story gold, known misses PRINTED; per-model gates: schema validity 100% (grammar-guaranteed, asserted anyway), break-precision ≥ 0.8 at ship threshold, break-recall ≥ 0.6, unsure rate in 10–40% band, p50 latency ≤ 8s on CPU tier |
| `scripts/verify-adjudicator-runtime.cjs` (M4) | Electron harness: fork host, load model if present (CI skips gracefully), 3 canned adjudications round-trip, cancellation mid-generation works, timeout latch works, unload actually frees RSS (measure, don't trust), re-download resumes from Range offset |
| `scripts/audit-knowledge-ood.ts` | report-only on TEST books, run at milestones, **never gated, never tuned against** |

Canaries (the color-wheel discipline: prove the test can fail): a fixtures book
with one planted break must flag; the same book with the break's setup scene
restored must go silent; setting the confidence threshold to 0 must fail the
false-alarm gate.

Funnel counters ship in the store (`generated / guarded / adjudicated /
surfaced / dismissed`) and print in the debug panel — count the funnel, don't
hypothesise, and a writer's dismissal rate is the live precision metric the
gates can't see.

---

## 12 · Milestones

Each milestone lands green and committed before the next starts; every exit gate
is a measurement.

- **M0 — deterministic precision.** Port probe → `knowledge-ledger.ts` pure
  functions with the three class-guards. Re-measure the funnel.
  *Exit: labeled DEV precision ≥ 1-in-3, volume in band, harness green.*
- **M1 — ledger in the app.** Store + fact extraction wired into the
  `buildChapterEntry` effect, invalidation, chapter-id stability, first-meeting
  beat behind `debugPanel`. *Exit: facts survive reload/reorder; edit-retire
  proven; test-knowledge-ledger green in app-shaped fixture.*
- **M2 — evidence assembler.** `evidence-pack.ts` + retrieval via
  `narrativeLMEmbed` + snapshots. *Exit: test-evidence-pack green; packs read
  well by hand on 20 sampled candidates (a person reads them — packs are the
  product).*
- **M3 — runtime spike + bake-off.** utilityProcess + node-llama-cpp on
  Electron 42 (compat is THE spike risk); grammar path; label the frozen gold;
  bake off Qwen3-1.7B vs Qwen3-4B vs Granite 4.0 Micro on it; measure on a
  real 8 GB machine, Metal and CPU. *Exit: eval gates green for the chosen
  tier models; go/no-go on utilityProcess recorded in this file.*
- **M4 — lifecycle.** Model manager (download/resume/verify), scheduling,
  caching, memory guard, TTL unload, settings row.
  *Exit: verify-adjudicator-runtime green; airplane-mode and kill-mid-download
  by hand.*
- **M5 — surfacing.** ContinuityWidget group, margin pill, popover with the
  three actions, decision durability, `knowledge-break` ArcInsight, timeline
  knowledge lens. *Exit: planted-break fixture walkthrough end-to-end; clean
  classics stay silent at ship threshold; light/dark pass.*
- **M6 — hardening.** OOD audit run, funnel counters, ARCHITECTURE.md §
  addition, CLAUDE.md test-table rows, UPGRADE-LOG entry.

M0–M2 are pure TypeScript with no new dependencies and deliver standalone value
(better probe precision, first-meeting beats, the fact substrate). The model
enters at M3 only, so the riskiest dependency is also the most deferrable.

---

## 13 · Risks, decided and open

Decided:
- **Model never on the keystroke path** — architecture makes it impossible, not
  discouraged (no IPC from the editor's input handlers).
- **No cloud fallback.** This feature is local or silent. The existing
  `renderer-review` Anthropic path stays separate.
- **Class 1–3 fixes are deterministic** — the model is never asked to paper over
  a cheap bug (M0 gate enforces the order).
- **Apache-2.0 models only for defaults** (Qwen3 family, Granite challenger).

Open, with owners:
- Electron 42 × node-llama-cpp utilityProcess compat — M3 spike, first task,
  main-process fallback pre-designed.
- CPU-tier prefill speed on Intel (secondary sources only, ±50%) — M3 measures
  on real hardware; the 1200-token CPU pack budget is the lever if slow.
- Small-model verdict calibration (grammar guarantees shape, not judgment) —
  the frozen gold + unsure-band gate is the instrument; if 1.7B fails the
  precision gate on Metal-less machines, the honest ship is "large tier only"
  rather than a lowered gate.
- Whether `plausible_offscreen` verdicts should auto-write a `reference-implied`
  fact (current spec: yes, so the question is never re-asked) or leave the
  candidate dormant — revisit with M5 usage; auto-write is reversible since
  verdictKeys record provenance.
