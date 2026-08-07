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
