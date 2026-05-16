import { runChapterAnalysis, type ChapterAnalysisResult, type RunChapterAnalysisInput } from "./chapter-analysis-runner";

interface AnalysisWorkerRequest {
  id: string;
  payload: RunChapterAnalysisInput;
}

type AnalysisWorkerResponse =
  | { id: string; ok: true; result: ChapterAnalysisResult }
  | { id: string; ok: false; error: string };

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { id, payload } = event.data;
  try {
    const result = runChapterAnalysis(payload);
    const response: AnalysisWorkerResponse = { id, ok: true, result };
    self.postMessage(response);
  } catch (error) {
    const response: AnalysisWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};