/**
 * test-assistant-lanes.ts — the renderer's scheduler, with a fake runtime.
 *
 * No model, no Electron. `window.electronAPI` is stubbed with a runtime whose
 * requests finish when this file says so, which is the only way to assert
 * ORDERING and PREEMPTION rather than timing.
 *
 * What is under test is the split introduced when the timeline stutter was
 * measured: every caller used to share one FIFO pool, so an ask arriving while
 * the chip tick held all three slots queued behind up to three chapter-sized
 * requests — including the ask popover's own prewarm, whose entire purpose is
 * to be ready before the writer clicks.
 *
 * Gates:
 *   1. background work runs, up to its own concurrency, when nothing else does
 *   2. an interactive arrival is dispatched IMMEDIATELY, not behind background
 *   3. …and reclaims the slots: in-flight background work is cancelled
 *   4. a reclaimed background job reports `preempted`, never `cancelled` —
 *      the chip tick counts `cancelled` as a strike and three strikes silence
 *      a chapter for the session
 *   5. no NEW background work starts while anything interactive is pending
 *   6. background work resumes once the interactive lane drains
 *   7. interactive concurrency is unchanged (3), so the dossier's three
 *      independent field calls still ride together
 *   8. the wire says "batch" for both — the priority is a renderer decision
 *   9. cancelWhere reaches the background lane, queued and in flight
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-assistant-lanes.ts
 */

// ── the fake runtime, installed before the module under test is imported ────
interface Pending {
  requestId: string;
  task: string;
  resolve: (v: unknown) => void;
  cancelled: boolean;
  lane?: string;
}
const live = new Map<string, Pending>();
const started: string[] = [];
const wireLanes: Array<string | undefined> = [];

const api = {
  isElectron: true,
  assistantStatus: async () => ({ model: { id: "fake-model", present: true }, state: "ready" }),
  onAssistantProgress: () => () => {},
  assistantCancel: async ({ requestId }: { requestId: string }) => {
    const p = live.get(requestId);
    if (p) {
      p.cancelled = true;
      live.delete(requestId);
      p.resolve({ ok: false, cancelled: true, requestId });
    }
    return { ok: true };
  },
  assistantRun: (req: { requestId: string; task: string; lane?: string }) => {
    started.push(req.task);
    wireLanes.push(req.lane);
    return new Promise((resolve) => {
      live.set(req.requestId, { requestId: req.requestId, task: req.task, resolve, cancelled: false, lane: req.lane });
    });
  },
};
(globalThis as unknown as { window: unknown }).window = { electronAPI: api };

const { assistantRunJSON, assistantPending, cancelWhere } = await import("../src/lib/assistant-client");

// ── harness ─────────────────────────────────────────────────────────────────
let failures = 0;
const gate = (ok: boolean, label: string, detail = "") => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};
/** Let the client's promise chain settle. Two macrotasks covers the awaits
 *  inside execute() (assistantModelId is itself async on the first call). */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const finish = (task: string) => {
  for (const [id, p] of live) {
    if (p.task !== task) continue;
    live.delete(id);
    p.resolve({ ok: true, json: { done: task }, requestId: id });
    return true;
  }
  return false;
};
const inFlightTasks = () => [...live.values()].map((p) => p.task).sort();

const req = (task: string, lane?: "batch" | "background") => ({
  task, lane, systemPrompt: "s", userText: "u", schema: { type: "object" as const },
});

console.log("\n── the background lane ─────────────────────────────────────────\n");

// 1 — background runs on its own, capped at its own concurrency.
const bg = [1, 2, 3, 4].map((n) => assistantRunJSON(req(`bg-${n}`, "background")));
await settle();
gate(
  inFlightTasks().join(",") === "bg-1,bg-2",
  "background work runs two at a time and queues the rest",
  `in flight: ${inFlightTasks().join(",") || "none"}`,
);
gate(assistantPending().bgQueued === 2, `…with the other two queued (${assistantPending().bgQueued})`);

// 2 + 3 — an ask arrives.
const ask = assistantRunJSON(req("max-ask", "batch"));
await settle();
gate(
  inFlightTasks().includes("max-ask"),
  "an interactive arrival is in flight immediately, not queued behind background work",
  `in flight: ${inFlightTasks().join(",") || "none"}`,
);
gate(
  !inFlightTasks().some((t) => t.startsWith("bg-")),
  "…and the background slots it needed were reclaimed",
  `in flight: ${inFlightTasks().join(",")}`,
);

// 4 — the reclaimed jobs report preemption, which is not a failure.
const first = await bg[0];
gate(
  !first.ok && first.reason === "preempted",
  "a reclaimed background job reports `preempted`",
  `got ${JSON.stringify(first)}`,
);
gate(
  !(first as { reason: string }).reason.includes("cancelled"),
  "★ never `cancelled` — the chip tick converts three of those into a session-long skip",
);

// 5 — nothing new starts while the writer is waiting.
await settle();
gate(
  !inFlightTasks().some((t) => t.startsWith("bg-")),
  "no new background work starts while an interactive request is pending",
  `in flight: ${inFlightTasks().join(",")}`,
);

// 7 — interactive concurrency is still three.
const ask2 = assistantRunJSON(req("writing-tool", "batch"));
const ask3 = assistantRunJSON(req("character-dossier", "batch"));
const ask4 = assistantRunJSON(req("character-dossier", "batch"));
await settle();
gate(
  assistantPending().batchInFlight === 3,
  `interactive concurrency is unchanged at 3 (${assistantPending().batchInFlight} in flight)`,
);
gate(assistantPending().batchQueued === 1, `…and the fourth waits its turn (${assistantPending().batchQueued} queued)`);

// 8 — one word on the wire.
gate(
  wireLanes.every((l) => l === "batch"),
  "every laned request says \"batch\" on the wire; the priority never leaves the renderer",
  `saw ${JSON.stringify([...new Set(wireLanes)])}`,
);

// 6 — drain the interactive lane; background resumes.
finish("max-ask"); finish("writing-tool"); finish("character-dossier"); finish("character-dossier");
await Promise.allSettled([ask, ask2, ask3, ask4]);
await settle();
gate(
  inFlightTasks().filter((t) => t.startsWith("bg-")).length === 2,
  "background work resumes once the interactive lane drains",
  `in flight: ${inFlightTasks().join(",") || "none"}`,
);

// 9 — cancellation reaches the new lane.
console.log("\n── cancellation ────────────────────────────────────────────────\n");
const before = assistantPending();
const hit = cancelWhere(({ task }) => task.startsWith("bg-"));
gate(hit >= before.bgQueued + before.bgInFlight,
  `cancelWhere reaches queued and in-flight background jobs (${hit} affected)`);
await settle();
gate(assistantPending().bgQueued === 0, "…the background queue is empty afterwards");
await Promise.allSettled(bg);

console.log(`\n  ${started.length} requests reached the runtime\n`);
console.log(failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
