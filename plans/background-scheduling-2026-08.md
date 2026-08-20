# Background scheduling: what was fixed, and what is still unexplained

**Report (owner, 2026-08-19):** chapter summarisation and the timeline chips
make the UI lag from a saturated GPU. Ask, rewrite and the character
description must stay as they are. Follow-up: *"open the story timeline sidebar
and timeline full screen while the summarization and chip creation is running
and you will clearly see lag."*

**Status:** two real defects found and fixed with gates. The frame-rate cost is
reproduced and reduced but **not fully explained** — five hypotheses were
refuted by their own experiments, including three I was confident in. This
document is written so the next pass starts from the instrumentation rather
than from a sixth guess.

---

## 1. Fixed, with gates

### The writer's work queued behind the app's own

Every caller used `lane: "batch"` — one FIFO pool of three shared by the ask
popover, the writing tool, the dossier fields **and** the chip/summary tick. An
ask arriving while the tick held all three slots waited for a whole
chapter-sized request to finish, and that included the popover's own prewarm,
whose entire purpose is to be ready before the writer clicks.

Two pools now:

| lane | who | concurrency |
|---|---|---|
| `batch` | ask, rewrite, dossier, prewarm — the writer is waiting | 3 (unchanged) |
| `background` | chips, chapter summaries — nobody is waiting | 2, and only when the other pool is empty |

An interactive arrival **cancels** in-flight background work rather than waiting
for it. That work is keyed and idempotent, so the slot costs one redo.

**A reclaimed slot must not read as a failure.** The runtime can only report a
cancel as `cancelled`, which the tick counts as a transient strike; three
strikes add a session-long skip key. Three asks near one chapter would have
silenced exactly that chapter — and the chapters a writer works next to are the
ones that go stale most often. Preemption returns its own reason and earns no
strike.

Gate: `verify:assistant-lanes` (10, deterministic, stub bridge whose runs never
settle on their own — "was it dispatched" is not observable against a real
engine) and `test:assistant-lanes` (18). Both carry a **negative control**: with
one shared pool the same ask is not dispatched at all, so the tests can tell the
new arrangement from the old.

### Convergence took the writer's moment

The tick now waits for a still screen: 600ms of quiet, with a 30s starvation
ceiling so someone typing without a gap still gets chips (`src/lib/ui-activity.ts`).

```
tick on     116.3 fps   35 frames >25ms    0 units converged
quiet       no pointer, 120s              30 units converged
```

**The gate is not allowed to pass by doing nothing** — deferring work trivially
restores the frame rate, so every arm reports units converged and the run ends
with a quiet phase proving the deferred work still lands.

Bad frames on the timeline scene went **69 → 33-35** per 40s.

---

## 2. Refuted — five hypotheses, each killed by its own experiment

| hypothesis | measurement | verdict |
|---|---|---|
| chip/summary decoding saturates the GPU | real request bytes at the shipped concurrency, driven at the engine with the app scrolling: **120.5 fps, 0 frames >25ms, GPU pegged at 98%** | **false** |
| the pool of 3 is too aggressive | concurrency is not the lever; 3 concurrent chapter-sized requests cost nothing | **false** |
| a model load landing on a decoding engine | warm engines together: **one 65ms frame in 25 seconds**. Loads alone: 8 in 25s, zero bad frames | **false** |
| a cold engine boot | a boot inside the measured window: **120.1 fps, zero frames >25ms, worst 17ms** | **false** |
| the book is too big | the timeline **virtualises** — 174 chapters is 2054 SVG nodes against 1298 for twelve; idle stays 119.9 fps | **false** |
| the in-process host's micro-batch (512) | `ASSISTANT_BATCH_SIZE=128`: 114.7 fps / 46 bad against 512's 116.3 / 35 | **false** (and unverified — the host never reports the batch it applied) |
| the in-process host's inference | ablating every in-process consumer made it **worse**: 113.6 fps / 46 bad against 116.4 / 34 | **false** |

### The attribution error underneath three of those

