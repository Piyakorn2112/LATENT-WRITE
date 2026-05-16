# Glass Editor

Glass Editor is a desktop-first novel writing workspace built with React, TypeScript, Vite, and Electron. It combines a live writing surface with chapter analysis, world-data extraction, adaptive annotation feedback, story-graph generation, fullscreen timeline views, renderer-style prose review, and export tooling.

## Running The App

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run build
npm run electron:dev
npm run electron:build
npx tsx scripts/test-analysis-responsiveness.ts
```

## Architecture

This section is organized in two layers:

1. A full-system overview showing how the major subsystems connect.
2. Per-system internal diagrams with input channels, output channels, performance paths, and current bottlenecks.

### Full Overview

```mermaid
flowchart TD
    A[TXT import / localStorage / Electron menu] --> B[App.tsx]
    B --> C[Editor]
    B --> D[useAnalysis]
    B --> E[WorldDataView]
    B --> F[Story Graph Store]
    B --> G[AnalysisPanel]
    B --> H[Annotation + Adaptive Stores]
    B --> I[Renderer Review]
    B --> J[PDF Export]

    C --> K[HighlightLayer]
    C --> B

    D --> L[analysis-worker-client]
    L --> M[analysis-worker]
    M --> N[chapter-analysis-runner]
    N --> O[speech-detect]
    N --> P[action-detect]
    N --> Q[chapter-analysis]
    D --> G
    D --> F
    D --> K

    E --> R[world-data.ts]
    R --> K
    R --> F
    E --> B

    F --> S[StoryGraphPanel]
    S --> T[TimelineGraph]
    S --> U[TimelineGraphFull]

    H --> D
    H --> K
    H --> G

    I --> V[Electron IPC / remote model]
    I --> G

    J --> W[pdf-export.ts]
```

### Data Ownership Summary

- `App.tsx` is the orchestration root. It owns novel state, chapter selection, preferences, annotation/adaptive stores, story graph, review results, and overlay visibility.
- `Editor` is the live typing surface. It only owns local UI concerns such as sizing, caret tracking, and paragraph-scoped live highlight behavior.
- `useAnalysis` owns current-chapter analysis, stale-cache reuse, worker dispatch, and high-mode adjacent pre-analysis.
- `world-data.ts` owns entity extraction, name resolution, and rename utilities.
- `story-graph.ts` owns persisted chapter graph entries and asynchronous LM enrichment.
- `StoryGraphPanel` and `TimelineGraphFull` are presentation layers over precomputed graph/timeline data.

## System 1: App Shell And State Orchestration

```mermaid
flowchart LR
    A[localStorage loaders] --> B[App.tsx state]
    C[Electron menu / file input / keyboard shortcuts] --> B
    D[Editor edits] --> B
    E[WorldDataView edits] --> B
    F[Annotation popovers] --> B

    B --> G[Editor]
    B --> H[AnalysisPanel]
    B --> I[IndexView]
    B --> J[WorldDataView]
    B --> K[ProjectSearch / FindReplace / PDF / Onboarding]
    B --> L[Persistence effects]
