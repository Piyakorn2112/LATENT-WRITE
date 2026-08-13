# Inference memory, measured to the process and reduced where it is real

**Question.** Can raw inference memory come down further with ZERO effect on
quality or behavior — not scheduling around pressure, but using less?
Context: a 16GB dev machine that still stutters when the app shares RAM
with a browser, video and chat apps; the realistic user machine never gives
the app full memory.

**Method.** probe-mem-inference.cjs: fresh process per configuration,
per-process RSS from ps (main, helpers, utility host, llama-server), and
every knob run prints the RAW BYTES of three fixed requests — two short and
one ~900-token prompt that forces CHUNKED prefill, because a batch-size
knob that only proves equality on short prompts proves nothing.

## The anatomy (measured 2026-08-13, this 16GB machine)

```
app shell, nothing loaded                                 ~350MB
host 1.7B @4096 (weights 1.06GB mmap + f16 KV 0.42GB)     ~1.78GB in the utility process
host 4B  @8192 (weights 2.50GB mmap + Q8 KV 0.57GB)       ~2.85-3.6GB (mmap page-cache noise)
sidecar 4B (4x2048 Q8, ub128)                             ~3.1GB in llama-server
BOTH warm (sidecar + small host) — the real-world case    ~4.9GB total
after assistantUnload                                     ~356MB — the utility process EXITS clean
```

Two structural facts worth more than any knob:

- **Weights are mmapped and evictable on both engines.** Under real
  pressure the OS reclaims weight pages (observed: the same warm 1.7B host
  at 1477MB beside a hungry sidecar vs 1779MB alone). The practical floor
  beneath a browser-heavy session is lower than warm RSS, and reload from
  page cache is ~1.3s.
- **Teardown is already perfect.** Unload kills the utility process
  entirely; nothing lingers. There was no residue lever to pull.

## Knobs measured and REFUTED (kept as env probes, defaults untouched)

- **Host createContext batchSize 512 → 128**: outputs byte-identical on all
  three fixed requests including the chunked long prompt — and RSS moved
  ~11MB, inside noise. The logits/compute-buffer theory (151k vocab ×
  batch positions) does not hold on this binding; it evidently allocates
  output logits per sequence, not per batch position.
- **Sidecar -b 2048 → 512**: byte-identical, 1MB delta. Same verdict.

The refutations are the finding: on this stack, batch geometry is not
where the memory lives. `ASSISTANT_BATCH_SIZE` / `ASSISTANT_SIDECAR_BATCH`
/ `ASSISTANT_SIDECAR_CACHE_RAM` remain wired for future engine versions.

## What shipped (raw reductions, zero behavior delta)

1. **Sidecar --cache-ram 1024 → 512.** The host-RAM prompt cache is a
   session-growth ceiling: it fills as evicted slot prefixes are re-cached,
   so a long writing session was licensed to grow ~1GB of cache. 512MB
   still holds 3-4 full 2048-token Q8 slot states — the task types that
   actually interleave — and the cost of a miss is a re-prefill, never an
   output change.
2. **Small-tier idleTtlMs 5min → 120s.** The 1.7B inherited the generic
   5-minute TTL and held its 1.78GB three minutes longer than the 4B holds
   its own 90s leash. Background small-tier work arrives in bursts; 120s
   covers a burst, then the memory goes back. This shrinks the BOTH-WARM
   window — the 4.9GB case — which is exactly the state that collides with
   a browser.

Combined effect on the realistic session: the worst-case envelope is
entered less often and exits ~3 minutes sooner, and long sessions stop
accreting a second half-gigabyte of prompt cache. Peak instantaneous
inference RSS is unchanged by design — every peak byte left is weights
(evictable), KV (already Q8 where byte-identical, f16 where Q8 was
measured changing answers), or the engine itself.

## The wall, stated honestly

The remaining big numbers are irreducible under the no-behavior-change
constraint: weights at Q4_K_M (any requant changes logits — blocked), the
1.7B's f16 KV (Q8_0 was measured changing an answer on this tier —
settled), and the 4B KV already at Q8_0 (byte-identical, verified). The
next real step change would be single-engine residency (a small-tier
sidecar config so only one engine is ever warm, −1.8GB worst case) at the
cost of tier-switch reboots — a behavior-adjacent latency trade that
belongs to a future round with its own bench, not to this constraint.

Gates on the shipped pair: verify:engine 4/4, verify:assistant-tasks
30/30, tsc and vite build clean, fixed-request bytes identical.
