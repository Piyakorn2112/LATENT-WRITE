# Getting more out of Qwen3-1.7B/4B in Latent Write: harness-architecture research report

Research window 2022-2026, weighted to 2024-2026. Evidence on ≤8B models preferred and flagged where it is thin. Items we already run are marked rather than re-sold. (Deep-research pass, 2026-08-07.)

---

## 1. Ranked technique list

### 1. Intent-conditioned edit routing (classify the instruction, then provision granularity + context + gates)
**Sources.** CoEdIT (Raheja et al., EMNLP 2023 Findings, arXiv 2305.09857, https://arxiv.org/abs/2305.09857, repo https://github.com/vipulraheja/coedit) · IteraTeR (Du et al., ACL 2022, arXiv 2203.03802, https://arxiv.org/abs/2203.03802) · DELIteraTeR (Grammarly Engineering, https://www.grammarly.com/blog/engineering/learning-where-to-edit/) · SetFit (Tunstall et al. 2022, arXiv 2209.11055, https://arxiv.org/abs/2209.11055).

**What it is.** The writing-assistant literature converged on a small closed taxonomy of edit intents. IteraTeR annotates human revisions as Fluency / Coherence / Clarity / Style / Meaning-Changed, and its headline result is that revision models conditioned on the annotated intent significantly outperform unconditioned ones. CoEdIT shows a 770M model matches models 60x larger on editing *because* every instruction is mapped into a known task class (GEC, clarity, coherence, simplification, formality, neutralization, paraphrase) before generation. DELIteraTeR adds the "where to edit" step (span delineation) before "how to edit".

**Expected win for us.** This is the strongest-evidence item on the list for our exact failure mode. Our gates currently encode ONE implicit intent (meaning-preserving in-place revision). The literature says a small model's editing quality is substantially a function of whether the harness knows the intent class, and our refusals ("merge two paragraphs" inexpressible) are purely a routing failure, not a model failure. High confidence, because the fix is mostly deterministic harness code.

**Implementation sketch.** In-process host, writing tool path, before batching. Full design in section 2. Classifier is embeddings + rules with a 1.7B grammar fallback.

**Cost/risk.** One embedding call (~10ms with a 0.6B embedder, or zero-model if we start rules-only) plus a strategy table. Main risk is misclassification sending a request through the wrong gate profile; mitigated by a conservative UNKNOWN default that behaves exactly like today.

---

### 2. Gate-grounded bounded retry (verifier-guided repair, never intrinsic self-critique)
**Sources.** Kamoi et al., "When Can LLMs Actually Correct Their Own Mistakes?", TACL 2024, arXiv 2406.01297, https://arxiv.org/abs/2406.01297 · Huang et al., "LLMs Cannot Self-Correct Reasoning Yet", ICLR 2024, arXiv 2310.01798 · RefineBench (2025, arXiv 2511.22173, https://arxiv.org/pdf/2511.22173) · Self-Refine (arXiv 2303.17651) · Reflexion (arXiv 2303.11366) · CRITIC (ICLR 2024, arXiv 2305.11738) · SWE-agent ACI (NeurIPS 2024, arXiv 2405.15793, https://arxiv.org/pdf/2405.15793v1).

**What it is / honest evidence.** The self-correction literature has a sharp split that maps perfectly onto our architecture. Kamoi's critical survey finds NO prior work demonstrating successful self-correction from prompted self-feedback, but consistent success when feedback comes from a reliable external verifier. RefineBench (the most recent and most size-stratified data) found self-feedback *degrades* output across all tested models, external feedback helps Llama-3.2-3B, and Llama-3.2-1B fails to benefit even from good external feedback. SWE-agent's ablations show that guardrails which return informative, concise error messages (instead of silent failure) are worth ~10 points of task success, and that they retain only the first error message in context to avoid clutter.

**Expected win for us.** Our deterministic gates ARE reliable external verifiers, so we are on the good side of the literature's split, but today they emit a bit ("failed, keep original") instead of a diagnosis. Converting each gate failure into a structured, specific message fed into one or two retries is exactly the pattern with positive published evidence. Calibrate by tier. Expect real repair gains on the 4B, modest on the 1.7B (RefineBench's 1B/3B result brackets our models), which argues for tier escalation as the second retry rather than more attempts on the 1.7B.

**Implementation sketch.** Host engine, writing tool. Each gate returns a machine-readable failure record (gate id, measured value, bound, direction, offending span). Retry prompt = original task + failure translated to plain instruction ("your revision was 2.1x the original; the limit for this operation is 1.8x; shorten it") + any newly provisioned context. Full loop spec in section 2.

**Cost/risk.** Worst case 3 generations per failed batch; bounded and only on failures, which are currently pure waste anyway. Risk of the model overcorrecting on retry; the gates re-run, so the floor stays "keep original".

---

### 3. Host-memory prompt cache + idle-slot caching on the llama-server sidecar
**Sources.** llama.cpp PR #16391, Oct 2025, https://github.com/ggml-org/llama.cpp/pull/16391 · server README, https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md · practical notes https://jessequinn.info/blog/llama-cpp-cache-ram-prompt-caching.