```

### Input Channels

- Novel content loaded from `storage.ts`.
- Current chapter id loaded from `storage.ts`.
- Preferences loaded from `preferences.ts`.
- Story graph loaded from `story-graph.ts` localStorage helpers.
- Review results loaded from `renderer-review.ts` localStorage helpers.
- Annotation store loaded from `annotation-store.ts`.
- Adaptive store loaded from `adaptive-store.ts`.
- Electron menu commands, keyboard shortcuts, import/export actions.

### Output Channels

- Feeds `Editor`, `AnalysisPanel`, `WorldDataView`, overlays, and toolbars.
- Persists novel, chapter id, preferences, story graph, review results, annotations, and adaptive models.
- Pushes renamed entities back through chapter/book rename operations.

### Performance Paths

- Chapter edits update the active chapter and fan out into editor, analysis, and story-graph maintenance.
- Analysis settle events can update story graph entries and review surfaces.
- World-data edits can invalidate name resolution, timelines, and entity highlighting.

### Current Bottlenecks

- Any unstable prop passed from `App.tsx` into large children can reintroduce broad rerender churn.
- Large localStorage payloads remain sensitive to quota and serialization cost if prediction logs become too verbose.
- Story-graph maintenance is already deferred, but still fans out to multiple widgets after analysis settles.

## System 2: Editor And Highlight Layer

```mermaid
flowchart LR
    A[chapter.content] --> B[Editor textarea]
    A --> C[analysisSnapshotContent]
    B --> D[caret position]
    D --> E[active paragraph slice]
    E --> F[resolveLiveKnownNames]
    C --> G[grammar + speech/action snapshot data]

    F --> H[HighlightLayer live paragraph path]
    G --> I[HighlightLayer frozen snapshot path]
    H --> J[entity tags in active paragraph]
    I --> K[speech / action / grammar / scene labels]
```

### Input Channels

- Current chapter text from `App.tsx`.
- Analysis snapshot from `useAnalysis`.
- Known names from `useAnalysis` / world data.
- Annotation overrides and prediction traces from the annotation/adaptive layer.

### Output Channels

- Textarea edit events back to `App.tsx`.
- Live visual output through `HighlightLayer`.
- Entity click anchors into `EntityPopover`.
- Speech/action annotation clicks into `AnnotationPopover`.

### Performance Paths

- The live path only resolves names inside the paragraph under the caret.
- Grammar, speech, and action rendering stay on the settled snapshot path.
- Highlight overlay stays mounted to avoid compositor flips while typing.

### Current Bottlenecks

- Extremely long single paragraphs still cost more than average because the live path is paragraph-scoped, not token-scoped.
- Snapshot path still has to build rich markup for all analyzed paragraphs once analysis settles.
- Grammar remains intentionally excluded from the per-keystroke path because it is not cheap enough for live typing.

## System 3: Chapter Analysis Pipeline

```mermaid
flowchart LR
    A[Novel + currentChapterId + intel mode] --> B[useAnalysis]
    B --> C[knownNames resolver]
    B --> D[debounce + stale cache]
    D --> E[runChapterAnalysisInWorker]
    E --> F[analysis-worker]
    F --> G[chapter-analysis-runner]
    G --> H[speech-detect]
    G --> I[action-detect]
    G --> J[chapter-analysis]
    G --> K[endContext]

    K --> L[current chapter result]
    K --> M[high-mode adjacent pre-analysis]
    L --> N[Editor]
    L --> O[AnalysisPanel]
    L --> P[Story Graph update]
    M --> O
```

### Input Channels

- Current chapter text.
- Previous analyzed chapter end-context.
- Sibling chapter stats from cached analyses.
- Resolved names from `world-data.ts`.
- Intelligence level (`low`, `default`, `high`, or auto-resolved).
- Optional learned bias and adaptive inference context.

### Output Channels

- `ChapterAnalysisResult` for the current chapter.
- `prevResult` and `nextResult` for cross-chapter widgets.
- Snapshot data for `Editor` and `HighlightLayer`.
- Source material for story-graph chapter entries.

### Performance Paths

- Current chapter analysis runs in a worker-backed path with main-thread fallback.
- High mode also idle-schedules adjacent chapter pre-analysis.
- Stale cached results are shown immediately while fresh analysis recomputes.

### Current Bottlenecks

- High mode is materially heavier than the other modes on long chapters.
- Adjacent pre-analysis still consumes background time in high mode even though it is chunked and idle-scheduled.
- Without world data, known-name fallback extraction remains more expensive than the world-aware path.

### Observed Timing Profile

From `scripts/test-analysis-responsiveness.ts` on the current codebase:

- Low: ~44.45ms average across sampled chapters.
- Default: ~58.13ms average.
- High: ~214.73ms average.
- High mode is roughly 4.83x the cost of low mode on the sampled set.

## System 4: World Data And Entity Scan

```mermaid
flowchart LR
    A[Novel text / chapter text] --> B[WorldDataView scan UI]
    B --> C[scanAndClassify]
    C --> D[title-case candidate extraction]
    C --> E[context scoring + classification]
    C --> F[optional semantic assist in Electron]
    C --> G[review buckets]

    G --> H[characters]
    G --> I[places]
    G --> J[factions]
    G --> K[entities]

    H --> L[worldData]
    I --> L
    J --> L
    K --> L

    L --> M[resolveKnownNames]
    L --> N[rename utilities]
    L --> O[story timeline sync]
