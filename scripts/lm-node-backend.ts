/**
 * lm-node-backend.ts — makes the narrative LM reachable from `tsx scripts/…`.
 *
 * WHY THIS FILE EXISTS
 *
 * `@xenova/transformers` v2 contains, in utils/image.js, a TOP-LEVEL static
 * import of `sharp`. sharp needs a compiled native binary that this project's
 * pnpm store does not build. Electron's main process works around it by
 * installing a `Module._load` stub before the import runs (see the "sharp stub"
 * block at the top of electron/main.cjs). No script did, so importing
 * src/lib/narrative-lm.ts under Node threw at import time.
 *
 * That failure was invisible. `enrichChapterEntryWithLM` wraps the whole LM
 * pass in `catch { return entry }`, so `test-event-labels.ts` reported
 *
 *     relabeled events: 0/6 (0%)
 *
 * and that zero was read for months as "the LM agrees with the dictionary".
 * It actually meant "the LM was never loaded". Measure the instrument first.
 *
 * Two other traps this file exists to keep closed:
 *   1. `env.localModelPath` must be a REAL filesystem path with a trailing
 *      separator. narrative-lm.ts's browser branch builds a `file://` URL,
 *      which Node's model loader cannot read.
 *   2. The stub MUST be installed before `@xenova/transformers` is imported.
 *      A dynamic import inside `install()` guarantees the order; a top-level
 *      import in this file would not.
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { setEmbedder } from "../src/lib/narrative-lm";

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

let sharpStubbed = false;

function stubSharp(): void {
  if (sharpStubbed) return;
  sharpStubbed = true;
  const Module = require_("module") as {
    _load: (id: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = Module._load;
  const noop = function () {};
  // A Proxy that answers every access with itself, so any incidental property
  // read on the fake sharp resolves instead of throwing. `then` returns
  // undefined so the mock is never mistaken for a thenable by `await`.
  const mock: unknown = new Proxy(noop, {
    get: (_target, key) => (key === "then" ? undefined : mock),
    apply: () => mock,
    construct: () => ({}),
  });
  Module._load = function (id: string, parent: unknown, isMain: boolean) {
    if (id === "sharp" || (typeof id === "string" && id.includes("node_modules/sharp/lib/index.js"))) {
      return mock;
    }
    return original.call(this, id, parent, isMain);
  };
}

/** Model ids in the same preference order the app uses. L12 first: better
 *  semantics at 32MB vs L6's 22MB, and both emit 384 dimensions so nothing
 *  downstream has to know which one answered. */
const PREFERRED_MODEL_IDS = [
  "Xenova/all-MiniLM-L12-v2",
  "Xenova/all-MiniLM-L6-v2",
] as const;

/**
 * `EMBED_MODEL=<id>` forces one model, so a bake-off can hold everything else
 * fixed. Comparing embedding backends is only meaningful if the ONLY thing that
 * changes is the backend.
 */
const FORCED = process.env.EMBED_MODEL;

export interface LmBackendInfo {
  modelId: string;
  loadMs: number;
  /** Wall-clock ms of the first embed, which includes graph warm-up. */
  firstEmbedMs: number;
}

let installed: LmBackendInfo | null = null;

/**
 * Load a MiniLM pipeline under Node and install it as the LM's embedder.
 * Returns null when no model is present in public/models — the caller should
 * SAY SO rather than quietly report LM-path numbers produced without an LM.
 */
export async function installNodeEmbedder(): Promise<LmBackendInfo | null> {
  if (installed) return installed;
  stubSharp();

  const { pipeline, env } = await import("@xenova/transformers");
  const e = env as unknown as {
    localModelPath: string;
    allowLocalModels: boolean;
    useBrowserCache: boolean;
  };
  e.localModelPath = path.join(REPO_ROOT, "public", "models") + path.sep;
  e.allowLocalModels = true;
  e.useBrowserCache = false;

  const candidates = FORCED ? [FORCED] : PREFERRED_MODEL_IDS;
  for (const modelId of candidates) {
    const t0 = Date.now();
    let pipe: unknown;
    try {
      pipe = await pipeline("feature-extraction", modelId);
    } catch {
      continue;
    }
    const loadMs = Date.now() - t0;
    const run = pipe as (
      text: string,
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;

    const t1 = Date.now();
    await run("warm-up", { pooling: "mean", normalize: true });
    const firstEmbedMs = Date.now() - t1;

    setEmbedder(async (text: string) => {
      const out = await run(text.slice(0, 500), { pooling: "mean", normalize: true });
      // Keep the model's NATURAL width. This used to hard-slice to 384 — right
      // for MiniLM L6/L12, but it would have silently truncated a 768-dim model
      // to its first half during a bake-off and produced a quietly wrong answer.
      return out.data as Float32Array;
    });

    installed = { modelId, loadMs, firstEmbedMs };
    return installed;
  }
  return null;
}

/** Print the backend line every LM-dependent suite should start with, so a
 *  run that produced no-LM numbers can never be mistaken for one that did. */
export function reportBackend(info: LmBackendInfo | null): void {
  if (info) {
    console.log(`LM backend: ${info.modelId}  load ${info.loadMs}ms  first embed ${info.firstEmbedMs}ms`);
  } else {
    console.log("LM backend: NONE — no model in public/models. LM-path numbers below are meaningless.");
  }
}
