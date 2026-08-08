/**
 * verify-state-persistence.ts — DOES DURABLE STATE ACTUALLY SURVIVE A CLOSE?
 *
 * The story graph (and with it the whole arc timeline) used to vanish on every
 * reopen for a desktop user with no project folder open. The cause was a
 * single conflated question: every store branched on `isDesktopApp()` and,
 * being on desktop, sent state to the project folder and skipped localStorage.
 * But `project:saveState` REFUSES the write when no folder is open, and nobody
 * read the result — so the state went nowhere, silently, and boot then cleared
 * localStorage for good measure.
 *
 * This asserts the three states a desktop session can be in:
 *   1. web (no electron)            → localStorage
 *   2. desktop, NO project open     → localStorage  (the regression)
 *   3. desktop, project open        → project folder, localStorage untouched
 *
 * Run: ./node_modules/.bin/tsx scripts/verify-state-persistence.ts
 */

// ── fakes, installed before the modules under test are imported ─────────────
const store = new Map<string, string>();
const projectFiles = new Map<string, string>();
let projectOpen = false;

(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const electronAPI = {
  isElectron: true,
  projectSaveState: async (key: string, data: string) => {
    if (!projectOpen) return { ok: false, error: "No project open" };
    projectFiles.set(key, data);
    return { ok: true };
  },
  projectLoadState: async (key: string) =>
    projectOpen && projectFiles.has(key)
      ? { ok: true, data: projectFiles.get(key)! }
      : { ok: false, data: null },
};

(globalThis as Record<string, unknown>).window = { electronAPI: undefined as unknown };

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function gate(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}

const wait = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  const { setProjectOpenState, stateTarget } = await import("../src/lib/project-manager");
  const { loadStoryGraph, saveStoryGraph, loadStoryGraphFromProject, emptyStoryGraph } =
    await import("../src/lib/story-graph");

  const sample = (tag: string) => ({
    version: 1 as const,
    entries: { "ch1": { chapterId: "ch1", contentHash: tag } as never },
  });

  // ── 1. web build ─────────────────────────────────────────────────────────
  console.log("\n1. web build (no electron)");
  (globalThis as Record<string, unknown>).window = { electronAPI: undefined };
  setProjectOpenState(false);
  gate("target is local", stateTarget() === "local");
  saveStoryGraph(sample("web") as never);
  await wait();
  gate("survives a reload", loadStoryGraph().entries["ch1"] !== undefined,
    `entries=${Object.keys(loadStoryGraph().entries).join(",") || "(none)"}`);

  // ── 2. desktop, NO project open — the regression ─────────────────────────
  console.log("\n2. desktop, no project open (the reported bug)");
  store.clear();
  (globalThis as Record<string, unknown>).window = { electronAPI };
  projectOpen = false;
  setProjectOpenState(false);
  gate("target is local", stateTarget() === "local");
  saveStoryGraph(sample("draft") as never);
  await wait();
  const reopened = loadStoryGraph();
  gate("TIMELINE SURVIVES CLOSE", reopened.entries["ch1"] !== undefined,
    `entries=${Object.keys(reopened.entries).join(",") || "(none — blank timeline)"}`);
  gate("project folder untouched", projectFiles.size === 0, `files=${projectFiles.size}`);

  // ── 3. desktop, project open ─────────────────────────────────────────────
  console.log("\n3. desktop, project open");
  store.clear();
  projectFiles.clear();
  projectOpen = true;
  setProjectOpenState(true);
  gate("target is project", stateTarget() === "project");
  saveStoryGraph(sample("proj") as never);
  await wait();
  gate("written to the project folder", projectFiles.has("story-graph"));
  gate("localStorage NOT used", store.size === 0, `keys=${store.size}`);
  const fromProject = await loadStoryGraphFromProject();
  gate("reloads from the project", !!fromProject?.entries["ch1"]);
  gate("in-memory boot starts empty (hydrate fills it)",
    Object.keys(loadStoryGraph().entries).length === 0);

  // ── 4. project closes under a live session ───────────────────────────────
  console.log("\n4. project closes mid-session (write refused)");
  store.clear();
  projectOpen = false; // folder gone, flag still says open
  setProjectOpenState(true);
  saveStoryGraph(sample("rescued") as never);
  await wait();
  gate("refused write falls back to local, not dropped", store.size > 0,
    `keys=${store.size}`);
  gate("target self-corrects after refusal", stateTarget() === "local");

  void emptyStoryGraph;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}  (${results.length} gates)\n`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