```

### Input Channels

- Full novel or chapter text.
- Existing world data.
- Optional adaptive context for prediction traces and feedback.
- Manual edits from `WorldDataView`.

### Output Channels

- Structured `worldData` buckets.
- Name list used by the highlight layer and speech detection.
- Rename operations across chapter or whole-book text.
- Character aliases and canonical names used by the story timeline.

### Performance Paths

- Heuristic entity extraction runs in batches with main-thread yielding.
- Semantic assist is hard-disabled outside Electron.
- Live highlight path uses `resolveLiveKnownNames`, not the full scan pipeline.

### Current Bottlenecks

- Whole-book scans on very large novels are still expensive even without semantic assist.
- Semantic assist remains runtime-gated and cannot be used in plain Vite/web dev.
- Moving entries between buckets is cheap, but rescans remain the dominant cost.

## System 5: Story Graph And Timeline Stack

```mermaid
flowchart LR
    A[ChapterAnalysisResult] --> B[buildChapterEntry]
    B --> C[StoryGraph store]
    C --> D[StoryGraphPanel]
    D --> E[buildSnapshotTimelineCharacterTracks]
    D --> F[buildTimelineCharacterTracks async sync]
    E --> G[TimelineGraph]
    F --> G
    E --> H[TimelineGraphFull]
    F --> H

    H --> I[StaticTimelineLayer]
    H --> J[EventBoxesLayer]
    H --> K[layout cache by visible window]
    H --> L[body freeze class]
```

### Input Channels

- Chapter analysis results.
- `worldData` character names and aliases.
- Chapter metadata and current chapter id.
- Optional LM enrichment for event relabeling/detail refinement.

### Output Channels

- Compact side-panel timeline.
- Fullscreen timeline overlay.
- Top-character chips and chapter navigation clicks.
- Stored story graph entries in localStorage.

### Performance Paths

- Story graph entries are updated after analysis settles, not on every keystroke.
- Timeline tracks use snapshot-first rendering, then asynchronous world-aware sync.
- Fullscreen timeline now splits into a static layer and a dynamic event-detail layer.
- Event box layouts are cached by visible chapter window.
- Opening the fullscreen overlay freezes background glass/backdrop work behind it.

### Current Bottlenecks

- Event-chip collision layout is still main-thread work.
- A 170-chapter timeline can still be limited by SVG text and chip density if the visible detail window becomes very busy.
- LM enrichment is asynchronous, but still extra work on top of the base story-graph pipeline.

## System 6: Annotation And Adaptive Learning

```mermaid
flowchart LR
    A[HighlightLayer speech/action clicks] --> B[AnnotationPopover]
    B --> C[annotation-store]
    C --> D[computeLearnedBias]
    C --> E[adaptive-store]
    E --> F[buildAdaptiveInferenceContext]
    F --> G[useAnalysis]
    G --> H[prediction traces]
    H --> E
    C --> I[annotation overrides for live overlay]