**What it is.** Since Oct 2025 llama-server keeps evicted slot KV states in host RAM (`--cache-ram N` MiB, default 8192, on by default in current builds) and treats them as "extra slots" for prefix-similarity matching, hot-swapping a cached state back into a slot when it beats reprocessing. Companions include `--cache-idle-slots` (save idle slots to the prompt cache on new task), `-sps --slot-prompt-similarity` (default 0.10, governs slot selection by prefix match), `--cache-reuse N` (chunk-level KV-shift reuse below the exact-prefix level; note documented conflicts with `--kv-unified`, test before enabling), and manual `POST /slots/{id}?action=save|restore` for disk persistence.

**Expected win for us.** Our 8x prefill win from byte-identical system prompts currently lives per-slot. With 4 slots and multiple task types (chips, summaries, ask, writing ops) interleaving, a slot that last served chip-scan gets clobbered by a summarization request and the chip prefix is recomputed. Host-memory caching makes the prefix cache effectively shared across slots and across task-type switches. Expected win is a large cut in re-prefill on mixed workloads (community reports are ~seconds-to-milliseconds for long shared prefixes; ours are shorter, so expect a solid but smaller win). This is probably the single highest value-per-hour change in goal C, assuming the pinned server build is ≥ b-Oct-2025.

**Implementation sketch.** Sidecar launch flags. Set `--cache-ram` to a value the memory guard owns (do NOT leave the 8GiB default on a RAM-guarded machine; the guard and the cache will fight). Additionally, sort the background chip queue by chapter/task so consecutive requests share the longest prefixes; this is the scheduling insight behind SGLang's RadixAttention (arXiv 2312.07104) applied client-side, since llama.cpp has no radix tree. **Partially ALREADY IMPLEMENTED** (byte-identical prompts per task type is the prerequisite; the cross-slot sharing is the missing piece).

**Cost/risk.** Host RAM. The memory guard must treat cache-ram as a first-class tenant (shrink it or `action=erase` under pressure rather than killing the sidecar, see item 10). Feature is young; keep a canary that measures prefill tokens/request before and after.

---

### 4. Best-of-N reranked by our existing deterministic gates (test-time compute we can afford)
**Sources.** Snell et al. 2024, arXiv 2408.03314 · HuggingFace "Scaling test-time compute" (Llama-3.2-1B with best-of-N/beam + verifier beats 8B; 3B beats 70B on MATH-500), https://huggingfaceh4-blogpost-scaling-test-time-compute.hf.space/ · GEC n-best reranking lineage, Chollampatt & Ng, EMNLP 2018, https://aclanthology.org/D18-1274/ · system combination via quality estimation for GEC, arXiv 2310.14947.

**What it is.** Sample N candidates, pick the best by a verifier. The HF replication is the key small-model datapoint. A 1B model with search against a verifier beats models 8-70x larger. The 20-year-old GEC literature says the same thing in our exact domain. Reranking n-best correction candidates with a quality scorer reliably beats taking the top-1.

**Expected win for us.** We already own the verifier (grammar checker + length windows + paragraph-count rules + the self-review claim checker), and it is deterministic and cheap. Today it can only accept or refuse ONE candidate. Give it 2-4 candidates and it becomes a ranker. Score = hard-error count (primary), then distance from length-window centre, then gate-profile-specific tiebreakers (for proofread, minimal edit distance; for expand, coverage of instruction keywords). Honest uncertainty. Published wins are on tasks with a checkable answer; our gates check form, not prose quality, so expect fewer refusals and fewer degenerate outputs rather than "better style". That is still directly valuable, since most user-visible failures are refusals.

**Implementation sketch.** Sidecar (this is what continuous batching is FOR). Fire N=2-3 identical requests with temperature jitter (e.g. 0.7/0.9 + min-p, see item 11) as parallel slot requests; they overlap in decode. Note each slot pays its own prefill (llama.cpp does not share KV across concurrent slots), so keep the per-request context tight and rely on item 3 for the shared system prefix. Use for rewrite/custom/expand ops and as retry-2 of the loop in section 2; skip for proofread (top-1 + gates already near ceiling there).

**Cost/risk.** N x decode cost and N-1 extra prefills, on demand; user-facing latency roughly one generation (parallel). Do not run under memory pressure; the guard already knows how to say no.

---

### 5. Two-phase think-then-constrain via lazy grammar triggers
**Sources.** Tam et al., "Let Me Speak Freely?", EMNLP 2024 Industry, arXiv 2408.02442, https://arxiv.org/abs/2408.02442 (constrained decoding hurts reasoning-heavy tasks, helps classification; their NL-to-Format two-stage mitigation recovers the loss) · dottxt rebuttal "Say What You Mean", https://blog.dottxt.ai/say-what-you-mean.html (with matched prompts, constraints don't hurt, and classification/extraction benefits) · Grammar-Aligned Decoding (NeurIPS 2024, arXiv 2405.21047, https://arxiv.org/abs/2405.21047, proof that greedy GCD distorts the output distribution) · llama.cpp lazy grammars, https://github.com/ggml-org/llama.cpp/discussions/12110.

**What it is.** Let the model produce free text first, then flip the grammar on. llama-server supports this natively in one request. `grammar_lazy: true` with `grammar_triggers: [{"word": "</think>"}]` leaves generation unconstrained until the trigger fires, then enforces the GBNF. So Qwen3-4B-Thinking can actually think, and the constrained emission starts only at `</think>`.

