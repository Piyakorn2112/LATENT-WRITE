# Harness upgrade spec — implementing the research report

Source: plans/local-harness-research.md. Scope decided by measured benefit and
risk; everything shipped must hold two invariants:

1. **No degradation.** Attempt 0 of every existing op is byte-identical in
   behavior to today (same prompts, temp 0, same batching, same gates as the
   default profile). New behavior exists only on paths that today FAIL.
2. **Real-world verified.** Every phase lands with a probe on the real model
   or the real engine, not only unit gates.

## Phase 1 — sidecar cache sizing (report item 3, plus a memory fix)

b10298 defaults `--cache-ram 8192` (ON) with `--cache-idle-slots` on. Our
launch args never capped it, so llama-server has been licensed to grow 8GB of
host-RAM KV cache the memory guard knows nothing about. Fix and win in one
move. Pass `--cache-ram 1024` explicitly: bounded tenant (~7 slot states at
2048 tok Q8 for the 4B), and cross-slot prefix reuse becomes deliberate. Keep
idle-slot caching (it requires cache-ram; now it is bounded). Skip
`--cache-reuse` (documented conflicts) and `-sps` changes (default 0.10 fine).

Verify. Server boots with the flag; mixed task-type warm rerun shows prefill
drop (prompt_n from server timings); e2e probe still green; no orphan.

## Phase 2 — classify, provision, retry (report items 1+2, section 2)

### Classifier (`src/lib/writing-intent.ts`, rules-only layer 1)
`classifyInstruction(instruction) → { intent, targetParas? }` with intents
`merge | split | condense | expand | insert | tone | unknown`. High-precision
English keyword rules; anything unmatched is `unknown`, which routes exactly
like today (nothing gets worse by construction). Embedding layer 2 and the
1.7B layer 3 are deferred until rules-miss frequency is observed.

### Strategy
- merge/split/condense are STRUCTURAL: the selection runs as ONE batch (cap
  STRUCTURAL_MAX_CHARS = 2800; longer selections fail honestly with
  "selection-too-long", never mis-batch). They get a new STRUCTURE_SYSTEM
  prompt that licenses reshaping paragraph breaks (CUSTOM_SYSTEM forbids it,
  which is exactly why these ops were inexpressible). Real-model probed.
- insert gets INSERT_SYSTEM licensing a NEW beat grounded in context (the
  LENGTH prompt forbids new events by design). Whole selection, one batch.
- expand keeps the LENGTH_SYSTEM routing it already has.
- tone/unknown keep CUSTOM_SYSTEM.
- Provisioning is pre-flight: characters named in the INSTRUCTION are sent
  even when absent from the batch text (today they are dropped).

### Gate profiles + diagnosis
`judgeRevision(original, revised, profile) → { ok, failure? }` replaces the
boolean-only gate on new paths; `revisionAcceptable` keeps its exact current
behavior for the default ops. Profiles:

| intent    | paras                    | length (of source)   | grammar gate |
|-----------|--------------------------|----------------------|--------------|
| merge     | target (default 1)       | 0.35–1.15x combined  | mechanical   |
| split     | target (default > source)| 0.8–1.4x             | mechanical   |
| condense  | ≤ source                 | 0.3–0.85x            | mechanical   |
| expand    | drift ≤2                 | 1.15–4.0x + 240      | mechanical   |
| insert    | ≥ source+1               | ≥ 1.25x              | mechanical   |
| tone      | drift 0                  | 0.6–1.6x             | mechanical   |
| unknown   | today's custom gates     | today's              | today's      |

Failure records carry code + numbers (para-count expected/got, length ratio
vs bound, new hard-error count) so the retry prompt and the popover can both
speak them.

