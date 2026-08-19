# Background scheduling: why the timeline stuttered

**Report (owner, 2026-08-19):** chapter summarisation and the timeline chips
make the UI lag from a saturated GPU. Ask, rewrite and the character
description must stay as they are. Follow-up: *"open the story timeline sidebar
and timeline full screen while the summarization and chip creation is running
and you will clearly see lag."*

**Answer:** the work was never the problem. Two engines loading and decoding at
the same time was.

---

## 1. What the measurements actually said

### The reproduction (`probe-bg-schedule.cjs`, then `probe-timeline-stutter.cjs`)

The real app, a real manuscript, the real tick, the surface the owner named,
bracketed between two baselines:

```
base-1  120.0 fps   p95 9.1ms   worst  10ms    0 frames >25ms
load     84.8 fps   p95 9.3ms   worst 537ms   63 frames >25ms
base-2  120.1 fps   p95 9.3ms   worst  10ms    0 frames >25ms
                                        baseline drift 0.1%
```

The mean hides the finding. The ten-second buckets do not:

```
16.4 fps / 57 bad   →   119.7 fps / 6 bad   →   120.7 fps / 0 bad
```

**All the damage is one burst.** For the other twenty seconds the sidecar runs
at 91% duty and 94% GPU and costs nothing at all.

Every bad frame is GPU-side. Zero longtasks, and the worst frames (379-540ms)
report **0ms of blocking script** — the renderer was not asked to do anything,
it simply could not get the GPU.

### The eliminations

`probe-gpu-yield.cjs` drove the real chip and summary request bytes at the
shipped concurrency of 3 straight at the sidecar, with the app scrolling
beside it:

```
idle      120.0 fps    0 frames >25ms    GPU  50%
shipped   120.5 fps    0 frames >25ms    GPU  98%    ← the shipped background load
on2048    116.6 fps   24 frames >25ms    GPU  99%    ← positive control, separates
```

**A pegged GPU is not a starved compositor.** The positive control separates, so
the harness can see a bad setting when there is one — and the shipped setting is
not one.

### The cause (`probe-engine-collision.cjs`)

Full-screen timeline, 25s phases, bracketed:

| phase | fps | frames >40ms | ms lost | decodes | loads |
|---|---|---|---|---|---|
| quiet | 120.4 | 0 | 0 | 0 | 0 |
| host reloads alone | 120.4 | **0** | 0 | 0 | 8 |
| sidecar decoding alone | 122.0 | **0** | 0 | 9 | 0 |
| **BOTH** | 115.0 | **15** | **757ms** | **2** | 7 |
| quiet (again) | 120.2 | 0 | 0 | 0 | 0 |

Eight full model loads on their own cost nothing. Nine chapter-sized decodes on
their own cost nothing. Overlap them and the frames go.

**And the frames were the least of it.** In that phase the sidecar was stopped
**five times** by the memory guard's `yield-to-interactive`, **four of seven**
host loads came back `low-memory`, and decoding throughput fell from **9 units
to 2**. The two engines evict each other in a loop: the host cannot fit beside
the sidecar so it kills the sidecar; the next unit of background work boots the
sidecar again (13.4s measured); the host tries again and hits `low-memory`.

**In max mode both engines are resident by construction.** The sidecar holds the
4B for chips and summaries, and every caller that passes no tier — the review
sweep, the adjudication sweep, the World panel's referent pass — loads the 1.7B
into the in-process host beside it.

---

## 2. What shipped

### The renderer: a background lane (`assistant-client.ts`)

Every caller used `lane: "batch"`, one FIFO pool of 3. An ask arriving while the
chip tick held all three slots queued behind up to three chapter-sized requests
— measured at **10.2s mean per request** at that concurrency — and that included
the ask popover's own prewarm, whose entire purpose is to be ready before the
writer clicks.

- `lane: "background"` is its own pool of 2. It starts only when **nothing else
  is pending in either lane**, and is cancelled the instant anything else
  arrives.
- Interactive concurrency is **unchanged at 3**, so the dossier's three
  independent field calls still ride together.
- The single-flight lane preempts too. Its callers run on the in-process host —
  the very engine whose loads collide with the sidecar — so yielding only to the
  batch pool would have left the collision in place. The rule this settles into:
  **one engine works at a time.**

### A reclaimed slot is not a failure

Preemption settles as `preempted`, never `cancelled`, and the chip tick gives it
a free retry. Counted as a transient strike, three asks near the same chapter
would have silenced that chapter for the session — exactly backwards, since the
chapters the writer works next to are the ones that go stale most.

