# Adaptive thinking: when should the local model reason, and how much?

(Deep-research pass, 2026-08-08. House punctuation applied. Implementation notes: the two-phase freeText think pass, decision ladder and budgets in src/lib/think.ts were built against this report; measured deviations are recorded in code comments and plans/harness-upgrade-spec.md.)

## Zero-th finding, about your actual models

**Qwen3-4B-Thinking-2507 is not a hybrid model.** The model card states "This model supports only thinking mode" and the chat template auto-emits `<think>` ([HF card](https://huggingface.co/Qwen/Qwen3-4B-Thinking-2507)). The `/think` `/no_think` switch exists only in the original Qwen3 line (your 1.7B). The 2507 split into Instruct-only and Thinking-only happened because hybrid fusion cost quality. Consequences for you, in order of confidence, are that (1) "no thinking" tiers should run on the 1.7B (or a 4B-Instruct-2507 if you add it), not by prefilling an empty think block into the Thinking-2507 model, which is out of distribution for it; (2) "less thinking" on the 4B is done by capping the think budget, which is well supported (below); (3) llama.cpp now supports this natively, with `--reasoning-budget 0` to disable thinking for hybrids and a newer budget sampler with `--reasoning-budget-message` and per-request `thinking_budget_tokens` ([discussion #21445](https://github.com/ggml-org/llama.cpp/discussions/21445), [PR #25961](https://github.com/ggml-org/llama.cpp/pull/25961/files)). The Qwen3 report's own interrupt mechanism inserts, at budget exhaustion, the exact string "Considering the limited time by the user, I have to give the solution based on the thinking directly now.\n</think>" and notes this ability "is not explicitly trained but emerges naturally" from thinking-mode fusion ([Qwen3 TR, 2505.09388](https://arxiv.org/abs/2505.09388)).

Also relevant, hybrid no-think modes leak. [Demystifying Hybrid Thinking (2510.12680)](https://arxiv.org/abs/2510.12680) measures reasoning behaviors leaking into no-think outputs (in their setup, fixable from 1,085 to 585 output tokens, "wait" occurrences 5,917 to 522, only with a better training recipe). Expect your 1.7B `/no_think` to occasionally ramble; cap `max_tokens` on no-think calls.

---

## (a) Ranked decision techniques

Ranked by practicality for a local, single-user app with ≤4B models, weighting small-model evidence. "Signal" = what decides think vs no-think.

**1. Client-side difficulty gating + hard budget cap (heuristics decide mode, budget forcing enforces it).**
Sources: [s1 (2501.19393)](https://arxiv.org/abs/2501.19393); [NoThinking (2504.09858)](https://arxiv.org/abs/2504.09858); [Qwen3 TR (2505.09388)](https://arxiv.org/abs/2505.09388); [HRBench (2605.28398)](https://arxiv.org/html/2605.28398v1). Signal: prompt features + a fixed budget ladder. Evidence: s1's ablation is the cleanest, budget forcing gives 100% control with positive scaling slope (56.7% AIME24) while token-conditional prompting alone gives 40% control and a negative slope, i.e. models cannot count their own tokens, you must enforce the cap in the decoder. NoThinking shows truncation-plus-forced-answer ("Final Answer:" at the limit, closing `</think>` if inside) preserves quality; on R1-Distill-Qwen (32B main, 7B/14B replicated) NoThinking beats budget-matched Thinking below roughly 3,000 tokens. HRBench (Qwen3.5-2B to 1.1T; MATH500, AIME25, GPQA, LiveCodeBench) finds the "prompt/self-selection" strategy family Pareto-optimal (on 9B, +accuracy with 24% fewer tokens; external routers save less; speculative escalation costs +29.6% tokens). Verdict: **use this. Zero extra models, directly supported by llama.cpp.**

**2. No-think first, escalate on verifier/gate failure (cascade, "speculative" family).**
Sources: [HRBench](https://arxiv.org/html/2605.28398v1) (Spec strategy); [NoThinking](https://arxiv.org/abs/2504.09858) (parallel no-think + verifier selection, up to 7–9x latency reduction when a verifier exists). Signal: first-attempt failure against deterministic checks. Evidence: HRBench finds speculative escalation wins specifically on code, where "try-then-verify" is possible, and its failure mode is confidently wrong fast answers when no verifier exists. Verdict: **ideal for your rewrite surface, which already has deterministic gates. Do not use it as the only mechanism on free-form Q&A where nothing can catch a confident wrong answer.**

**3. Answer-confidence / entropy of the cheap attempt as escalation or early-exit signal.**
Sources: [DEER (2504.15895)](https://arxiv.org/abs/2504.15895), training-free early exit at reasoning transition points ("Wait") by inducing a trial answer and exiting when its confidence clears a threshold, 19–80% fewer tokens with +0.3–5.0% accuracy across 11 models including small distills; [Dynasor/Certaindex (2412.20993)](https://arxiv.org/abs/2412.20993), probe-in-the-middle every 32–128 tokens, ~50% token cuts without accuracy loss ([blog](https://haoailab.com/blogs/dynasor-cot/)); NoThinking's "self-certainty" (KL of token distribution from uniform) + Borda voting as verifier-free selection; the adaptivity survey ([2511.10788](https://arxiv.org/html/2511.10788)) catalogs entropy halting and answer-convergence as the main training-free signals. Signal: model logprobs, free from llama.cpp (`logprobs`/`n_probs`). Evidence quality on small models is decent (DEER includes 1.5B–7B distills). Verdict: **practical as a cheap escalation trigger (mean answer logprob below threshold on the no-think answer → rerun with thinking). Mid-stream probing (DEER/Dynasor proper) is more orchestration than a single-user app needs.**

**4. Prompted self-selection ("decide yourself whether to think").**
Sources: [When Thinking Fails (2505.11423)](https://arxiv.org/abs/2505.11423) self-selective reasoning; HRBench PT family. Evidence: self-selection improved 10/14 models on IFEval and was best on ComplexBench for several, but has high recall / low precision, models choose to think too often. On 2B-class models HRBench found all strategies roughly equivalent. Verdict: **usable as a tiebreaker inside your prompt, not as the primary router; small models over-elect thinking.**

**5. Small trained router (embedding MLP or classifier).**
Sources: [ThinkSwitcher (2505.14183)](https://arxiv.org/abs/2505.14183), MLP on the LRM's own query embedding predicting pass rates of both modes (labels from k=8 self-samples per mode; choose long CoT if predicted gap ≥ τ = 0.03–0.05), 20–30% token cut with <2% accuracy loss on 1.5B/7B/14B, router cost <0.01% of decode FLOPs; classifier-selective reasoning in [When Thinking Fails](https://arxiv.org/abs/2505.11423), best overall mitigation on about half the models; [codelion's AutoThink](https://github.com/codelion/optillm/tree/main/optillm/autothink) ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5253327)), an off-the-shelf HIGH/LOW complexity classifier plus budget allocation and steering vectors, reporting +9.3 points GPQA-Diamond with 55% fewer tokens on R1-Distill-1.5B (self-published evidence). Signal: learned difficulty. Verdict: **best cost/quality if heuristics prove insufficient, but it is an extra model plus label collection. Reasonable v2 once you have telemetry; not needed on day one.**

**6. Hidden-state capability probes.**
Source: [Self-Route (2505.20664)](https://arxiv.org/abs/2505.20664), a short pre-inference CoT probe, linear classifier on hidden states (best at 60–80% depth), 30–55% token cuts, <2% accuracy loss, works for Qwen3-8B internal think/no_think routing, but needed a difficulty-dense training set (Gradient-10K; a GSM8K-only router lost ~11%). Verdict: **strong paper, impractical for you, llama.cpp doesn't expose hidden states and the router is data-hungry.**

**7. RL-trained adaptive checkpoints.**
Sources: [AdaptThink (2505.13417)](https://arxiv.org/abs/2505.13417) (EMNLP 2025), constrained RL objective + importance sampling; on 1.5B, average length −53% with +2.4% accuracy, learned no-think rates track difficulty (~87% no-think on GSM8K vs single digits on AIME), decision emitted as literally the first token (`</think>` = skip); [Thinkless (2505.13379)](https://arxiv.org/abs/2505.13379) (NeurIPS 2025), `<short>`/`<think>` control token with decoupled GRPO, 50–90% less long-chain usage on 1.5B; [AutoThink multi-stage RL (2505.10832)](https://arxiv.org/abs/2505.10832), ellipsis prompt reveals latent mode controllability, 51.7% accuracy at half tokens on 1.5B. Verdict: **the best published small-model results in the genre, and proof the difficulty-adaptive policy is learnable at 1.5B, but they are math-RL'd checkpoints, not your Qwen3-2507 stack. Useful as evidence, not as components.**

**8. Prompted budget self-estimation.**
Source: [TALE (2412.18547)](https://arxiv.org/abs/2412.18547) (ACL Findings 2025), ask the model to estimate a token budget, then include it in the prompt; −67% tokens, −59% cost at near-parity accuracy, but mostly on API-scale models, and budgets are only softly followed (which is why s1-style enforcement matters). Verdict: **weak for ≤8B; skip, use a fixed ladder instead.**

**Budget-size evidence.** [Qwen3 TR](https://arxiv.org/abs/2505.09388) reports consistent, smooth gains with larger budgets. A Qwen3-specific study across 1.7B–235B ([2508.12140](https://arxiv.org/abs/2508.12140)) finds a logarithmic accuracy-vs-budget curve with three regimes (0–256 tokens, 256–512, >512), optimal budget growing with domain difficulty, and, notably, **small models gaining the most from thinking (15–20% vs 5–10% for large ones)**. s1 finds extension by suppressing `</think>` and appending "Wait" works but flattens by ~6 iterations and then loops. [ThinkLess (2505.15684)](https://arxiv.org/abs/2505.15684) shows even inserting the terminator very early keeps quality if you add a short answer-structuring instruction after `</think>`, because answer tokens attend mostly to the terminator region, not the whole trace.

## The constrained-output thread (your question 4)

- [Tam et al., EMNLP 2024 Industry (2408.02442)](https://arxiv.org/abs/2408.02442) measured large reasoning drops under JSON-mode (GSM8K, GPT-3.5 −27 pts, Claude-3-Haiku −63, LLaMA-3-8B −26; Last Letter −31 to −42) and showed the two-stage **NL-to-Format** mitigation (answer free-form, then convert) "achieves nearly identical performance" to free-form across most models, with occasional conversion errors. Parsing was not the cause (LLaMA had a 38-pt gap at 0.15% parse errors). Also, key order matters, answer-before-reason silently converts CoT into direct answering.
- [dottxt's rebuttal](https://blog.dottxt.ai/say-what-you-mean.html) showed much of Tam's gap disappears with matched prompts and proper schemas (their re-runs, structured ≥ unstructured, e.g. GSM8K 78% vs 77%), and stresses giving the model reasoning space inside the schema. Vendor blog, but methodologically sound. The honest synthesis is that naive constrained decoding genuinely hurts reasoning-heavy outputs, and nearly all of the loss is recoverable by either schema design (reasoning field first) or two-phase generation.
- [CRANE (2502.09061)](https://arxiv.org/abs/2502.09061) supplies the theory and the small-model evidence. Restrictive grammars collapse the model to a constant number of effective autoregressive steps (a TC⁰ vs NL argument); interleaving unconstrained reasoning with delimiter-scoped constrained answering restores expressivity. Gains survive at your scale, Qwen2.5-1.5B 31% vs 26% (unconstrained CoT) vs 22% (fully constrained) on GSM-Symbolic; Llama-3.1-8B 46.3% vs 39.4% constrained on FOLIO, with negligible token overhead.
- So for your grammar-gated rewrites, the published answer is yes, **think unconstrained first, answer constrained second**, and the gain survives at 1.5B–8B. Your existing rule "grammar runs never think" is exactly what CRANE formalizes.

---

## (b) Recommended decision policy

Principles it encodes, PT-style self-gating is Pareto-optimal but small models over-think, so the client owns the decision; budgets are enforced, never requested; escalation is triggered by verifiable failure or low confidence, never by vibes.

### Surface 1, manuscript Q&A (free-form, interactive)

Compute a cheap difficulty score from signals you already have (no extra models):
- **length/structure**, question tokens > ~40, multiple sentences, multiple question marks
- **multi-entity**, ≥3 distinct character/place names resolved against your extraction DB (you already maintain one)
- **multi-hop/causal shape**, presence of why/how/what-if/compare, causal-temporal connectives (because, therefore, leads to, before/after, foreshadow), cross-chapter scope words (arc, throughout, earlier vs later)
- **task class**, lookup (who/where/when/what color) vs synthesis (theme, motivation, consistency check, "does X contradict Y")

Tiers (thinking budget = enforced via llama.cpp budget sampler / interrupt string, generation settings per Qwen card, temp 0.6, top-p 0.95):

| Tier | Trigger | Model + mode | Think budget |
|---|---|---|---|
| 0 | lookup class, single entity, short | 1.7B `/no_think` (or your batch no-think path) | 0 |
| 1 | one signal fires | 4B-Thinking-2507, capped | 512 |
| 2 | ≥2 signals, or causal/multi-hop class | 4B-Thinking-2507, capped | 1,024–2,048 |
| 3 | explicit user request ("think hard"), or Tier-2 retry | 4B-Thinking-2507 | 4,096 cap |

Escalation rules. Tier 0 answers get logprobs; if mean answer-token logprob is in your bottom quintile (calibrate on ~50 logged answers), or the answer contradicts a retrieved fact, silently rerun at Tier 1–2. One escalation max, then show the answer with the model's uncertainty. Rationale, DEER/Dynasor show trial-answer confidence is a valid stop/continue signal; HRBench warns confidence alone produces confident-wrong fast answers, hence the single-step, verifier-preferred escalation.

Latency sanity, at ~40–70 tok/s for a 4B on consumer hardware, 512 think tokens ≈ 8–13 s, 2,048 ≈ 30–50 s, 4,096 ≈ 1–2 min. Tier 3 should be visibly opt-in.

### Surface 2, instruction-driven rewrite with deterministic gates + bounded retry

Rewrites are instruction-following, not math. The literature says default to **no thinking** here (see cautions).

1. **Attempt 1, no think.** 1.7B `/no_think` (or 4B-Instruct if you add it). If output is grammar-constrained, the grammar covers only the answer; any schema places a short free-text `notes`/`reason` field before the payload (Tam key-order finding).
2. **Gates run.** Pass → done.
3. **Attempt 2, think small, two-phase.** On gate failure, one unconstrained pass on 4B-Thinking-2507, budget **512**, prompt = instruction + failed output + verbatim gate errors, asking for a revision plan; then a second, grammar-constrained pass that conditions on that plan and emits only the payload (CRANE pattern, your existing two-call setup).
4. **Attempt 3, think bigger.** Still failing → same loop once more at budget **1,536**. Then stop and surface the best-scoring attempt with its gate report. More retries are not supported by anything in the literature, and s1 shows extension saturates.

Never send `/no_think` or an empty-think prefill to the 4B-Thinking-2507; route no-think work to the 1.7B.

---

## (c) Refutations and cautions

- **Overthinking on easy inputs is real and measured.** On trivial problems the first solution round is correct in >92% of cases while consuming ~39% of the trace, and QwQ generated more solution rounds on easier sets (3.6 on ASDIV vs 2.8 on MATH500) ([Do NOT Think That Much, 2412.21187](https://arxiv.org/abs/2412.21187)). AdaptThink's preliminary study shows no-think matches thinking on MATH levels 1–3 at a fraction of the tokens. Meta's [OptimalThinkingBench (2508.13141)](https://arxiv.org/abs/2508.13141) exists specifically because thinking models burn hundreds of tokens on trivial queries. Don't think on lookups.
- **Thinking actively hurts instruction adherence.** 13/14 models dropped on IFEval with CoT, all 14 on ComplexBench; Llama-3-8B fell 75.2→59.0, Qwen2.5-7B 60.2→52.6 on ComplexBench ([When Thinking Fails](https://arxiv.org/abs/2505.11423)). Mechanism, attention to constraint tokens drops during the answer phase, and the drop predicts failures; reasoning inserts "well-intentioned" extra content that violates constraints. This is the single most relevant result for your rewrite surface, whose failure mode ("model added commentary", "exceeded length", "changed something it was told to keep") is exactly what they document. Reasoning helped only formatting compliance and lexical precision. Reasoning length did not correlate with degradation, so a small budget doesn't rescue it, mode choice does.
- **Constrained decoding over the whole generation strangles reasoning** (Tam; CRANE's expressivity proof). Recoverable via two-phase or reasoning-field-first schemas; on small models CRANE puts the recovery at +5 to +9 points.
- **Truncation is safe only with forced answering.** Cutting the think stream must close `</think>` and force the answer (s1, NoThinking, ThinkLess all do this). Merely asking for N tokens fails (s1's token-conditional control, 40% control, negative slope). Extension via "Wait" flattens by ~6x and can loop.
- **Confidence signals on small models are noisy.** HRBench's speculative family loses tokens to confidently wrong fast answers; NoThinking's confidence-highest selection was its weakest selector (voting variants beat it). Use confidence only paired with something deterministic (your gates, retrieval contradiction checks).
- **Routers miscalibrate off-distribution.** Self-Route needed difficulty-dense training data; HRBench's router family misjudged GPQA-style questions. A hand-tuned heuristic you can inspect beats a small learned router you can't, until you have real telemetry.
- **Hybrid no-think leaks reasoning** ([2510.12680](https://arxiv.org/abs/2510.12680)), so cap no-think `max_tokens` and strip stray "wait, actually" prefixes.
- **Domain gap, stated honestly.** Essentially all of this evidence is math/code/QA/instruction benchmarks. Nothing published measures think-budget effects on creative rewriting quality. The transferable parts are the instruction-following results (surface 2) and the difficulty-gated budget ladder (surface 1); the specific thresholds above are calibrated guesses you should tune against your own gate-pass and user-correction telemetry.

Sources: all inline above; the three umbrella surveys are [Stop Overthinking (TMLR 2025)](https://github.com/Eclipsess/Awesome-Efficient-Reasoning-LLMs), [Harnessing the Reasoning Economy (2503.24377)](https://arxiv.org/abs/2503.24377), and [From Efficiency to Adaptivity (2511.10788)](https://arxiv.org/html/2511.10788), whose main deployment warning, keep the meta-decision cost far below the tokens it saves, is satisfied by the client-side heuristic router recommended here.