### Bounded retry loop (max 3 attempts per batch, gate failures only)
- Attempt 0: strategy row, temp 0 (today's baseline).
- Retry 1: same request + one plain-numbers diagnosis line on the USER turn
  (the measured-safe channel; system prompts stay frozen). An `unchanged`
  answer on custom/structural intents counts as a failure ("returning it
  unchanged is a wrong answer") and retries once.
- Retry 2 (custom only): temp 0.7 + minP 0.05 resample — a passing candidate
  ships the moment it passes, so "judge both" reduces to first-pass-wins;
  gate-failing candidates are never shippable.
- Exhausted: keep original, surface the last diagnosis verbatim in the
  popover ("Both attempts came back at 2.3x; the limit for this is 1.8x").
- Runner failures (low-memory, timeout, busy) never retry; they already have
  honest labels and retrying would fight the memory guard.

Grounding: retries carry external verifier feedback only (Kamoi TACL 2024;
RefineBench 2025); self-critique is never requested.

## Phase 3 — sampling plumbing (report items 4+11, narrowed)
`temperature`/`minP` ride AssistantJSONRequest → main → host (node-llama-cpp
prompt options) and sidecar (`min_p` on /completion). DEFAULTS UNCHANGED
(temp 0 everywhere attempt 0 runs). Sampling is used ONLY by retry 2, where
deterministic decoding has already failed twice. Full best-of-N on attempt 0
is deferred until the sidecar serves interactive lanes.

## Phase 5 (shipped 2026-08-08) — term-targeted intents

The family where the gate can COUNT what the instruction names (field
research: plans/writer-request-research.md). `readTarget` extracts
(term, replacement) from replace/change/turn/rename/instead-of/reduce
shapes; meta words (tone, tense, this...) never become targets. Four modes:
rename (both sides name-shaped → DETERMINISTIC renameAll, no model, no
length cap), pronounize (count must fall; WHICH mentions stay is the
model's judgment, the soft bound), substitute (term → 0, replacement must
appear), reduce (count strictly falls). Term is re-cased against the prose
pre-flight; a typo or single-mention pronounize fails honestly before any
model run. Counting is case-insensitive ("Suddenly"/"suddenly"), word-
bounded, possessive-inclusive. Measured: 10/10 probe cases ship
(probe-writing-intents.cjs) including all three target modes at attempt 0.

## Phase 6 (shipped 2026-08-08) — scrub family + continuity patches

The self-editing-checklist tier of the field research: filter words,
-ly adverbs, passive voice, sentence-opening runs (`ScrubKind`), plus
continuity patches ("she's holding a knife, not a gun" reads as a REVERSED
substitution, article required so "shorter, not longer" never matches).
Three load-bearing mechanisms, all measured on the real 4B:
- Clean paragraphs are SKIPPED by count before any model call (batch-level
  provisioning; a zero-count paragraph would otherwise fight the
  unchanged-retry loop).
- The harness NAMES THE OFFENDERS on the user turn (it already counted
  them for the gate) — kinds whose targets are visible ship at attempt 0.
- ★★ WRITING_SCHEMA_SCRUB's leading "rewrites" field breaks the copy
  attractor: with a plain {"text"} schema the 4B returned stuck passages
  VERBATIM through prompt, offender list, worked example AND sampled
  retry; a plan field emitted first (declaration order) fixed the same
  case immediately.
Result: 14/15 probe cases ship. KNOWN LIMIT: opening-run ("vary the
sentence openings") survived four presentation variations unchanged =
4B capability limit, withdrawn per the falsification discipline; the
refusal still surfaces the counted diagnosis, which is useful on its own.

## Performance pass measurements (2026-08-08)

- REJECTED, measured: flashAttention + Q8_0 KV on the SMALL (1.7B) tier.
  verify-assistant-tasks: baseline 30/30 at 78.6 tok/s; with FA+Q8 29/30
  (a clear-break verdict flipped to unsure) at 66.0 tok/s. Slower AND a
  quality flip; the max tier keeps its measured FA+Q8, the small tier
  keeps f16. Do not re-litigate without new binding versions.
- REJECTED, architectural: `-ub` chunked-prefill tuning — the report's
  interactive-latency benefit assumes interactive and batch share one
  server; ours do not (writing/ask are in-process, chips ride the
  sidecar), so there is no head-of-line to bound.
- REJECTED: `--defrag-thold` (deprecated in b10298), slot save/restore
  before preemption (writing ~500MB to disk delays the interactive load
  the preemption exists to serve), writing-tool contextSize 4096 (the
  guard's context ladder already covers tight machines; on fit machines
  it would force an 8192 reload when the ask surface follows).
- Positive wins this pass: scrub skip-clean-paragraph batching (model
  calls only where the count is nonzero), one shared scrub grammar
  (cache hit per batch), scrub/target token budgets at 1.6x instead of
  custom's 2.8x.

## Phase 7 (shipped 2026-08-08) — adaptive thinking + the ask context system

Research: plans/adaptive-thinking-research.md. The measured ground truth
was that thinking NEVER actually happened (a grammar masks think tokens
from token zero), so noThink:false was cosmetic on every constrained run.

- **Two-phase think-then-constrain on the host** (the CRANE pattern, gains
  proven at 1.5-8B): a freeText run (no grammar, `customStopTriggers`)
  captures real reasoning — node-llama-cpp SEGMENTS thought out of
  responseText, so the host reconstructs from the segment array — and the
  notes ride the user turn of the normal constrained request. The prefix
  cache makes the second prefill ~free (measured: 2.6-3.8s treated answer
  after a 12-29s think).
- **Decision ladder (rules, no router model)**: background batch never
  thinks; ask menu kinds never think; free questions think on difficulty
  features (causal shape, ≥2 entities, length), causal+multi-entity gets
  1024 tokens (448 and 768 both truncated mid-walk, measured); writing
  thinks at attempt 0 only for insert/tone/unknown, and on EVERY custom
  retry (gate failure = the cheapest accurate difficulty signal). Notes
  keep their TAIL on truncation — conclusions form at the end.
- **Thought attempts get relaxed gates** (owner call): windows ±15%,
  slack +80, drift +1 — contracts (exact paras, term counts, measures,
  grammar) never relax.
- **Ask context system**: questionEntities resolves lowercase-typed names
  against cast AND the chapter's own capitalization; the MENTIONS rung
  packs co-mention-first paragraphs labeled P{n}; entity questions get a
  deterministic scope note (the system prompt anchors to "that paragraph",
  which answered chapter-scope questions from one beat, measured).
- Measured: "what did tim do to annaha in this chapter" now answers with
  the full arc citing mentions (control answered one beat); tone-funny
  ships at attempt 0 thought (previously needed a diagnosed retry);
  14/15 intents ship with zero retries; 30/30 constrained-run gates
  unchanged. Playful rotating "thinking" indicator in both popovers.
- Research caution honored: thinking HURTS instruction adherence
  (13/14 models on IFEval) — which is why gated intents stay no-think at
  attempt 0 and the deterministic gates still judge every thought attempt.
- KNOWN LIMIT extended: opening-run fails even WITH thinking on retries
  (fifth presentation variation) — capability limit stands.

## Phase 8 (shipped 2026-08-08) — the quality-per-token benchmark

bench-think-ask.cjs: six question SHAPES (lookup, relation-arc, why,
temporal, absent-fact honesty, reconcile-how) through the REAL decision
ladder on the real 4B, with control/treated arms on every thinking case so
each reasoning token has a measured justification. Results: 23/23 gates;
thinking earned its tokens on 3/5 thinking cases (the relation and why
shapes; the temporal and reconcile shapes were already within the fast
path's reach on this fixture); the honesty case ABSTAINED even after a
think pass — reasoning does not cause invention. Writing side grew four
thinking cases (ominous, insert-dialogue, rhythm, transition): 19/19 ship
at attempt 0 thought. Classifier gained the ominous/eerie/sinister tone
vocabulary and possessive-stripped entity resolution ("annaha's warning").

## Where inference actually runs (measured 2026-08-08, M1 Pro)

Both engines are FULLY GPU-offloaded on Apple Silicon; nothing runs on CPU
by choice, and no mode or task type changes that.
- In-process host (node-llama-cpp, interactive lane): asks for
  `gpuLayers: 'max'`; reported back `gpu=metal`, 37/37 layers for the 4B
  (29/29 for the 1.7B), fa on, Q8_0 KV applied, 1.9s warm load.
- Sidecar (llama-server, batch lane): passes NO `-ngl`, and llama.cpp's
  default is `auto`, which resolved to `offloaded 37/37 layers to GPU`
  (2375.91 MiB weights + 612 MiB KV + 96.4 MiB compute on MTL0). The
  304 MiB `CPU_Mapped` remainder is the token-embedding table, which
  llama.cpp keeps host-side by design.
- ★ THE A/B THAT PROVES IT, same model and 1270-token prompt: default
  (GPU) 401 tok/s prefill and 35.5 tok/s decode; `-ngl 0` (CPU) 76 tok/s
  prefill and 17.1 tok/s decode. So Metal is worth 5.3x prefill and 2.1x
  decode here. Anything that silently loses offload would be very visible.
- Hardware dependence is real but narrow. `ENGINE.supported` gates the
  sidecar to darwin+arm64, so elsewhere the batch lane falls back
  in-process (same answers, less parallelism), and node-llama-cpp picks
  whatever prebuilt backend that machine has, CPU included. The memory
  guard shrinks CONTEXT or refuses with `low-memory`; it never quietly
  demotes to CPU.

## Sidecar tuning pass (measured 2026-08-08, M1 Pro, fullscreen-glass UI probe)

Shipped: `-kvu` (unified KV pool) and `-ub 128` (small micro-batch). Every
other researched knob was measured and rejected — the eliminated hypotheses
matter as much as the shipped flags.

- ★★ THE UI-CONTENTION LEVER IS MICRO-BATCH SIZE, NOT PROCESS PRIORITY.
  Each ubatch is one Metal dispatch; the compositor can only interleave
  between dispatches. A saturated sidecar at the default `-ub 512` cost a
  fullscreen-glass 120Hz scene ~12% of its frames (p95 17ms, worst 75ms);
  `-ub 128` returned it to 95% delivered, p95 12ms, zero frames >25ms.
  Cost, bracketed base/ub128/base: prefill 405 → 389 tok/s (4%), warm
  4-slot aggregate ~3%, decode unchanged. A light 480x320 probe scene
  showed ZERO contention at any setting — the probe scene must match the
  real compositor load or it measures nothing.
- Priority knobs rejected on measurement: `--prio -1` moved no frame
  metric and costs ~3% throughput; `taskpolicy -b` STARVED the host-side
  GPU feeding (worst frame 177ms, ten >50ms stalls) — the background QoS
  clamp E-cores the thread that submits Metal work. Idle-vs-busy CPU of
  the sidecar is 0.3% vs ~4%, so the `--poll 0`/`-t 2` advice from older
  builds has nothing to save on b10298; config stays minimal.
- `-kvu`: without it a prompt longer than contextTotal/slots is a flat 400
  even with idle neighbours (measured: 2228 tokens → 400; with -kvu it
  runs, 4-way concurrency intact, probe-sidecar-e2e 1.95x warm). Same
  total capacity, so the memory guard's math is untouched; it removes the
  artificial per-slot wall and the slot-halving reboot it forced.
- `--cache-reuse 256` tested and DROPPED: for an edited-chapter re-summary
  (shared head, one changed sentence, shared tail) prompt_n was identical
  with and without it, q8_0 and f16 KV both — chunked tail reuse never
  engaged on b10298; plain prefix caching already recovers the head.
- Blog-guide refutations for this hardware+model class: `-ub 2048` (Apple's
  gpt-oss advice) is ~7% WORSE than default here; ubatch 256-1024 all within
  noise on throughput. Measure per machine class, don't import advice.

## Deferred, with reasons
- Lazy-grammar think-then-constrain (item 5): needs a chip-gold A/B to prove
  no schema/quality regression; conditional benefit. Next pass.
- Embedding retrieval over chips (item 6): adds a 0.6B model download to a
  self-contained app; product-footprint call for the owner.
- Chip self-consistency (item 8): 2-3x background token cost against the
  owner's standing "chips must be fast" priority; modest predicted gain.
- K8/V4 KV (item 12): prose-register risk unmeasured; memory is currently
  healthy after the preemption + cache-ram fixes.
- EAGLE-3 speculation (item 13): no trained heads for our exact checkpoints.
- Model judge (item 14): premature until gate-tie frequency is observed.
- Sidecar freeze/save-restore (item 10): preemption just shipped and is
  verified; revisit if guard trips prove costly in practice.