### Main: loads never land on a decoding engine (`assistant.cjs`)

- A host load waits (bounded, then proceeds anyway) for the sidecar to go quiet.
- A sidecar **boot** waits for the host to go quiet — gated on the server
  actually being down, because `ensureStarted` is called per request.
- Background work no longer takes the `yield-to-interactive` branch. It was
  background evicting the sidecar that turned a tight memory fit into a thrash.
  Nobody is waiting for a chip; it can have the engine later.
- `ENGINE_QUIET_INTERACTIVE_MS = 800` is a **cap, not an optimum**, sized against
  the ~500ms of frozen frames a collision costs. The common case resolves in
  tens of milliseconds.

---

## 3. Verification

Same probe, same book, same scene, bracketed:

```
            fps    median   worst   >25ms  duty  gpu   chips converged
before     84.8    8.3ms    537ms     63    91%   94%    1 of 12
after     122.1    8.3ms     21ms      0    90%   94%    7 of 12
                                     baselines 120.0 / 120.1, drift 0.1%
```

Not one frame over 25ms, and the worst single frame in thirty seconds is 21ms.
The background work is doing **more**, not less.

The collision phases, re-run against the fix:

```
                          fps    >40ms   lost   decodes  low-mem  killed
BOTH  before             115.0     15   757ms      2        4       5x
BOTH  batch lane         120.2      0     0ms     19        0       1x
BOTH  background lane    120.2      0     0ms     17        0       0x
```

Both arms now sit exactly on the single-engine phases. Throughput recovered
**2 → 19**.

Gates: `test:assistant-lanes` (18, ordering and preemption against a fake
runtime whose requests finish on command), `verify:assistant-tasks` 30/30 at
82.0 tok/s against 83.6 recorded, plus `test:chip-picker`,
`test:chapter-summary`, `test:assist-reviews`, `verify:lane-keys`.

---

## 4. Do not relitigate

| claim | verdict |
|---|---|
| the chip/summary decoding saturates the GPU and costs frames | **false.** 120.5 fps at 98% GPU, zero bad frames, two independent harnesses |
| the pool of 3 is too aggressive | **false.** Concurrency is not the lever; 3 concurrent chapter-sized requests cost nothing |
| the cost is React re-rendering the timeline as chips stream | **false.** 0ms of blocking script on every 379-540ms frame, on the timeline scene itself |
| `-ub 128` is already enough | **true for the sidecar, and it was never applied to the in-process host** (node-llama-cpp sets `n_ubatch = n_batch = batchSize`, default 512). Untested; the collision fix made it unnecessary to chase |
| a model load freezes the GPU | **false on its own.** Eight loads in 25s, zero bad frames |
| the freeze is a load overlapping a decode | **true, and it is the whole finding** |

## 5. Harness lessons paid for here

- **A story graph entry is built only for the chapter the writer is ON.** Booting
  the app and waiting yields one entry, already converged, and an idle machine to
  measure. Page through the book first.
- **App.tsx's keyboard shortcuts return immediately under Electron** — the
  application menu owns every accelerator. Paging must go through the
  `menu-command` channel.
- **The app caches its answers on disk.** `assist-reviews.json` keys verdicts by
  chapter+hash+model, so the first bisect window answered every review question
  and the rest found them already asked and ran nothing — which reads as
  "dropping this fixed the frames" when there was no work left to do. Restore a
  post-warm-up snapshot of `.renderer/` before each window.
- **A driver without a backoff is not a driver.** Re-asking immediately on
  failure pegged Electron's main process at 100% of a core, which then could not
  resolve `executeJavaScript`, so a 25-second phase ran for six minutes without
  printing.
- **Bracket, and bucket.** The same "background work running" window measured
  38.3, 75.0 and 118.4 fps across three unbracketed runs; what moved was when the
  window opened relative to a load. And a mean over 30 seconds hid a burst that
  the ten-second buckets showed immediately.

## 6. Still open

- **`ASSISTANT_BATCH_SIZE` for the in-process host.** node-llama-cpp defaults to
  512, the setting `-ub 128` exists to avoid on the sidecar. It was never
  measured because the collision fix removed the symptom. If a machine ever
  stutters with only the host running, this is the first knob — gated on
  byte-identical output, since batch splitting changes reduction order.
- **Two engines at all in max mode.** The review sweep and adjudication run on
  the small tier in-process while the sidecar holds the 4B. Routing them through
  the sidecar would leave one engine, but it is a different model and would move
  their answers; it needs the golden sets re-run, not a scheduling change.