**Expected win for us.** Directly addresses our documented refutation (grammar masks think tokens, so thinking never happens) with the exact mechanism the refutation asked for. The literature's aggregate says constraints are fine for extraction-shaped output but the *reasoning before* the output matters on hard cases; GAD explains why (early constrained tokens commit the model to low-probability continuations). Best targets, in order. (a) "Ask about this paragraph" final answers when the evidence ladder had to widen (hard cases by construction). (b) Chip scan on paragraphs the 1.7B produced low-confidence or empty results for, re-run on the 4B with a think budget. (c) The self-review verification pass. Uncertainty is moderate. Thinking helps small Qwen3 models measurably on reasoning benchmarks, but nobody has published think-then-constrain numbers for story-fact extraction; wire an A/B on our own chip gold set.

**Implementation sketch.** Sidecar `/completion` only (the hand-built ChatML makes this trivial; replace the closed `<think>` prefill with an *open* `<think>` prefill + lazy grammar + a hard `n_predict` think budget). Keep the closed-think prefill as the default cheap path; open the think phase only on the escalation tiers above.

**Cost/risk.** Think tokens cost decode time (budget 128-512). Guard against runaway thinking with `n_predict` and a stop-string fallback. Verify the pinned build's `grammar_triggers` handling once (there were early crash reports on lazy grammars, issue #12196, since fixed).

---