```

### Input Channels

- Manual speech/action corrections from the writer.
- Prediction traces from analysis.
- Current chapter id and world data.

### Output Channels

- Learned bias for speaker/action disambiguation.
- Adaptive model state and metrics.
- Debug panel metrics and review counts.
- Immediate overlay correction colors and labels.

### Performance Paths

- Prediction logging and model updates are constrained to feedback-oriented paths.
- Adaptive context is memoized and only passed into analysis when needed.
- Overlay uses lightweight overrides directly instead of waiting for full re-analysis.

### Current Bottlenecks

- Excessive prediction persistence can create storage churn and analysis loops if not kept idempotent.
- Retraining or updating adaptive state after many corrections can add background cost.
- Debug mode expands the amount of prediction detail retained and displayed.

## System 7: Renderer Review And Export

```mermaid
flowchart LR
    A[AnalysisPanel / RendererPanel trigger] --> B[runRendererReview]
    B --> C[Electron IPC]
    C --> D[remote review model]
    D --> E[ReviewResult]
    E --> F[reviewResults store]
    F --> G[RendererPanel UI]

    H[PDF export overlay] --> I[pdf-export.ts]
    I --> J[Electron save dialog / browser print flow]
```

### Input Channels

- Current chapter text.
- API key + selected review model.
- Novel metadata and export settings.

### Output Channels

- Renderer review flags in the analysis surface.
- Persisted review results.
- Exported PDF / print HTML.

### Performance Paths

- Review work is remote and asynchronous; it does not run in the live editor path.
- PDF export is on-demand and isolated behind its own overlay.

### Current Bottlenecks

- Renderer review depends on Electron and network/API latency.
- Review result persistence can grow over time with many chapters.
- PDF export is bounded more by document size and asset generation than by UI render cost.

## System 8: Liquid Glass And Compositing

```mermaid
flowchart LR
    A[.liquid-glass / analysis tabs / action groups] --> B[initLiquidGlassFilter]
    B --> C[ResizeObserver + idle scheduling]
    C --> D[liquid-glass-worker]
    D --> E[SVG filter cache]
    E --> F[per-element backdrop-filter url(#id)]
    F --> G[visible glass surfaces]

    H[Fullscreen timeline overlay] --> I[body.timeline-overlay-freeze]
    I --> J[background glass flattened]
```

### Input Channels

- DOM elements matching the glass selector.
- Element width, height, and border radius.
- Worker-generated displacement maps.

### Output Channels

- Per-element SVG filter ids applied as backdrop filters.
- Glass surfaces across panels, tabs, overlays, and action groups.
- Freeze mode for the fullscreen timeline overlay.

### Performance Paths

- Filter generation is idle-scheduled and offloaded to a worker.
- Filter instances are cached and reference-counted.
- Fullscreen timeline freeze mode disables background blur computation while keeping the overlay panel glass effect active.

### Current Bottlenecks

- Many simultaneous live glass surfaces can still increase compositor cost.
- Large overlay stacks with multiple backdrop-filter planes are expensive in Electron/Chromium.
- Resizing many glass surfaces at once can still burst worker/filter churn.

## Current System Hot Spots

- Fullscreen timeline detail chips remain the primary timeline-specific hot path.
- High intelligence mode remains intentionally expensive; low mode is the fast writing-safe path.
- Whole-book world/entity scans remain expensive on large manuscripts.
- LocalStorage persistence still needs disciplined payload sizes for annotations/adaptive data.
- Complex backdrop-filter stacks are still a compositor risk when not explicitly frozen or isolated.

## Files To Start With

- `src/App.tsx` — root orchestration.
- `src/components/Editor.tsx` — live writing surface.
- `src/components/HighlightLayer.tsx` — overlay rendering.
- `src/lib/use-analysis.ts` — analysis hook and worker dispatch.
- `src/lib/chapter-analysis-runner.ts` — pure analysis pipeline.
- `src/lib/world-data.ts` — world/entity scanning and name resolution.
- `src/lib/story-graph.ts` — chapter graph generation and persistence.
- `src/components/StoryGraphPanel.tsx` — compact graph and fullscreen entry point.
- `src/components/TimelineGraphFull.tsx` — fullscreen story timeline.
- `src/lib/liquid-glass-filter.ts` — glass filter worker orchestration.