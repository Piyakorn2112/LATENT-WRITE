/**
 * verify-assistant-lanes.ts — the scheduling contract between the writer's
 * work and the app's own.
 *
 * ★★ THIS IS A CONTRACT, SO IT GETS A DETERMINISTIC TEST, NOT A STOPWATCH.
 *    "An ask does not queue behind three chapter summaries" is a statement
 *    about ordering, and ordering can be asserted exactly. A wall-clock
 *    measurement of the same thing would pass or fail depending on how long
 *    the model happened to take, which is the wrong evidence for the claim
 *    and the wrong thing to regress against.
 *
 * The bridge is a stub whose runs never settle until this file says so, which
 * is what makes "was it dispatched" observable at all — against a real engine
 * the answer arrives too fast to distinguish "started immediately" from
 * "started after the queue drained".
 *
 * What is under test (src/lib/assistant-client.ts):
 *
 *   1. background work runs, up to its own concurrency, when nothing else wants
 *      the engine
 *   2. an interactive arrival is dispatched IMMEDIATELY, never behind
 *      background work
 *   3. in-flight background work is cancelled to free the slot
 *   4. a cancelled-by-preemption job reports `preempted`, not `cancelled` —
 *      App.tsx counts `cancelled` as a strike and three strikes silence a
 *      chapter for the session
 *   5. no background job starts while anything interactive is queued or running
 *   6. background resumes once the interactive lane drains
 *   7. cancelWhere reaches the background lane too
 *
 *   ./node_modules/.bin/tsx scripts/verify-assistant-lanes.ts
 */
interface StubRun {
  requestId: string;
  task: string;
  settle: (result: unknown) => void;
  cancelled: boolean;
}

const started: StubRun[] = [];
const startOrder: string[] = [];

const stubApi = {
  isElectron: true,
  assistantStatus: async () => ({ model: { id: "stub-model", present: true }, state: "ready" }),
  assistantRun: (opts: { requestId: string; task: string }) =>
    new Promise((resolve) => {
      const entry: StubRun = {
        requestId: opts.requestId,
        task: opts.task,
        cancelled: false,
        settle: resolve,
      };
      started.push(entry);
      startOrder.push(opts.task);
    }),
  assistantCancel: async ({ requestId }: { requestId: string }) => {
    const entry = started.find((s) => s.requestId === requestId);
    // The runtime acks an abort by settling the run as cancelled — the client
    // must translate that, not the caller.
    if (entry && !entry.cancelled) {
      entry.cancelled = true;
      entry.settle({ ok: false, cancelled: true });
    }
    return { ok: true };
  },
  onAssistantProgress: () => () => {},
};

(globalThis as unknown as { window: unknown }).window = { electronAPI: stubApi };

const { assistantRunJSON, cancelWhere, assistantPending } = await import("../src/lib/assistant-client");

let pass = 0;
let fail = 0;
const gate = (ok: boolean, label: string, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};

/** Let the client's promise chains run; nothing here is timer-driven. */
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const req = (task: string, lane?: "batch" | "background") => ({
  task, lane, systemPrompt: "s", userText: "u",
  schema: { type: "object", properties: {} } as Record<string, unknown>,
});

const finish = (task: string) => {
  const entry = started.find((s) => s.task === task && !s.cancelled);
  if (!entry) throw new Error(`nothing in flight for ${task}`);
  entry.cancelled = true;
  entry.settle({ ok: true, json: { done: true } });
};

console.log(`\n${"═".repeat(78)}`);
console.log("ASSISTANT LANES — the writer's work never queues behind the app's own");
console.log(`${"═".repeat(78)}\n`);

// ── 1. background fills its own pool, and only its own ──────────────────────
const bg = [1, 2, 3, 4].map((i) => assistantRunJSON(req(`chips-${i}`, "background")));
await tick();
gate(
  startOrder.length === 2,
  `background runs ${startOrder.length} at once, not all four (BACKGROUND_CONCURRENCY)`,
  `dispatched: ${startOrder.join(", ")}`,
);

// ── 2 + 3. an ask arrives ───────────────────────────────────────────────────
const before = startOrder.length;
const ask = assistantRunJSON(req("max-ask", "batch"));
await tick();
gate(
  startOrder[before] === "max-ask",
  "the ask is dispatched immediately, ahead of every queued chapter",
  `order: ${startOrder.join(" → ")}`,
);
gate(
  started.filter((s) => s.task.startsWith("chips-") && s.cancelled).length === 2,
  "both in-flight background runs were cancelled to hand back their slots",
);

// ── 4. the reason a caller sees ─────────────────────────────────────────────
const bgResults = await Promise.all([bg[0], bg[1]]);
gate(
  bgResults.every((r) => !r.ok && r.reason === "preempted"),
  "a reclaimed slot reports `preempted`, not `cancelled`",
  `reasons: ${bgResults.map((r) => (r.ok ? "ok" : r.reason)).join(", ")}`,
);

// ── 5. nothing background starts while the ask is out ───────────────────────
await tick();
const duringAsk = startOrder.length;
gate(
  startOrder.slice(before).every((t) => !t.startsWith("chips-")),
  "no background job starts while an interactive request is in flight",
  `since the ask: ${startOrder.slice(before).join(", ")}`,
);
const pendingDuring = assistantPending();
gate(
  pendingDuring.bgInFlight === 0 && pendingDuring.bgQueued === 2,
  `the two unstarted chapters are still queued, not lost (queued ${pendingDuring.bgQueued}, in flight ${pendingDuring.bgInFlight})`,
);

// ── 6. and resume when it finishes ──────────────────────────────────────────
finish("max-ask");
const askResult = await ask;
await tick();
gate(askResult.ok, "the ask itself succeeded");
gate(
  startOrder.length > duringAsk && startOrder.slice(duringAsk).some((t) => t.startsWith("chips-")),
  "background resumes once the interactive lane drains",
  `after the ask: ${startOrder.slice(duringAsk).join(", ")}`,
);

// ── 7. cancelWhere reaches the background lane ──────────────────────────────
const cancelled = cancelWhere(({ task }) => task.startsWith("chips-"));
gate(cancelled > 0, `cancelWhere reaches background work (${cancelled} affected)`);
await Promise.all(bg.map((p) => p.catch(() => null)));

// ── the negative control ────────────────────────────────────────────────────
//
// ★ A GATE THAT CANNOT FAIL IS NOT A GATE. If "batch" and "background" were
//   the same pool — the state this change exists to leave behind — the ask
//   above would have been dispatched fourth rather than first. Assert that the
//   arrangement being tested is actually distinguishable from the old one.
started.length = 0;
startOrder.length = 0;
const sameLane = [1, 2, 3, 4].map((i) => assistantRunJSON(req(`old-${i}`, "batch")));
await tick();
const askOld = assistantRunJSON(req("old-ask", "batch"));
await tick();
gate(
  startOrder.indexOf("old-ask") === -1,
  "control: in ONE shared pool the same ask is NOT dispatched — which is the behaviour being replaced",
  `order: ${startOrder.join(" → ")}`,
);
cancelWhere(({ task }) => task.startsWith("old-"));
for (const s of started) if (!s.cancelled) { s.cancelled = true; s.settle({ ok: false, cancelled: true }); }
await Promise.all([...sameLane, askOld].map((p) => p.catch(() => null)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