### 6. Chip store as retrieval substrate + scene-level hierarchical context (beats a pure recency+summary ladder)
**Sources.** RAPTOR (ICLR 2024, https://arxiv.org/abs/2401.18059, repo https://github.com/parthsarthi03/raptor) · Storyline Trees (2026, arXiv 2606.20900, https://arxiv.org/pdf/2606.20900) · CHIRON character sheets (EMNLP 2024 Findings, arXiv 2406.10190, https://arxiv.org/abs/2406.10190) · Qwen3-Embedding-0.6B GGUF, https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF.

**What it is.** Three converging results on long-narrative context. RAPTOR shows retrieval over a tree of recursive summaries beats flat chunk retrieval because questions often match an abstraction level, not a passage. Storyline Trees (the most on-point, 2026) builds the hierarchy from *scenes* (contiguous narrative segments), navigates top-down then retrieves scene-level evidence; this beats both long-context models and agentic chunk retrieval at equal retrieval budget, and scenes beat chapters as the base unit. CHIRON shows that for character questions specifically, accumulated character sheets (facts extracted per character, then *validated by an entailment/consistency check*) beat summary-based context.

**Expected win for us.** We already run the extraction pipeline CHIRON describes; our chips ARE proto-character-sheets and proto-scene-facts, currently write-only from the model's perspective. Two upgrades. First, index chips (and paragraph text) with a local embedder and let "Ask about this paragraph" and the writing tool *query* them ("add more detail about X's action" pulls X's chips regardless of where in the manuscript they were extracted; this fixes the goal-A failure "may need context the batch does not carry"). Second, make the summary ladder two-level (scene summaries under chapter summaries) so the ask-ladder can widen by relevance, not only by adjacency. Uncertainty. Retrieval wins in these papers are on QA benchmarks with distant evidence; for questions answerable from neighbours the existing ladder already wins, so make retrieval a *rung*, not a replacement. **Partially ALREADY IMPLEMENTED** (the ladder, the summaries, the extraction; missing is the index and the semantic rung).

**Implementation sketch.** Qwen3-Embedding-0.6B-GGUF served from the sidecar with `--embeddings` (fits the stack; note the endoftext-append and client-side normalization quirks), or a separate tiny llama.cpp context in-process. Embed chips at scan time (they're already in the background queue); store vectors in SQLite. Ask-ladder gains a rung between "neighbouring paragraphs" and "story-so-far" via top-k chips + top-k scene summaries by cosine against the question. Writing tool gains entity-mention detection in the instruction (rules + chip-label match) that triggers a chip context package.

**Cost/risk.** ~0.6GB extra weights (Q8) plus vectors (negligible). Background embed cost rides the existing chip queue. Risk is retrieval pulling misleading chips; cap the package (e.g. 8 chips) and keep them clearly labelled as background facts in the prompt.

---

### 7. Two-tier cascade with confidence deferral (1.7B first, 4B on signal)
**Sources.** FrugalGPT (arXiv 2305.05176) · GATEKEEPER, confidence tuning for cascades (2025, arXiv 2502.19335, https://arxiv.org/pdf/2502.19335) · "Cost-Saving LLM Cascades with Early Abstention" (2025, arXiv 2502.09054).

**What it is.** Route every request to the cheap model; escalate to the expensive one when a deferral signal fires. Cascade literature's consistent finding is that most inputs don't need the big model and that simple confidence signals (mean token logprob, self-consistency disagreement, or an external verifier's verdict) are adequate deferral triggers when tuned on a small calibration set.

**Expected win for us.** We have the two tiers and, unusually, we have *deterministic* deferral signals, which sidesteps the calibration problem that GATEKEEPER exists to fix. Concrete triggers. Gate failure on the 1.7B (defer instead of retry-same-model, per the RefineBench size result in item 2); empty/low-rank chip output on paragraphs whose text length says they should yield facts; self-review flagging an unsupported claim; and intent classes tagged hard in the strategy table (merge, continuity insert, character elaboration go straight to 4B). Expected outcome is the 4B's quality at a fraction of its cost, and fewer flat refusals. Moderate-high confidence; the pattern is well-replicated, and our signals are better than the published ones.

**Implementation sketch.** A `tier` field in the strategy table plus an escalation rule in the retry loop (section 2). Memory guard note. Escalation may require a model swap; batch escalated work so swaps amortize (see item 10).

**Cost/risk.** 4B latency on escalated requests; swap latency if both models can't co-reside. Keep a per-session escalation budget so a pathological document doesn't pin the 4B.

---

### 8. Self-consistency for chip extraction (field-level vote, adaptive N, background only)
**Sources.** Self-Consistency (Wang et al., arXiv 2203.11171) · Adaptive-Consistency (arXiv 2305.11860, https://arxiv.org/pdf/2305.11860, up to 7.9x fewer samples for <0.1% accuracy loss) · caution, "Self-Consistency Is Losing Its Edge" (2025, arXiv 2511.00751) · caution, "Structured Output Collapses Answer Diversity" (2026, arXiv 2607.18476).

**What it is.** Sample the same extraction k times at temperature, keep facts that recur (per-fact vote, not whole-output vote). Adaptive-Consistency stops sampling early when the vote has converged.

**Expected win for us.** Chip scan is the one task where this is cheap (background queue, latency-insensitive) and where the failure mode it fixes (spurious or missed facts from a single 1.7B sample) is our quality ceiling. Two published cautions apply directly, which is why this ranks mid-list. Diminishing returns on modern models, and, more subtly, *constrained* sampling collapses output diversity across samples, which weakens the vote's independence assumption; jittering temperature and paragraph-context framing between samples partially restores diversity. Realistic shape. k=2 by default, agreement promotes rank; disagreement triggers a third sample or 4B escalation (item 7). Honest expectation is a modest precision gain on chips, measurable on the existing chip gold set, at 2-3x background cost.

**Implementation sketch.** Host engine, chip queue. Vote key = normalized (label, entity) pair; details merged by rank. Fits the tuple wire unchanged.

**Cost/risk.** Background tokens only. Do not apply to summarization (single 420-char cap output, voting is ill-defined) or interactive tasks.

---

### 9. Bound interactive latency under background load with ubatch tuning (chunked-prefill, llama.cpp flavor)
**Sources.** server README (`-b 2048` logical, `-ub 512` physical batch), https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md · the chunked-prefill idea originates in Sarathi/Sarathi-Serve (arXiv 2308.16369 / 2403.02310).

**What it is.** llama-server processes prompts in `-ub`-sized physical chunks inside the continuous-batching loop; a long background prefill occupies the pipeline for whole chunks at a time, adding head-of-line latency to interactive decode on other slots. Smaller `-ub` interleaves finer.

**Expected win for us.** The worst interactive feel-bug risk is "typing-adjacent request lands while a chip batch prefills". Dropping `-ub` (e.g. 512 to 128-256) bounds that stall at the cost of some raw prefill throughput on Apple-Silicon-class hardware. Also schedule-level, cap in-flight background requests to slots-1 so one slot is always free for interactive work. Cheap experiment; measure with the existing latency HUD discipline; sub-day to test, honest uncertainty on the exact knee point per machine.

**Cost/risk.** Prefill throughput loss (10-30% typical for small ubatch); background tasks don't care.

---

### 10. Memory guard: freeze/evict instead of kill (preserve the caches we paid for)
**Sources.** llama-swap (TTL-based model lifecycle for llama.cpp servers, https://github.com/mostlygeek/llama-swap) · llama.cpp slot persistence endpoints (`/slots/{id}?action=save|restore`, server README).

**What it is.** The guard currently *stops* the sidecar under RAM pressure, destroying warm KV, host prompt cache, and page-warm weights. Three graduated alternatives. (a) Shrink `--cache-ram` / erase slots via API (frees the biggest dynamic tenant without process death). (b) `action=save` hot slots to disk before stopping, `action=restore` on wake (SSD-speed resume instead of re-prefill). (c) SIGSTOP the process instead of SIGKILL; on macOS the compressor/pager reclaims its dirty pages and mmap'd weights are clean pages that evict for free, while SIGCONT resumes with caches intact when pressure clears. llama-swap formalizes this class of lifecycle policy (TTL unload, groups) if adopting beats building.

**Expected win for us.** Converts every guard trip from "cold start + full re-prefill storm" into a mostly-warm resume. No paper to cite for the SIGSTOP variant, it's an engineering claim; validate that Metal command-queue state survives long STOPs on this OS version (test a 10-minute freeze), and fall back to save/restore-to-disk if it doesn't.

**Cost/risk.** Low code cost. SIGSTOP variant needs the darwin validation above; disk save of a 4-slot Q8 KV state is hundreds of MB, fine on SSD.

---

### 11. min-p sampling for the creative ops
**Source.** "Min P Sampling: Balancing Creativity and Coherence at High Temperature" (arXiv 2407.01082, ICLR 2025), native in llama.cpp (`min_p`).

**What it is.** Truncation relative to the top token's probability instead of a fixed top-p mass; lets us raise temperature for varied prose without degenerate tails, with the paper's evidence gathered on 7B-class models.

**Expected win for us.** Small but essentially free quality/diversity knob for rewrite/custom/expand and for decorrelating best-of-N candidates (item 4) and SC samples (item 8). E.g. `temp 0.8-1.0, min_p 0.05-0.1, top_p off` for creative ops; keep proofread near-greedy. Low uncertainty, low ceiling.

---

### 12. KV quantization headroom: asymmetric K8/V4
**Sources.** Community measurements collected in https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/ (q8_0 KV ~+0.002-0.05 ppl, effectively lossless; q4_0 ~+0.2-0.25 ppl) · asymmetric discussion, https://github.com/ggml-org/llama.cpp/discussions/23470 (K is much more quantization-sensitive than V; K=q8/V=q4 measured at mean ppl ratio 1.004).

**What it is / for us.** **Q8_0 KV is ALREADY IMPLEMENTED** and is the right default. The marginal move if the memory guard needs headroom is `-ctk q8_0 -ctv q4_0` (V-only down-quant), which halves V storage at ~0.4% ppl cost; never quantize K below q8. This buys either more slots/context or a bigger `--cache-ram`. Verify on our prose tasks specifically (long-form register is not a ppl benchmark); cheap A/B.

---

### 13. Speculative decoding, revisited server-side only, telemetry-gated (refutation-adjacent)
**Sources.** llama.cpp speculative docs with the 2025/26 `--spec-type` family (`draft-simple`, `draft-eagle3`, `draft-mtp`, `ngram-cache/simple/map-k/map-k4v/mod`), https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md · EAGLE-3 (NeurIPS 2025, arXiv 2503.01840; acceptance 0.80-0.88 on Llama/Qwen families) · Apple Silicon analysis, https://github.com/ml-explore/mlx-lm/discussions/890.

**What it is.** llama.cpp's speculative support has been rebuilt since our refutations were measured; it is now a pluggable family including EAGLE-3 heads (a small learned head on the target model, not a separate draft model, so no second KV cache and much higher acceptance) and shared-across-slots n-gram pools, and grammar constraints are applied consistently to draft and target on the server path (unlike the node-llama-cpp silent grammar drop we hit).

**Expected win for us, honestly.** Marked refutation-adjacent, see section 3. Two of our three refutations were engine-specific (node-llama-cpp grammar drop; prompt-lookup on revision-shaped output). EAGLE-3 differs in kind from both. It is not n-gram (so the "outputs aren't copies" failure doesn't apply) and not a separate draft model. The blockers are practical. Trained EAGLE-3 heads must exist for *our exact* Qwen3-1.7B/4B checkpoints (heads exist for larger Qwen3 models; check current availability before planning anything), and decode on Apple Silicon is memory-bound enough that batch verification is nearly free, which is the regime where speculation pays. Only attempt if a head exists; then gate on measured acceptance length ≥ ~2 on our own workload before shipping. Expected value is real but conditional; that is why it ranks 13th.

**Cost/risk.** Head weights are tiny; the risk is a repeat of the 4x-slower experience if acceptance is poor. The `--spec-type ngram-*` modes are one flag to A/B but sit closest to the refuted prompt-lookup; only their shared-pool variant (`ngram-mod`, which learns across slots, so chip-scan phrasing patterns accumulate) plausibly dodges the original failure, and only telemetry can say.

---

### 14. A model judge on top of the deterministic gates (narrow role only)
**Sources.** Prometheus 2 (EMNLP 2024, arXiv 2405.01535, 7B evaluator, 0.6-0.7 Pearson with GPT-4 judgments) · RefineBench feedback-capacity results (arXiv 2511.22173).

**What would a model judge add?** Our gates check *form* (grammar regressions, length, paragraph count). The two judgments they cannot make are "did the revision follow the instruction?" and "is candidate A better prose than B?". The honest reading of the evaluator literature is that 7B is roughly the floor for a *credible* general judge; our 4B is below it and the 1.7B far below. So scope it to the narrowest useful call. 4B pairwise pick between best-of-N survivors that tie on gate score, and 4B yes/no instruction-adherence on custom ops (a classification-shaped call, which small models do far better than scalar quality ratings; constrained output helps here per Tam et al.). Skip Likert scoring entirely. Rank this last among the build items; ship items 1-4 first and only add the judge if gate-tie frequency proves non-trivial.

**Cost/risk.** One extra 4B call on ties; the known risk is judge bias toward its own phrasing style, mitigated by pairwise-with-position-swap.

---

### 15. Watch items (do not build now)
- **Grammar-Aligned Decoding / ASAp** (NeurIPS 2024, arXiv 2405.21047). Fixes GCD distribution distortion properly, but needs iterative resampling machinery absent from llama.cpp. Its *insight* is actionable today. Keep grammars loose (the tuple wire) and move reasoning outside the constrained span (item 5).
- **Jump-forward / compressed-FSM decoding** (SGLang, https://www.lmsys.org/blog/2024-02-05-compressed-fsm/ · XGrammar, arXiv 2411.15100). Skips decoding of grammar-forced tokens, up to 2x on JSON-heavy output. Not in llama.cpp; the compact tuple wire already minimized forced tokens (that was the 139-to-72 win), so remaining upside is small. Revisit if llama.cpp lands it.
- **BoostCD** (2025, arXiv 2506.14901). Combines constrained and unconstrained passes to de-bias extraction output; relevant to chip scan in principle, immature tooling.
- **Speculative cascades** (Google Research 2025, https://research.google/blog/speculative-cascades-a-hybrid-approach-for-smarter-faster-llm-inference/). Token-level merge of item 7 and item 13 if both mature in the stack.

**Explicitly ALREADY IMPLEMENTED, for the record.** Byte-identical per-task system prompts + prefix reuse (the RadixAttention principle, client-side); continuous batching on the sidecar; flash attention + Q8_0 KV; closed-think prefill to stop budget burn; compact GBNF tuple wire (a form of token-minimal constrained decoding); evidence-ladder + claim-verification pass on ask-mode (this IS CRITIC-shaped verify-then-refine with external evidence, the variant the surveys endorse); deterministic acceptance gates (a verifier, per item 4, currently underused as a mere accept/reject).

---

## 2. Design proposal for goal A: classify, provision, retry

### 2.1 The instruction classifier

Three layers, cheapest first, each with an abstain path to the next. Total added latency target < 50ms for layers 1-2.

**Layer 1, rules (free, high precision).** The op picker already tells us proofread vs rewrite vs custom. For custom, run deterministic matchers over the instruction. merge/combine/join + paragraph nouns → MERGE; split/break up → SPLIT; shorten/tighten/condense/trim → CONDENSE; expand/add/lengthen/"more detail" → EXPAND; "add a scene"/"add an action scene"/insert → INSERT; tone/voice/POV/tense words → TONE_SHIFT; a proper noun or character name that resolves against the chip store → +CHARACTER_FOCUS modifier. Bilingual note. If instructions can be Thai, keep layer 1 keyword tables per-locale and lean harder on layer 2 (Qwen3-Embedding is multilingual).

**Layer 2, embeddings (SetFit-style, no prompt, no generation).** Embed the instruction with Qwen3-Embedding-0.6B (already servable by the sidecar, item 6). Train a logistic head (or plain nearest-centroid to start) on a few hundred examples per class, seeded from CoEdIT/IteraTeR instruction phrasings for the meaning-preserving classes plus ~50 hand-written examples per structural class (MERGE/SPLIT/INSERT don't exist in those datasets; they are the novel classes, which is exactly why the gates never learned them). SetFit's core result is that this works from ~8-64 examples per class at accuracy competitive with few-shot LLMs. Accept when top-class margin over runner-up exceeds a threshold tuned on a held-out set; otherwise abstain to layer 3.

**Layer 3, the 1.7B with a tiny grammar (rare path).** Grammar-constrained emit, and per the house rule, reason before label. `{"why": <one sentence, free tail>, "class": <enum>, "targets": {...}}` with the enum declared LAST in the schema so the model commits after stating evidence. Also extract slots (entity names, target paragraph count, explicit length asks like "about half as long"). If layer 3 also abstains (or emits the catch-all), fall to UNKNOWN, which routes exactly like today's behavior. Nothing gets worse than the status quo by construction.

### 2.2 The strategy table

One row per class; the classifier's only job is to pick a row. `sel` = the user's selection treated as one atomic span.

| Class | Batch granularity | Context package | Gate profile | Tier | Decoding |
|---|---|---|---|---|---|
| PROOFREAD | pack paragraphs to char cap (as today) | none | `strict-preserve`: para count exact, len 0.5-1.8x, grammar must-not-regress | 1.7B | near-greedy |
| REWRITE (in-place) | 1 paragraph (as today) | ±1 neighbour para | `strict-preserve` | 1.7B | t 0.7, min-p 0.05, N=2 |
| MERGE | **sel as one unit** (all selected paras in one prompt) | ±1 neighbour | `restructure`: para count == target (default 1), len vs *combined* source 0.4-1.1x, mechanical-only grammar gate | 1.7B | t 0.7 |
| SPLIT | sel as one unit | ±1 neighbour | `restructure`: para count == target (default 2+), len 0.8-1.4x | 1.7B | t 0.7 |
| CONDENSE | sel as one unit | none | `condense`: len 0.3-0.8x, para count ≤ source, mechanical-only | 1.7B | near-greedy |
| EXPAND / CHARACTER_FOCUS | 1 paragraph | ±1 neighbour + top-8 chips for named entities + scene summary | `expand`: len 1.2-4.0x+240, para drift ≤2, mechanical-only | **4B** | t 0.9, min-p 0.08, N=2 |
| INSERT (new scene/beat) | insertion point + both flanking paras | flanking paras + chapter summary + chips for named entities | `insert`: NEW content len window absolute (e.g. 200-1600 chars), flanking paras byte-identical in output, para count = source+1..+4 | **4B**, plan-then-write (2.4) | t 0.9, min-p 0.08 |
| TONE_SHIFT | pack to char cap | 1-2 sample paras of surrounding prose (register anchor) | `strict-preserve` with len 0.6-1.6x | 1.7B, esc. 4B | t 0.8 |
| UNKNOWN | today's custom behavior | none | today's custom gates | 1.7B | today's |

Two principles from the literature are load-bearing here. First, IteraTeR/CoEdIT. Telling a small model *which* edit class it is performing is worth more than model scale within this range, so the class name and its contract go verbatim into the prompt ("Merge the following 3 paragraphs into 1. Preserve every plot fact."). Second, guards provision instead of block (SWE-agent's ACI lesson). The gate profile is chosen *for* the declared intent, so "merge" is no longer a gate violation but a gate *specification* (output must be exactly 1 paragraph). Pre-flight provisioning runs before generation. If the class's context column names entities the batch doesn't carry, fetch chips *now*, not after a failure.

### 2.3 The bounded diagnose-adjust-retry loop

Grounding. Retries are justified only because the feedback is external and reliable (Kamoi; Huang). Every retry must inject *new external information* (a gate diagnosis, new context, or a new model), never a bare "try again" or a self-critique. Cap at 2 retries (3 attempts); Self-Refine's own curves show most gain in the first feedback round, and RefineBench says the 1.7B may not use feedback well at all, hence escalation over repetition.

```
attempt 0: strategy-table row, chosen tier
  gates pass → accept (or rank by gates if N>1, accept best)
  gates fail → diagnose (deterministic, from gate records):
    LEN_LOW / LEN_HIGH   → which direction, by how much
    PARA_COUNT_MISMATCH  → expected k, got m
    GRAMMAR_REGRESSION   → the specific new hard errors (spans)
    CLAIM_UNSUPPORTED    → which claim, from self-review  (ask-mode)
    …plus a classifier check: does the FAILURE SHAPE suggest misrouting?
      (e.g. REWRITE emitted 1 para from 2 → user probably meant MERGE:
       reclassify once, jump to that row's attempt 0; counts as retry 1)

retry 1 (same tier): prompt-level repair + provisioning.
  feed back ONLY the first diagnosis, translated to plain instruction
  with numbers ("came out at 0.24x; make it at least 0.3x of the original"),
  plus whatever context the diagnosis names (entity mentioned but absent
  → chips; continuity claim unsupported → neighbouring scene summary).
  Keep the SWE-agent hygiene: prior failed output is summarized to its
  diagnosis, not replayed in full, and only the first error is retained.

retry 2 (escalate): 4B tier (if not already) + best-of-2 under the same
  gate profile; on a length gate, additionally set an explicit numeric
  target in the prompt. This is the cascade deferral step (item 7).

exhausted → honest surfaced failure:
  keep original text (unchanged floor), but show the DIAGNOSIS, not a shrug:
  "I tried this as a merge. Both attempts lost the detail about <chip>,
   so I kept your text. Want me to merge without shortening, or shorten
   without merging?"  Offer the 1-2 nearest strategy rows as buttons.
  A refusal that names its reason and offers a decomposition is the
  UX version of SWE-agent's informative-error principle.
```

Budget guard. The loop consumes at most ~4 generations worst-case (1 + 1 + 2), only on failures, and never runs when the memory guard is tight (fail honestly at attempt 0's gate instead).

### 2.4 Plan-then-write for INSERT and large EXPAND

For "add an action scene", generate a 3-5 bullet beat plan first (free text, thinking allowed via item 5's lazy grammar; include flanking paragraphs + chips in context), then write the scene from the plan in a second call. Evidence. Agents' Room (ICLR 2025, arXiv 2410.02603) shows planner/writer decomposition wins expert preference for narrative generation; the older Re3/DOC line shows plans specifically rescue *coherence at length*, the exact axis where a 4B will fail unplanned. Small-model caveat. Those results are frontier-model results; the transferable claim is the *decomposition* (each sub-call is shorter and more constrained, which is systematically friendlier to small models), not the absolute quality numbers. The plan is also the cheapest quality gate. A malformed or off-instruction plan fails fast before spending the long generation, and the plan's beats give the self-review pass concrete claims to verify the scene against.

---

## 3. Refutation-aware notes

- **Prompt-lookup / n-gram speculation (refuted, 18% slower).** Item 13's `ngram-simple/-cache/-map-k` are the same mechanism and inherit the refutation; listed only for completeness. `ngram-mod` (shared cross-slot hash pool) differs by learning from *generated outputs across the whole session*, not the current prompt, so repeated chip-scan JSON scaffolding could hit where prompt-lookup missed; still, treat as refuted-until-telemetry-says-otherwise. EAGLE-3 is not n-gram at all (learned head over target activations) and is the only speculative variant on the list with a mechanism-level reason to dodge the failure.
- **Draft-model speculation (refuted, 4x slower + node-llama-cpp drops grammar).** Both documented failures were host-engine-specific. Any retest must be sidecar-only (server applies grammar to draft and target) and head-based (EAGLE-3) rather than separate-draft-model, and is gated on a trained head existing for our exact checkpoints. No re-proposal of the original form.
- **Parallel sequences in node-llama-cpp (refuted, no throughput win).** Best-of-N (item 4) and SC (item 8) deliberately run on the llama-server sidecar, whose continuous batching is the thing we measured winning 2.1-2.4x. They also seek *quality* per request, not throughput, so the refuted claim isn't being re-made.
- **Thinking on grammar-constrained runs (refuted, grammar masks think tokens).** Item 5 is precisely the two-phase design the refutation note said would be required, implemented with `grammar_lazy` + a `</think>` trigger so the constraint physically cannot mask the think phase.
- **1-char JSON keys (refuted, degraded prose register).** Two proposals interact. The classifier grammar (2.1 layer 3) emits labels, not prose, so compact keys are safe there. For anything emitting prose (INSERT/EXPAND, plan-then-write), the recommendation is the opposite of minification. Keep prose emission *outside* JSON entirely (plain text between sentinel markers), consistent with both the register finding and Tam et al.'s format-pressure result.

---

## 4. Sources

**Edit intent / writing assistants**
- CoEdIT, EMNLP 2023 Findings · https://arxiv.org/abs/2305.09857 · https://github.com/vipulraheja/coedit
- IteraTeR, ACL 2022 · https://arxiv.org/abs/2203.03802 · https://aclanthology.org/2022.acl-long.250/
- DELIteraTeR, Grammarly Engineering · https://www.grammarly.com/blog/engineering/learning-where-to-edit/
- PEER: A Collaborative Language Model, 2022 · https://arxiv.org/abs/2208.11663

**Self-correction / iteration discipline**
- Kamoi et al., TACL 2024 · https://arxiv.org/abs/2406.01297
- Huang et al., ICLR 2024 · https://arxiv.org/abs/2310.01798
- RefineBench, 2025 · https://arxiv.org/pdf/2511.22173
- Self-Refine · https://arxiv.org/abs/2303.17651 · Reflexion · https://arxiv.org/abs/2303.11366 · CRITIC · https://arxiv.org/abs/2305.11738
- SWE-agent (ACI design), NeurIPS 2024 · https://arxiv.org/pdf/2405.15793v1

**Test-time compute / verification / cascades**
- Snell et al., 2024 · https://arxiv.org/abs/2408.03314
- HF, Scaling test-time compute (1B/3B results) · https://huggingfaceh4-blogpost-scaling-test-time-compute.hf.space/
- Self-Consistency · https://arxiv.org/abs/2203.11171 · Adaptive-Consistency · https://arxiv.org/pdf/2305.11860
- Self-Consistency Is Losing Its Edge, 2025 · https://arxiv.org/pdf/2511.00751
- GEC QE reranking · https://aclanthology.org/D18-1274/ · GEC system combination via QE · https://arxiv.org/pdf/2310.14947
- FrugalGPT · https://arxiv.org/abs/2305.05176 · GATEKEEPER, 2025 · https://arxiv.org/pdf/2502.19335 · Early-abstention cascades · https://arxiv.org/pdf/2502.09054
- Prometheus 2, EMNLP 2024 · https://arxiv.org/abs/2405.01535
- SetFit · https://arxiv.org/abs/2209.11055

**Constrained generation**
- Let Me Speak Freely?, EMNLP 2024 Industry · https://arxiv.org/abs/2408.02442
- Say What You Mean (dottxt rebuttal) · https://blog.dottxt.ai/say-what-you-mean.html
- JSONSchemaBench, 2025 · https://arxiv.org/html/2501.10868v1
- Grammar-Aligned Decoding, NeurIPS 2024 · https://arxiv.org/abs/2405.21047 · https://github.com/ebmoon/transformers-GAD
- Structured Output Collapses Answer Diversity, 2026 · https://arxiv.org/html/2607.18476
- SGLang compressed FSM · https://www.lmsys.org/blog/2024-02-05-compressed-fsm/ · SGLang paper · https://arxiv.org/abs/2312.07104 · XGrammar · https://arxiv.org/pdf/2411.15100
- BoostCD, 2025 · https://arxiv.org/pdf/2506.14901

**Narrative context / retrieval**
- RAPTOR, ICLR 2024 · https://arxiv.org/abs/2401.18059 · https://github.com/parthsarthi03/raptor
- Storyline Trees, 2026 · https://arxiv.org/pdf/2606.20900
- CHIRON, EMNLP 2024 Findings · https://arxiv.org/abs/2406.10190
- Agents' Room, ICLR 2025 · https://arxiv.org/abs/2410.02603
- Qwen3-Embedding-0.6B GGUF · https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF

**Engine / systems (llama.cpp family)**
- llama-server README (flags, slots, cache, endpoints) · https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Host-memory prompt cache PR #16391 · https://github.com/ggml-org/llama.cpp/pull/16391 · field notes · https://jessequinn.info/blog/llama-cpp-cache-ram-prompt-caching
- Speculative docs (`--spec-type` family incl. eagle3/mtp/ngram-mod) · https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md
- Lazy grammars · https://github.com/ggml-org/llama.cpp/discussions/12110
- EAGLE-3 · https://arxiv.org/abs/2503.01840 · Apple Silicon analysis · https://github.com/ml-explore/mlx-lm/discussions/890
- KV quant measurements · https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/ · asymmetric K/V · https://github.com/ggml-org/llama.cpp/discussions/23470
- llama-swap · https://github.com/mostlygeek/llama-swap
- Speculative cascades, Google Research 2025 · https://research.google/blog/speculative-cascades-a-hybrid-approach-for-smarter-faster-llm-inference/
- Sarathi-Serve (chunked prefill) · https://arxiv.org/abs/2403.02310