Six harnesses reported "0ms of blocking script" on 400-1300ms frames, and I read
that as *the renderer is idle, therefore GPU contention*. **`longtask` and
`blockingDuration` cover script only** — style, layout and paint are not tasks.
Long Animation Frame timing splits it properly (`startTime → renderStart →
styleAndLayoutStart → end`), and that is what `probe-render-attribution.cjs`
measures. Every conclusion that rested on the old reading had to be re-tested;
three of them fell.

---

## 3. What is still unexplained

Reproducible and bracketed (idle arms 120.0 / 120.2, drift 0.2):

```
idle        120.0 fps    0 frames >25ms
tick on     116.4 fps   34 frames >25ms   worst  75ms
idle again  120.2 fps    0 frames >25ms
```

The residual is **~4 fps and 30-46 frames between 25 and 130ms per forty
seconds** on the full-screen timeline, and:

- it has **zero script, zero rAF and zero style/layout/paint** on the long frames
- it does **not** track which engine is busy
- in the ablated arm the sidecar reports `inflight=0` from 8.8s onward and the
  host is ready, yet the worst frames are at **15.3s, 16.0s, 17.4s, 17.6s** —
  **both engines idle**
- it appears only when the app's assistant is **enabled**, never when the same
  inference is driven at the engine from outside the app

That last pair is the shape of the remaining lead: something about the renderer
having the assistant *mounted* costs frames independently of any inference
actually running. Untested candidates, in the order I would take them:

1. **The progress IPC.** Main broadcasts `run-text` to every renderer on a
   120ms throttle, carrying the *accumulated* text — a growing payload re-sent
   ~8 times a second per in-flight request. Cheap to test: drop the emitter and
   re-run.
2. **Effects mounted only when the assistant is enabled** — the review sweep,
   adjudication and knowledge sweep effects and their timers, independent of
   whether they run a model.
3. **The hover path under `lmChips`.** The probe sweeps a synthetic pointer
   every frame; chips that have landed may mount a card the plain events do not.

---

## 4. Harness lessons paid for here

- **A story graph entry is built only for the chapter the writer is ON.** Booting
  and waiting yields one entry, already converged, and an idle machine to
  measure. Page through the book first — and note that paging a real book cost
  **80 seconds per chapter by chapter 29** and was still slowing, which is why
  the scale probe synthesises the graph instead.
- **App.tsx's keyboard shortcuts return immediately under Electron** — the
  application menu owns every accelerator. Paging goes through `menu-command`.
- **The app caches its answers on disk.** The first bisect window consumed all
  the work and the rest measured nothing, which reads exactly like "dropping
  this fixed the frames". Restore a snapshot of `.renderer/` per window.
- **A driver without a backoff is a busy loop in the main process.** Re-asking a
  fast-failing engine pegged a core, after which `executeJavaScript` could not
  resolve and a 25-second phase ran for six minutes without printing.
- **A probe that never closes the panel measures an already-open panel.** It
  reported the timeline appearing in *negative* milliseconds under every
  condition. Assert the starting state.
- **A phase passing `lane:'background'` to main proved nothing** — that word is
  renderer-side, main routes on `'batch'` only, so the phase bypassed the
  sidecar and reported a clean 120.2 fps that read exactly like the fix working.
- **Bracket, and bucket.** Unbracketed, the same window read 38.3, 75.0 and
  118.4 fps across three runs. And a 30-second mean hid a burst that ten-second
  buckets showed at once (16.4 → 119.7 → 120.7).

## 5. Harnesses

| script | what it answers |
|---|---|
| `probe:render-attribution` | where long frames go (script / rAF / style+layout), engine timeline, ablation switch |
| `probe:timeline-stutter` | bracketed, bucketed frame trace on the timeline with the real tick |
| `probe:engine-collision` | loads vs decoding, 2×2, with an eviction witness |
| `probe:gpu-yield` | real request bytes driven at the engine; positive control (`-ub 2048`) |
| `probe:panel-open` | click-to-pixels for the sidebar and full-screen timeline |
| `probe:boot-cost` | a cold boot inside the measured window |
| `probe:timeline-scale` | 12 vs 174 chapters, synthesised graph |
| `verify:assistant-lanes` | the scheduling contract, deterministic |
