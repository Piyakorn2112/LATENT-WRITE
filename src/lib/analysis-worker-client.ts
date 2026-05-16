import { runChapterAnalysis, type ChapterAnalysisResult, type RunChapterAnalysisInput } from "./chapter-analysis-runner";
import { logPerfEvent } from "./perf-trace";

interface AnalysisWorkerRequest {
  id: string;
  payload: RunChapterAnalysisInput;
}

type AnalysisWorkerResponse =
  | { id: string; ok: true; result: ChapterAnalysisResult }
  | { id: string; ok: false; error: string };

type PendingRequest = {
  resolve: (result: ChapterAnalysisResult) => void;
  reject: (error: Error) => void;
  startedAt: number;
  chapterId: string;
};

let worker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
const pending = new Map<string, PendingRequest>();

function clearPending(error: Error) {
  for (const [, request] of pending) request.reject(error);
  pending.clear();
}

function bindWorkerEvents(nextWorker: Worker) {
  nextWorker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    logPerfEvent("analysis.worker", performance.now() - request.startedAt, 8, {
      chapterId: request.chapterId,
      mode: message.ok ? "ok" : "error",
    });
    if (message.ok) {
      request.resolve(message.result);
      return;
    }
    request.reject(new Error(message.error));
  };

  nextWorker.onerror = (event) => {
    const error = new Error(event.message || "Analysis worker failed");
    worker?.terminate();
    worker = null;
    workerUnavailable = true;
    clearPending(error);
  };
};

function ensureWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./analysis-worker.ts", import.meta.url), { type: "module" });
    bindWorkerEvents(worker);
    return worker;
  } catch {
    workerUnavailable = true;
    worker = null;
    return null;
  }
}

export async function runChapterAnalysisInWorker(
  payload: RunChapterAnalysisInput,
): Promise<ChapterAnalysisResult> {
  const nextWorker = ensureWorker();
  if (!nextWorker) {
    return runChapterAnalysis(payload);
  }

  const id = `analysis-${nextRequestId++}`;
  const request: AnalysisWorkerRequest = { id, payload };
  return new Promise<ChapterAnalysisResult>((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      startedAt: performance.now(),
      chapterId: payload.chapter.id,
    });
    try {
      nextWorker.postMessage(request);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}