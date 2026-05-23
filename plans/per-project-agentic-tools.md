# Per-Project Agentic Tools — Implementation Plan

## 1 — Concept

Writers can create custom tools for their novel project via the renderer chat. The agent reads the project's story primary, configuration, and naming reference, then assembles a tool package — a small code bundle dropped into the project directory. The app discovers and loads these tools on project open, making them available system-wide: as slash commands in the renderer chat, as widget cards in the analysis panel, as editor highlight annotations, or as full-screen overlays.

Tools are not limited to the renderer panel. They integrate across every surface in the app.

### What a tool is

A tool is a directory inside `tools/` in the project root containing:

- A **manifest** (`tool.json`) describing the tool's name, command, surfaces, and data requirements.
- A **logic module** (`logic.ts`) with local heuristic functions that run in the renderer — no Claude cost, instant results.
- A **prompt template** (`prompt.md`) for Claude-powered operations that need deeper analysis.
- An optional **widget module** (`widget.tsx`) that renders into the analysis panel or overlay using baseline UI components.

```
MyNovel/
  tools/
    timeline-auditor/
      tool.json
      logic.ts
      prompt.md
      widget.tsx
    thread-tracker/
      tool.json
      logic.ts
      prompt.md
    name-scanner/
      tool.json
      logic.ts
```

### What a tool is not

- Not a plugin with arbitrary DOM access or external network calls.
- Not an npm package with a dependency tree.
- Not a replacement for the built-in analysis pipeline — tools augment it.

---

## 2 — Tool Manifest (`tool.json`)

The manifest is the contract between the tool and the app. The app reads it on project open to register commands, allocate widget slots, and wire up data flows.

```jsonc
{
  // Identity
  "name": "timeline-auditor",          // kebab-case, unique within project
  "display": "Timeline Auditor",       // human label for UI
  "version": "1.0.0",
  "description": "Verify temporal references against story primary timeline",

  // Registration
  "command": "/timeline",              // slash command in renderer chat
  "shortcut": null,                    // optional keyboard shortcut (Electron menu)

  // Where the tool renders
  "surfaces": ["widget", "chat"],
  // Possible values:
  //   "chat"      — output appears as renderer chat messages
  //   "widget"    — renders a card in the analysis panel widget grid
  //   "overlay"   — opens a full-screen overlay (like timeline or workspace)
  //   "highlight" — injects annotations into the editor highlight layer
  //   "sidebar"   — adds a section to the index/world-data sidebar

  // Data requirements — what the tool needs from the project
  "inputs": {
    "chapter": "current",              // "current" | "all" | "range"
    "analysis": true,                  // needs ChapterAnalysisResult
    "worldData": false,                // needs WorldData
    "files": [                         // project files to read
      "*_STORY_PRIMARY.txt",
      "NAMING_REFERENCE.md"
    ]
  },

  // Output destinations
  "outputs": {
    "report": "review-logs/timeline/", // where reports are saved
    "widget": true,                    // whether widget.tsx exists
    "highlights": false                // whether to inject editor annotations
  },

  // Cost and safety
  "requiresClaude": true,              // uses prompt.md (costs API tokens)
  "estimatedTokens": 4000,            // approximate Claude input cost
  "edited": false                      // true = user has manually edited; blocks agent overwrite
}
```

### Validation rules

The app validates manifests on load:

- `name` must be unique across all project tools.
- `command` must start with `/` and not collide with built-in commands (`/scan`, `/draft`, `/review`, `/lore`, `/assemble`, `/update`, `/init`, `/context`, `/clear`, `/help`, `/model`, `/models`, `/effort`).
- `surfaces` must be a non-empty array of recognized surface names.
- `inputs.files` patterns must resolve to files inside the project directory (no `../` escapes).

---

## 3 — Tool Logic Module (`logic.ts`)

The logic module exports functions that run locally in the renderer process. No Claude, no network — pure computation on project data. This is the tool's fast path.

### Interface contract

```typescript
// Every logic module must export a `run` function matching this signature.
// The app calls it with a standardized context object.

export interface ToolContext {
  // Chapter data
  chapterContent: string;
  chapterTitle: string;
  chapterIndex: number;
  allChapters: Array<{ title: string; content: string; number: number }>;

  // Analysis data (if inputs.analysis is true)
  analysis: ChapterAnalysisResult | null;

  // World data (if inputs.worldData is true)
  worldData: WorldData | null;

  // Project files (resolved from inputs.files patterns)
  files: Record<string, string>;  // relative path → content

  // Previous tool state (loaded from .renderer/tools/<name>.json)
  previousState: unknown;
}

export interface ToolResult {
  // Chat output (shown in renderer panel as system message)
  summary: string;

  // Widget data (passed to widget.tsx if surfaces includes "widget")
  widgetData?: unknown;

  // Highlight annotations (if surfaces includes "highlight")
  highlights?: Array<{
    start: number;
    end: number;
    type: string;
    label: string;
    severity: "info" | "warning" | "error";
  }>;

  // Report content (saved to outputs.report path)
  report?: string;

  // State to persist for next run
  state?: unknown;

  // Whether to chain into Claude prompt (triggers prompt.md)
  chainClaude?: boolean;
  claudeContext?: string;  // extra context to prepend to prompt.md
}

export function run(ctx: ToolContext): ToolResult;
```

### Example: timeline-auditor/logic.ts

```typescript
const TEMPORAL_RE = /(\d+)\s*(month|week|day|year|hour)s?\s*(later|earlier|before|after|ago)/gi;
const MONTH_REF_RE = /month\s+(\d+)/gi;
const CHAPTER_TIME_RE = /===CHAPTER\s+(\d+):.+?===[\s\S]*?(?:month|year|week)\s+(\d+)/gi;

export function run(ctx: ToolContext): ToolResult {
  const storyPrimary = Object.values(ctx.files).find(f =>
    f.includes("STORY_PRIMARY")
  ) || "";

  // Extract timeline markers from story primary
  const primaryTimeline = extractTimelineMarkers(storyPrimary);

  // Extract temporal references from chapter text
  const chapterRefs = extractTemporalReferences(ctx.chapterContent);

  // Cross-reference and find conflicts
  const conflicts = findConflicts(primaryTimeline, chapterRefs, ctx.chapterIndex);

  if (conflicts.length === 0) {
    return {
      summary: `Timeline check passed. ${chapterRefs.length} temporal references verified.`,
      widgetData: { refs: chapterRefs, conflicts: [], status: "pass" },
    };
  }

  return {
    summary: `Timeline check found ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}:\n` +
      conflicts.map(c => `- ${c.description}`).join("\n"),
    widgetData: { refs: chapterRefs, conflicts, status: "fail" },
    highlights: conflicts.map(c => ({
      start: c.charStart,
      end: c.charEnd,
      type: "timeline-conflict",
      label: c.shortLabel,
      severity: "error" as const,
    })),
    report: formatTimelineReport(chapterRefs, conflicts),
    chainClaude: conflicts.length > 2,  // escalate to Claude if multiple conflicts
    claudeContext: `Found ${conflicts.length} timeline conflicts. Verify these against the full story primary.`,
  };
}
```

### Execution environment constraints

- Logic modules run in the renderer's JavaScript context (same thread as React).
- They have NO access to: `window`, `document`, `fetch`, `XMLHttpRequest`, Node APIs, or Electron APIs.
- They receive data through the `ToolContext` parameter and return results through `ToolResult`.
- The app wraps execution in a try/catch — a failing tool never crashes the editor.
- Execution timeout: 5 seconds. Tools that need more time should chunk their work or flag `chainClaude: true` and let Claude handle the heavy analysis.

---

## 4 — Prompt Template (`prompt.md`)

When a tool chains into Claude (either because `chainClaude: true` in the logic result, or the user runs the slash command directly), the app builds a Claude prompt from this template.

### Template variable system

Variables use `{{double_braces}}`. The app resolves them before sending to Claude.

| Variable | Resolves to |
|---|---|
| `{{chapter_content}}` | Current chapter text |
| `{{chapter_title}}` | Current chapter title |
| `{{chapter_number}}` | Current chapter number |
| `{{story_primary}}` | Full story primary content |
| `{{story_primary_section_0}}` | Section 0 (Writing Directives) only |
| `{{story_primary_section_10}}` | Section 10 (Chapter Entries) only |
| `{{naming_reference}}` | Full NAMING_REFERENCE.md |
| `{{novel_config}}` | Full NOVEL_CONFIGURATION.md |
| `{{tool_context}}` | `claudeContext` from logic result |
| `{{tool_previous_report}}` | Previous report from `outputs.report` path |
| `{{file:relative/path.md}}` | Content of a specific project file |

### Example: timeline-auditor/prompt.md

```markdown
You are a timeline continuity checker for the novel {{chapter_title}}.

{{tool_context}}

STORY PRIMARY TIMELINE ENTRIES (relevant sections):
{{story_primary_section_10}}

CHAPTER TEXT:
<<<CHAPTER>>>
{{chapter_content}}
<<<END CHAPTER>>>

TASK:
1. For every temporal reference in this chapter, write the arithmetic explicitly.
2. Cross-reference against the story primary timeline.
3. Flag any contradictions as P1 (blocks assembly) or P2 (cosmetic).
4. If the previous report found issues, verify whether they are now fixed.

{{tool_previous_report}}

Output: a numbered list of temporal references with PASS/FAIL verdicts and arithmetic.
```

### Prompt construction pipeline

When the tool runs with Claude:

1. App reads `prompt.md` from the tool directory.
2. App resolves all `{{variables}}` against current project state.
3. If the logic module returned `claudeContext`, it is injected into `{{tool_context}}`.
4. The resolved prompt is sent via `claudeStream` (existing IPC path).
5. Claude's response appears in the renderer chat as normal streaming output.
6. The response is also saved to the tool's report path.

---

## 5 — Widget Module (`widget.tsx`)

Tools that declare `"surfaces": ["widget"]` can ship a widget that renders in the analysis panel alongside the built-in widgets (tension, pacing, voice, etc.).

### Baseline component kit

Tool widgets import from a baseline kit shipped with the app. This kit enforces the glass design system without tools needing to know CSS details.

```typescript
// Baseline components available to tool widgets
// Imported as: import { ToolCard, ToolBadge, ... } from "glass-editor/tool-kit";

// ── Layout ──────────────────────────────────────────────────────────────────

interface ToolCardProps {
  bg: string;                    // CSS color for card background
  accent: string;                // CSS color for accent elements
  topLeft?: ReactNode;           // corner label (e.g., tool name)
  topRight?: ReactNode;          // corner label (e.g., score)
  bottomLeft?: ReactNode;        // corner label (e.g., chapter)
  bottomRight?: ReactNode;       // corner label (e.g., timestamp)
  deco?: ReactNode;              // decorative SVG layer
  heroAlign?: "center" | "start";
  children: ReactNode;
}

// Wraps the existing WidgetCard with identical API.
// Ensures all tool cards match built-in widget visual treatment.
export function ToolCard(props: ToolCardProps): JSX.Element;

// ── Data Display ────────────────────────────────────────────────────────────

interface ToolBadgeProps {
  label: string;
  status: "pass" | "fail" | "warning" | "info" | "neutral";
}

// Status pill: green/red/yellow/blue/gray with label text.
export function ToolBadge(props: ToolBadgeProps): JSX.Element;

interface ToolDataRowProps {
  label: string;
  value: string | number;
  status?: "pass" | "fail" | "warning";
}

// Single key-value row for tabular results inside a ToolCard.
export function ToolDataRow(props: ToolDataRowProps): JSX.Element;

interface ToolDataTableProps {
  columns: Array<{ key: string; label: string; align?: "left" | "right" | "center" }>;
  rows: Array<Record<string, string | number>>;
  highlightRow?: (row: Record<string, string | number>) => "pass" | "fail" | "warning" | null;
}

// Compact table for multi-column results (timeline entries, name lists).
export function ToolDataTable(props: ToolDataTableProps): JSX.Element;

// ── Charts ──────────────────────────────────────────────────────────────────

interface ToolSparklineProps {
  values: number[];              // 0-1 normalized
  color?: string;                // stroke color (defaults to accent)
  width?: number;
  height?: number;
}

// Catmull-Rom sparkline matching the tension widget's visual language.
export function ToolSparkline(props: ToolSparklineProps): JSX.Element;

interface ToolProgressRingProps {
  value: number;                 // 0-1
  label?: string;
  color?: string;
  size?: number;
}

// Circular progress ring matching DialRing/ArcRing pattern.
export function ToolProgressRing(props: ToolProgressRingProps): JSX.Element;

interface ToolHeatmapProps {
  xLabels: string[];             // column headers (e.g., chapter numbers)
  yLabels: string[];             // row headers (e.g., character names)
  values: number[][];            // 0-1 normalized, [row][col]
  colorScale?: "sequential" | "diverging";
  onCellClick?: (row: number, col: number) => void;
}

// Chapter x dimension grid with color encoding.
export function ToolHeatmap(props: ToolHeatmapProps): JSX.Element;

// ── Overlay ─────────────────────────────────────────────────────────────────

interface ToolOverlayProps {
  title: string;
  onClose: () => void;
  sidebar?: ReactNode;           // optional left sidebar
  children: ReactNode;           // main content area
}

// Full-screen overlay matching RendererWorkspaceFull visual treatment.
// Applies body-freeze class, glass backdrop, escape-to-close.
export function ToolOverlay(props: ToolOverlayProps): JSX.Element;
```

### Widget rendering contract

```typescript
// Every widget.tsx must export a default component matching this signature.
// The app passes widgetData from the logic module's ToolResult.

interface ToolWidgetProps {
  data: unknown;                 // widgetData from logic.ts result
  chapterTitle: string;
  isAnalyzing: boolean;          // true while analysis pipeline is running
}

export default function TimelineWidget({ data, chapterTitle, isAnalyzing }: ToolWidgetProps): JSX.Element;
```

### Example: timeline-auditor/widget.tsx

```tsx
import { ToolCard, ToolBadge, ToolDataRow, ToolSparkline } from "glass-editor/tool-kit";

interface TimelineData {
  refs: Array<{ text: string; chapter: number; month: number }>;
  conflicts: Array<{ description: string; severity: string }>;
  status: "pass" | "fail";
}

export default function TimelineWidget({ data }: { data: TimelineData }) {
  const d = data as TimelineData;
  if (!d) return null;

  return (
    <ToolCard
      bg="rgba(30, 58, 95, 0.35)"
      accent={d.status === "pass" ? "#22c55e" : "#f43f5e"}
      topLeft="Timeline"
      topRight={<ToolBadge label={d.status.toUpperCase()} status={d.status} />}
      bottomLeft={`${d.refs.length} refs`}
      bottomRight={d.conflicts.length > 0 ? `${d.conflicts.length} conflicts` : null}
    >
      {d.conflicts.length === 0 ? (
        <span style={{ opacity: 0.7, fontSize: 11 }}>All temporal references verified</span>
      ) : (
        d.conflicts.slice(0, 3).map((c, i) => (
          <ToolDataRow key={i} label={c.description} value="FAIL" status="fail" />
        ))
      )}
    </ToolCard>
  );
}
```

---

## 5A — Design Token Reference & Foundation Component Rules

The baseline component kit (§5) wraps the app's glass design system. This section codifies the **exact tokens, patterns, and micro-interactions** that every tool component must follow. The agent references this when generating `widget.tsx` files — it is the single source of truth for visual consistency.

### 5A.1 — Color tokens

Tool widgets render on dark card backgrounds. All internal text/UI uses `rgba(255,255,255,…)` alpha stacks — never system-level `var(--text)` tokens (those are for overlay/panel UI, not widget cards).

**Widget card backgrounds** — each tool picks a `bg` + `accent` pair:

| Role | Pattern | Examples from built-in widgets |
|---|---|---|
| `bg` | `rgba(r, g, b, 0.35)` — dark translucent | `rgba(30, 58, 95, 0.35)` (tension), `rgba(50, 35, 65, 0.35)` (voice) |
| `accent` | Full-saturation CSS color | `#5ab8e0` (blue), `#f59e0b` (amber), `#a78bfa` (purple), `#34d399` (green) |

**Semantic status colors** (used in badges, highlights, trend indicators):

| Status | Light | Dark | Usage |
|---|---|---|---|
| Pass / good | `#34c759` | `#30d158` | Checkbox checked, pass badges |
| Fail / error | `#f43f5e` | `#f43f5e` | High tension, conflicts, fail badges |
| Warning | `#fbbf24` | `#fbbf24` | Medium tension, caution states |
| Neutral / calm | `#94a3b8` | `#94a3b8` | Low states, inactive |
| Info / accent | `#5ab8e0` | `#5ab8e0` | Default accent, informational |

**System-level overlay/panel tokens** (for ToolOverlay, not widget cards):

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--bg-glass` | `rgba(255,255,255,0.621)` | `rgba(36,36,34,0.55)` | Panel backgrounds |
| `--bg-glass-hover` | `rgba(255,255,255,0.78)` | `rgba(50,50,48,0.72)` | Hover states |
| `--bg-glass-strong` | `rgba(255,255,255,0.72)` | `rgba(46,46,44,0.72)` | Elevated panels, active tabs |
| `--overlay-scrim-bg` | `rgba(20,20,22,0.18)` | same | Scrim backdrop |
| `--text` | dark | light | Primary text in panels |
| `--text-secondary` | — | — | Secondary text, cancel buttons |
| `--text-tertiary` | — | — | Muted labels, hints |
| `--divider-line` | — | — | Borders, separators |

### 5A.2 — Border & shadow technique

**Every glass panel and card** uses the gradient-mask border pseudo-element — never `border: 1px solid`. This is a hard rule.

```css
/* Glass gradient border — mandatory for all panel/card surfaces */
.component::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;             /* 1px for panels, 1.2px for widget cards */
  background: var(--border-glass-grad);       /* panels */
  /* OR: var(--border-glass-grad-widget); */  /* widget cards */
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: destination-out;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 0;
}
```

**Shadows:**

| Token | Value (light) | Value (dark) |
|---|---|---|
| `--shadow-glass` | `0 2px 15px rgba(0,0,0,0.05)` | `0 2px 18px rgba(0,0,0,0.25)` |
| `--shadow-glass-hover` | `0 4px 18px rgba(0,0,0,0.08)` | `0 4px 26px rgba(0,0,0,0.35)` |

### 5A.3 — Radius scale

| Surface | Radius | Token |
|---|---|---|
| Overlay panels | `38px` | — |
| Widget cards | `32px` | — |
| Settings panel | `30px` | — |
| Card-radius (general) | `22px` | `--card-radius` |
| Analysis tabs | `16px` | — |
| Settings buttons | `14px` | — |
| List rows (hover bg) | `12px` | — |
| Buttons / pills | `9999px` | `--btn-radius` |
| Checkboxes | `6px` | — |

### 5A.4 — Typography hierarchy

Two font stacks, strict separation:

| Stack | Token | Used for |
|---|---|---|
| Body | `--font-body` | Overlay titles, chapter text, display headings |
| UI | `--font-ui` | All controls, labels, badges, stats, widget content |

**Size scale (inside widgets — all `--font-ui`):**

| Role | Size | Weight | Spacing | Example |
|---|---|---|---|---|
| Hero number | `3rem` / `1.85rem` | 800 | `-0.04em` | WidgetCard hero, DialRing centre |
| Hero unit | `0.75rem` / `0.6rem` | 700 | `0.10em` / `0.14em` | Unit suffix (WPM, %), DialRing label |
| Hero label | `1.5rem` | 900 | `0.06em` | Prose Profile register label |
| Corner label | `10px` | 600 | `0.12em` | Widget corner TL/TR — uppercase |
| Corner dim | `10px` | 500 | `0.06em` | Widget corner BL/BR — normal case |
| Section header | `10px` | 700 | `0.14em` | `.wg-header-title` — uppercase |
| Stat number | `13px` | 700 | — | `.wg-stat-num` |
| Stat key | `10px` | 500 | `0.04em` | `.wg-stat-key` |
| Segment label | `10px` | 500 | — | `.wg-seg-label`, `.wg-channel-name` |
| Badge | `9px` | 700 | `0.08em` | `.wg-header-badge` — uppercase |
| Trend text | `9px` / `10px` | 500-600 | `0.04em` | `.wg-seg-tension`, `.wg-momentum-trend` |

**Size scale (overlay/panel UI — mixes `--font-body` and `--font-ui`):**

| Role | Family | Size | Weight | Spacing |
|---|---|---|---|---|
| Panel title | `--font-body` | `1.25rem` | normal | — |
| Section label | `--font-ui` | `9px`-`10.5px` | 600-700 | `0.08em`-`0.12em` — uppercase |
| Row label / setting title | `--font-ui` | `11px`-`12px` | 600 | — |
| Description text | `--font-ui` | `10px`-`10.5px` | 400 | — |
| Button text | `--font-ui` | `12px` | 600 | `0.04em` |
| Pill text | `--font-ui` | `11px` | 500 | `0.02em` |
| Tab text | `--font-ui` | `11px` | 600 | `0.04em` |
| Tab count badge | `--font-ui` | `9.5px` | 700 | — |

### 5A.5 — Animation & micro-interaction contracts

All interactions use the same easing family — tools must not introduce new easing curves.

**Spring easing** (knobs, toggles, bouncy elements):
```
cubic-bezier(0.34, 1.56, 0.64, 1)
```

**Standard easing** (fades, background transitions):
```
ease — 0.12s to 0.18s duration
```

**Knob / toggle scale progression:**

| State | Scale | Background | Duration |
|---|---|---|---|
| Rest | `1.0` | solid white | — |
| Hover | `1.08` | solid white | 0.28s spring |
| Press | `1.35` (toggle) / `1.62` (slider) | semi-transparent glass gradient | 0.28s spring |

The press state creates a "glass puck" effect: the knob becomes translucent so the track color bleeds through. Implementation:

```css
/* Press: knob goes translucent + gains inset rim + larger shadow */
background: linear-gradient(180deg,
  rgba(255, 255, 255, 0.78) 0%,
  rgba(255, 255, 255, 0.52) 100%);
box-shadow:
  inset 0 0 0 1px rgba(255, 255, 255, 0.55),
  inset 0 1px 0 rgba(255, 255, 255, 0.85),
  0 2px 6px rgba(0, 0, 0, 0.22),
  0 12px 28px rgba(0, 0, 0, 0.22);
```

**Widget mount animation** — staggered via `useFrameDelay`:
- Each widget card mounts with a per-index delay
- CSS transition on `opacity` + `transform` (translate up)
- Total stagger: ~40ms per widget card

**Sparkline glow** — Catmull-Rom curve with gradient under-fill and a blurred glow layer behind the stroke for a "lit-up" effect.

**Tab working state** — pulsing icon:
```css
@keyframes analysis-tab-pulse {
  0%, 100% { opacity: 0.55; transform: scale(1);    }
  50%       { opacity: 1;    transform: scale(1.10); }
}
```

### 5A.6 — Additional foundation components (beyond §5)

The §5 kit covers widget-surface components. These additional components serve **overlay, sidebar, and settings surfaces** that tools may also render into:

#### ToolToggle

Wraps `GlassToggle`. Used in tool settings panels or overlay controls.

```typescript
interface ToolToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}
export function ToolToggle(props: ToolToggleProps): JSX.Element;
```

Renders as a `.settings-toggle-row` with title + optional description on the left, GlassToggle on the right.

#### ToolRange

Wraps `GlassRange`. Used for numeric tool parameters (threshold, sensitivity).

```typescript
interface ToolRangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue?: (v: number) => string;
  onChange: (v: number) => void;
}
export function ToolRange(props: ToolRangeProps): JSX.Element;
```

Renders as a `.settings-stack` with label + value header row above the glass-range track. The `formatValue` function controls the display (e.g., `"85%"`, `"4,000 tokens"`).

#### ToolPillGroup

Wraps the `.settings-pill` / `.settings-pillgroup` pattern. Used for mutually-exclusive options (mode selection, view toggle).

```typescript
interface ToolPillGroupProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}
export function ToolPillGroup<T extends string>(props: ToolPillGroupProps<T>): JSX.Element;
```

Active pill uses the inverse-tone tint (dark text on white in dark mode, white text on dark in light mode).

#### ToolTabBar

Wraps the `.world-tabs` / `.world-tab` pattern. Used when a tool overlay or sidebar panel needs tabbed views.

```typescript
interface ToolTabBarProps<T extends string> {
  tabs: Array<{ value: T; label: string; count?: number; status?: "ready" | "working" | "error" }>;
  value: T;
  onChange: (v: T) => void;
}
export function ToolTabBar<T extends string>(props: ToolTabBarProps<T>): JSX.Element;
```

Active tab: `rgba(0,0,0,0.06)` bg (light) / `rgba(255,255,255,0.10)` bg (dark), `border-color: var(--divider-line)`. Count badge in `9.5px` bold. Status indicator dot: green (ready) / pulsing blue (working) / red (error).

#### ToolSectionLabel

The small uppercase section divider used in settings panels and list views.

```typescript
interface ToolSectionLabelProps {
  children: string;
}
export function ToolSectionLabel(props: ToolSectionLabelProps): JSX.Element;
```

Renders as `--font-ui`, `9px`-`10.5px`, `font-weight: 600`-`700`, `letter-spacing: 0.08em`-`0.12em`, uppercase, `color: var(--panel-text-3)` (in side panels) or `rgba(255,255,255,0.45)` (inside widget cards).

#### ToolButton

Shared button component enforcing the system button styling (same as PDF export overlay / widget config overlay buttons).

```typescript
interface ToolButtonProps {
  variant: "primary" | "secondary";
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}
export function ToolButton(props: ToolButtonProps): JSX.Element;
```

Both variants share:
- `--font-ui`, `12px`, `font-weight: 600`, `letter-spacing: 0.04em`
- `padding: 9px 18px`, `border-radius: var(--btn-radius)`
- `border: 1px solid var(--divider-line)`
- `transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease`

Primary: `background: var(--text)`, `color: var(--bg)`, `border-color: var(--text)`. Hover → `background/border: var(--text-secondary)`.
Secondary: `background: transparent`, `color: var(--text-secondary)`. Hover → `background: var(--bg-glass-hover)`, `color: var(--text)`.

#### ToolDialRing

Wraps `DialRing` with simplified props for the common single-fill use case.

```typescript
interface ToolDialRingProps {
  value: number;          // 0-1
  label?: string;         // centre text
  color?: string;         // accent colour
  size?: number;
}
export function ToolDialRing(props: ToolDialRingProps): JSX.Element;
```

#### ToolArcRing

Wraps `ArcRing` for continuous-arc gauges.

```typescript
interface ToolArcRingProps {
  value: number;          // 0-1
  label?: string;
  unit?: string;          // e.g. "%" shown below the number
  color?: string;
  size?: number;
  thickness?: number;
  showIndicator?: boolean;
}
export function ToolArcRing(props: ToolArcRingProps): JSX.Element;
```

### 5A.7 — Widget card content primitives

Inside widget cards, tools use a shared set of content layout patterns. These are CSS class-level primitives (not React components), provided as a style dictionary the agent uses when generating `widget.tsx`:

| Primitive | Class(es) | What it renders |
|---|---|---|
| Content wrapper | `.wg-content` | flex column, full width, gap: 0 |
| Section group | `.wg-section` | flex column, gap: 7px, padding: 2px 0 |
| Divider | `.wg-divider` | 1px line, `rgba(255,255,255,0.07)`, margin: 7px 0 |
| Header row | `.wg-header-row` + `.wg-header-title` | flex row, 10px uppercase title, 0.14em spacing |
| Header badge | `.wg-header-badge` | 9px bold pill, `rgba(255,255,255,0.07)` bg |
| Stat inline | `.wg-stat` + `.wg-stat-num` + `.wg-stat-key` | `13px` bold number + `10px` muted key |
| Dot separator | `.wg-dot-sep` | `rgba(255,255,255,0.18)` dot between stats |
| Segment row | `.wg-seg` + `.wg-seg-dot` + `.wg-seg-label` + `.wg-seg-cells` | Colored dot + label + cell heatstrip |
| Channel bar | `.wg-channel` + `.wg-channel-track` + `.wg-channel-fill` | Named track bar with colored fill |
| Momentum row | `.wg-momentum-row` + label + bar + fill + trend | Full labeled progress bar with trend text |
| Overall summary | `.wg-seg-overall` | Border-top row with summary stat |

### 5A.8 — Mandatory rules for agent-generated widgets

1. **No raw HTML/CSS** — tool widgets import from the baseline kit only. No inline styles except `--card-bg` and `--card-accent` on the root `ToolCard`.
2. **No `var(--text)` inside widget cards** — use `rgba(255,255,255,…)` for all text inside dark card backgrounds.
3. **No custom easing curves** — use the system spring or standard ease.
4. **No `border:` on glass surfaces** — use the `::before` gradient-mask technique via the wrapped component.
5. **No custom shadows** — use `--shadow-glass` / `--shadow-glass-hover` tokens.
6. **No Lucide icons** — only import icons already used by the app. New icon needs must use inline SVG matching the app's icon weight (1.5-1.8px stroke, round caps/joins).
7. **Colours must come from the semantic palette** (§5A.1) or the tool's declared `accent`. No hardcoded hex values outside the status colour set.
8. **Font sizes must come from the type scale** (§5A.4). No arbitrary font-size values.
9. **Overlay/panel surfaces must use** `--bg-glass-strong` background, `38px` radius, `::before` glass border, `var(--shadow-glass)` shadow, and `var(--overlay-scrim-bg)` scrim.
10. **Button text must match** the system button spec: `12px`, `600` weight, `0.04em` spacing, `var(--btn-radius)` pill, `1px solid` border on both variants.

---

## 6 — App-Side Discovery and Loading

### 6.1 Tool registry (new module: `src/lib/tool-registry.ts`)

On project open, the app scans for tools and builds a registry.

```typescript
interface RegisteredTool {
  manifest: ToolManifest;
  dirPath: string;               // relative path: "tools/timeline-auditor"
  logicModule: ToolLogicModule | null;
  widgetModule: ToolWidgetComponent | null;
  promptTemplate: string | null;
}

interface ToolRegistry {
  tools: Map<string, RegisteredTool>;   // keyed by manifest.name
  commands: Map<string, RegisteredTool>; // keyed by manifest.command
}
```

**Discovery flow:**

1. On `projectOpen` or `projectReopenLast`, call `projectListTree()`.
2. Filter for `tools/*/tool.json` entries.
3. For each, call `projectReadFile("tools/<name>/tool.json")` and parse.
4. Validate manifest (unique name, no command collision, valid surfaces).
5. Optionally load `logic.ts` and `widget.tsx` through the runtime loader (see section 7).
6. Store in registry. Expose via React context so all surfaces can query it.

### 6.2 Slash command integration (modify `RendererPanel.tsx`)

Currently, `PIPELINE_COMMANDS` is a static dict at module scope. The change:

```typescript
// Before: static dict
const PIPELINE_COMMANDS: Record<string, { op: PipelineOp; ... }> = { ... };

// After: built-in commands stay static, tool commands come from registry
function useCombinedCommands(toolRegistry: ToolRegistry) {
  return useMemo(() => {
    const combined = new Map(Object.entries(PIPELINE_COMMANDS));
    for (const [cmd, tool] of toolRegistry.commands) {
      combined.set(cmd, {
        op: "tool" as PipelineOp,  // new pipeline op type
        label: tool.manifest.display,
        requiresChapter: tool.manifest.inputs.chapter === "current",
        toolName: tool.manifest.name,
      });
    }
    return combined;
  }, [toolRegistry]);
}
```

The `handleSend` function gains a new branch after pipeline commands:

```typescript
// In handleSend, after the existing pipeline command check:
if (pipelineCmd?.op === "tool") {
  await runToolCommand(pipelineCmd.toolName, chapterNum);
  return;
}
```

### 6.3 Widget grid integration (modify `WidgetGrid.tsx`)

Currently hardcoded. The change:

```typescript
// After built-in widgets, render tool widgets dynamically
{toolRegistry.widgetTools.map((tool) => (
  <ToolWidgetSlot
    key={tool.manifest.name}
    tool={tool}
    chapterTitle={chapterTitle}
    isAnalyzing={isAnalyzing}
  />
))}
```

`ToolWidgetSlot` loads the widget component from the registry and passes `widgetData` from the most recent tool run.

### 6.4 Highlight layer integration (modify `HighlightLayer.tsx`)

Tools that return `highlights` in their `ToolResult` inject annotations into the existing highlight pipeline. The `HighlightLayer` already supports multiple annotation sources (speech, action, grammar, entity). Tool highlights become a new source:

```typescript
// New highlight source in HighlightLayer
const toolHighlights = useToolHighlights(chapterId);
// Merged with existing sources during render
```

Tool highlights use a distinct CSS class (`hl-tool-*`) with configurable severity colors (info=blue, warning=yellow, error=red) that sit alongside the existing speech/action/entity classes.

### 6.5 Overlay integration

Tools with `"surfaces": ["overlay"]` render via the existing `createPortal(... , document.body)` pattern used by `RendererWorkspaceFull` and `TimelineGraphFull`. The tool's `widget.tsx` exports an overlay component that receives `ToolOverlay` as a wrapper.

Opening is triggered by:
- The slash command (e.g., `/timeline` opens the timeline auditor overlay).
- A toolbar button (if the tool registers one in its manifest).
- The analysis panel (click on a tool widget card to expand).

---

## 7 — Runtime Module Loading

This is the hardest engineering decision. Tool `.ts` and `.tsx` files are user-generated code in the project directory. The app needs to execute them safely.

### Option A: Electron main-process transform (recommended)

1. When the app loads a tool, it sends `logic.ts` and `widget.tsx` to the main process via a new IPC channel (`tool:compile`).
2. Main process uses `esbuild.transform()` (already a dev dependency via Vite) to transpile TypeScript to JavaScript.
3. The transpiled code is returned to the renderer as a string.
4. The renderer evaluates it in a **restricted scope** — a `Function` constructor with only the baseline kit and `ToolContext` in scope. No `window`, `document`, `fetch`, `require`, `process`.

```javascript
// In main process (new handler in a tool-loader.cjs):
const esbuild = require('esbuild');

ipcMain.handle('tool:compile', async (_event, { code, format }) => {
  const result = await esbuild.transform(code, {
    loader: format === 'tsx' ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
  });
  return { ok: true, code: result.code };
});
```

```typescript
// In renderer (tool-registry.ts):
async function loadToolLogic(toolDir: string): Promise<ToolLogicModule | null> {
  const source = await readProjectFile(`${toolDir}/logic.ts`);
  if (!source) return null;

  const compiled = await window.electronAPI.toolCompile({
    code: source,
    format: 'ts',
  });
  if (!compiled.ok) return null;

  // Restricted evaluation — no globals except what we pass in
  const factory = new Function(
    'exports', 'ToolContext',
    `"use strict";\n${compiled.code}\nreturn exports;`
  );

  const exports = {};
  factory(exports, {});
  return exports as ToolLogicModule;
}
```

### Option B: Pre-compiled tools (simpler, less flexible)

Tools ship as pre-compiled `.js` files rather than `.ts` source. The agent generates JavaScript directly. This avoids the runtime transpiler but means the agent must output valid JS, and users editing tools must write JS not TS.

### Option C: Prompt-only tools (no code execution)

The simplest approach: tools have NO logic module. They only have `tool.json` + `prompt.md`. All tool logic runs through Claude. This eliminates the runtime loader entirely but makes every tool invocation cost API tokens and take 5-30 seconds.

### Recommendation

Start with **Option C** (prompt-only) for the initial implementation. It requires zero runtime loading infrastructure — just template resolution and the existing `claudeStream` path. Then add **Option A** as a second phase for tools that need instant local results.

---

## 8 — Tool Execution Pipeline

When the user runs a tool (via slash command, widget interaction, or direct chat):

```
User types /timeline
       │
       ▼
RendererPanel.handleSend()
       │
       ├─ Resolve tool from registry by command
       │
       ▼
toolRunner.execute(tool, context)
       │
       ├─ 1. Build ToolContext from current app state
       │     (chapter, analysis, worldData, project files)
       │
       ├─ 2. Run logic.ts (if exists)
       │     ├─ Returns ToolResult with summary, widgetData, highlights
       │     └─ If chainClaude: true, continue to step 3
       │
       ├─ 3. Resolve prompt.md template variables
       │     ├─ Inject {{tool_context}} from logic result
       │     └─ Inject {{chapter_content}}, {{story_primary}}, etc.
       │
       ├─ 4. Send resolved prompt via claudeStream()
       │     ├─ Stream appears in renderer chat
       │     └─ Response saved to outputs.report path
       │
       ├─ 5. Update tool state in .renderer/tools/<name>.json
       │
       ├─ 6. Push widgetData to widget grid (triggers re-render)
       │
       └─ 7. Push highlights to highlight layer (if any)
```

### Error handling

- Logic module throws → show error in chat as system message, skip Claude phase.
- Prompt template has unresolvable variables → show warning listing missing variables.
- Claude stream fails → same handling as existing pipeline failures.
- Tool state save fails → warn but don't block.

---

## 9 — Agent Assembly Flow

When a writer asks for a new tool in the renderer chat:

### Step 1: Intent extraction

The agent reads the request and identifies:
- What data the tool needs (which project files, which analysis results).
- What output the writer expects (widget? report? highlights?).
- Whether local heuristics can handle it or Claude is needed.

### Step 2: Project context loading

The agent reads:
- `NOVEL_CONFIGURATION.md` — voice rules, chapter structure, eval dimensions.
- `*_STORY_PRIMARY.txt` — Section 0 (directives), Section 10 (chapter entries), character lists.
- `NAMING_REFERENCE.md` — proper nouns, aliases.
- Existing tools in `tools/` — to avoid duplication and learn the project's tooling patterns.

### Step 3: Package generation

The agent generates all files into `tools/<tool-name>/`:

1. `tool.json` — manifest with validated command name and surfaces.
2. `logic.ts` — local heuristic functions (if applicable).
3. `prompt.md` — Claude prompt template with appropriate variables.
4. `widget.tsx` — widget component using baseline kit (if widget surface requested).

### Step 4: Validation

Before finishing, the agent:
- Verifies `tool.json` passes manifest validation rules.
- Verifies the command doesn't collide with existing commands.
- Verifies `logic.ts` exports a `run` function with the correct signature.
- Verifies `widget.tsx` exports a default component.
- Verifies `prompt.md` variables all have known resolutions.

### Step 5: Registration

The app's file-change listener (`onClaudeFileChanged`) picks up the new files. On next workspace refresh or tool registry reload, the tool appears in:
- Slash command hints in the chat input.
- Widget grid (if surfaces include "widget").
- The renderer workspace file tree.

### Guard rails for agent assembly

- The agent MUST use the baseline component kit for widgets — no raw HTML/CSS.
- The agent MUST NOT generate tools that read files outside the project directory.
- The agent MUST declare `estimatedTokens` honestly in the manifest.
- The agent MUST set `"edited": false` on newly generated tools.
- If a tool with the same name exists and `"edited": true`, the agent MUST ask before overwriting.

---

## 10 — Tool Suggestions by Category

### Tier 1 — Local heuristics, zero Claude cost

| Tool | Command | What it does | Key benefit |
|---|---|---|---|
| **Timeline Auditor** | `/timeline` | Extracts temporal references, cross-references story primary, flags arithmetic conflicts | Catches the #1 lore-check failure automatically |
| **Name Scanner** | `/names` | Diffs chapter nouns against NAMING_REFERENCE.md, flags variants and missing entries | Prevents spelling drift across 170+ chapters |
| **Thread Tracker** | `/threads` | Tracks open thread status, dormancy, resolution from story primary Section 8 | Thread management is the hardest long-form skill |
| **Beat Coverage** | `/beats` | Compares Section 10 required beats against draft content | Catches "I thought I wrote that" drift |
| **Scene Pressure** | `/pressure` | Per scene: entry stakes, exit stakes, what changed | Catches zero-change scenes before eval |

### Tier 2 — Uses existing analysis modules

| Tool | Command | What it does | Key benefit |
|---|---|---|---|
| **Voice Drift** | `/voice-check` | Compares current voice profile against baseline chapters | Catches the subtlest form of AI fingerprint |
| **Motif Map** | `/motifs` | Scans chapters for motif occurrences from Section 9 | Catches clustering and vanishing motifs |
| **Dialogue Audit** | `/dialogue-audit` | Uses speech-detect to measure tag variety, speaker balance, attribution clarity per scene | Catches "talking heads" and tag monotony |

### Tier 3 — Claude-powered, deeper analysis

| Tool | Command | What it does | Key benefit |
|---|---|---|---|
| **Knowledge Tracker** | `/knowledge` | Per character: what they know at each boundary, how they learned it | Automates the hardest lore check |
| **Reveal Tracker** | `/reveals` | Tracks setup-payoff chains, scheduled reveals, premature disclosures | Protects tension in controlled-information novels |
| **Comparative Export** | `/export-variant` | Generates submission formats: synopsis, query excerpt, pitch | Writers need 4-5 output formats |

### Project-specific tools (agent-assembled)

These are examples of tools the agent would create on demand:

| Request | Generated tool |
|---|---|
| "Track which characters know about the conspiracy" | `conspiracy-tracker/` — reads character lists + chapter text, builds knowledge matrix for the specific plot thread |
| "Show me every scene where Rin and Sora are alone" | `copresence-filter/` — uses world-data name resolver + scene break detection to find 2-character scenes |
| "Flag anywhere I accidentally used a modern word" | `anachronism-scanner/` — custom word list from NOVEL_CONFIGURATION.md era constraints, scans chapter text |
| "Compare my chapter pacing against the first arc" | `arc-pacing-compare/` — uses existing chapter-analysis to build pacing profiles, overlays current vs. baseline arc |

---

## 11 — Implementation Phases

### Phase 1: Foundation (manifest + prompt-only tools) — COMPLETE ✓

**Scope:** Tool discovery, manifest validation, slash command registration, prompt template resolution, cross-project tool import. No runtime code loading.

**Files created:**
- `src/lib/tool-registry.ts` — manifest parsing, validation, registry state. Supports `skipPrompts` option for lightweight widget-only scans.
- `src/lib/tool-runner.ts` — prompt template resolution with `{{variable}}` system, tool context building, `prepareToolRun()` for Claude invocation.
- `src/tools/tool-kit.ts` — barrel re-exporting all 18 primitives + 57 curated lucide icons.
- `src/tools/primitives/` — 18 primitive components: ToolCard, ToolButton, ToolBadge, ToolToggle, ToolRange, ToolPillGroup, ToolTabBar, ToolSectionLabel, ToolDataRow, ToolDataTable, ToolSparkline, ToolProgressRing, ToolDialRing, ToolArcRing, ToolHeatmap, ToolOverlay, ToolSidePanel, ToolIcons.
- `src/components/ToolImportOverlay.tsx` — glass overlay for cross-project tool import (checkbox selection, conflict badges, rename-on-conflict).

**Files modified:**
- `RendererPanel.tsx` — tool registry loading (useEffect keyed on project+pref), tool command branch in `handleSend()`, tool commands in autocomplete hints.
- `AnalysisPanel.tsx` — settings panel "Advanced" section with custom tools toggle + import button.
- `project-fs.cjs` — `tools/` in STRUCTURE, `ensureToolSdk()` for TOOL_SDK.md + TOOL_DESIGN.md auto-deploy, `tool:scanProject` and `tool:importTools` IPC handlers with path traversal validation.
- `preload.cjs` — `toolScanProject`, `toolImportTools` bridges.
- `project-manager.ts` — `ToolScanEntry`, `ToolScanResult`, `ToolImportResult` types, `scanExternalProject()` and `importTools()` helpers.
- `preferences.ts` — `customToolsEnabled` preference (default false).
- `App.tsx` — `handleImportTools` + `handleImportToolsConfirm` handlers, ToolImportOverlay rendering, `onImportTools` prop wired to AnalysisPanel.
- `styles.css` — tool overlay/panel CSS, import overlay CSS, settings button CSS.

**Diagnosis applied:**
- Fixed `findAndReadStoryPrimary` unsafe cast → `listTree` declared as optional on `ProjectReader` interface.
- Fixed RendererPanel tool command reader missing `listTree` method.
- Added `dirName`/`targetName` path traversal validation (`..`, `/`) on `tool:importTools`.

**Deliverable:** Writer creates `tools/my-tool/` with `tool.json` + `prompt.md`, invokes via `/my-tool` in chat. Tools importable from other projects via Settings → Import Tools.

### Phase 2: Baseline UI kit + widget surface — COMPLETE ✓

**Scope:** Runtime module loading via esbuild transform. Tools with `widget.tsx` render in the analysis panel widget grid. Code-split for zero cost when no tools are active.

**Files created:**
- `src/components/widgets/ToolWidgetSlot.tsx` — compiles `widget.tsx` via `tool:compile` IPC, evaluates in restricted scope (`new Function` + custom `require` mapping `glass-editor/tool-kit`, `react`, `react/jsx-runtime`), renders resulting component. Keyed on `dirPath@version` for recompilation on tool updates.

**Files modified:**
- `project-fs.cjs` — `tool:compile` IPC handler using `esbuild.transform()` with CJS format, `jsx: 'automatic'`.
- `preload.cjs` — `toolCompile` bridge.
- `project-manager.ts` — `toolCompile` type on ElectronAPI.
- `AnalysisPanel.tsx` — independent tool registry loading (`skipPrompts: true`), lazy-loaded ToolWidgetSlot rendering after built-in widgets.
- `tool-registry.ts` — `skipPrompts` option to `buildToolRegistry()`.
- `styles.css` — `.wg-tool-error` styling for failed widget compilation.

**Diagnosis applied:**
- PERF: Lazy-loaded ToolWidgetSlot via `React.lazy()` — 19.88KB code-split chunk loaded only when tool widgets render. Main bundle grew only 1.5KB over pre-tool baseline.
- PERF: `skipPrompts` option eliminates unnecessary prompt.md reads for AnalysisPanel's widget-only scan.
- BUG: Replaced `compiledRef` one-shot guard with `toolKey` (dirPath@version) for recompilation on tool updates, with proper cancellation cleanup.
- BUG: AnalysisPanel registry uses `projectGetPath()` dedup ref + `chapterId` dependency to detect project changes without expensive rescans on chapter navigation.

**Bundle impact:** Main JS: +1.5KB. Lazy chunk: 19.88KB (loaded on demand). CSS: +0.4KB.

**Deliverable:** Tools with `widget.tsx` render in the analysis panel. esbuild compiles TSX at runtime. Module map provides `glass-editor/tool-kit`, `react`, and `react/jsx-runtime` to compiled widgets.

### Phase 3: Local logic + highlight integration ✅ COMPLETE

**Scope:** Tools can ship `logic.ts` for instant local results. Highlight layer accepts tool annotations.

**Files modified:**
- `tool-runner.ts` — added `ToolHighlight`, `ToolLogicContext`, `ToolLogicResult` types; `evaluateLogicModule()` restricted-scope eval (shadows window/document/fetch/process/globalThis/self); `executeToolLogic()` with 5-second timeout; `resolvePromptTemplate()`, `buildToolPrompt()`, `prepareToolRun()` now accept optional `toolContext` for logic→Claude chaining.
- `HighlightLayer.tsx` — added `toolHighlights` prop (absolute offsets like grammar); `"tool"` Deco kind with priority grammar > tool > entity; tool spans render as `<span className="hl-tool hl-tool--{severity}">` with hover label via `data-label`; `sliceToolHighlights()` and `clipToolHighlights()` for paragraph/segment slicing pipeline.
- `Editor.tsx` — `toolHighlights` prop pass-through to HighlightLayer.
- `App.tsx` — `toolHighlights` state; `handleToolHighlights` callback; cleared on project load; passed to Editor; `onToolHighlights` forwarded to AnalysisPanel.
- `AnalysisPanel.tsx` — `onToolHighlights` prop forwarded to RendererPanel; `toolWidgetData` Map state for logic→widget data flow; ToolWidgetSlots now receive real widget data from logic results.
- `RendererPanel.tsx` — tool command handler rewritten as two-phase: Phase A (logic) compiles + evals `logic.ts`, displays summary, fires highlights + widget data callbacks, conditionally chains; Phase B (Claude) resolves prompt with `claudeContext` injection, streams. Three tool modes: logic-only, prompt-only, logic→Claude chain.
- `styles.css` — `.hl-tool` with severity variants (info=blue underline, warning=yellow wavy, error=red wavy); hover-reveal label tooltip via `::after` pseudo-element.

**Bundle impact:** 0 KB main bundle increase (logic execution lives in tool-runner.ts, already bundled). ToolWidgetSlot chunk unchanged at 19.88 KB.

**Diagnosis notes:**
- Logic module sandbox: `new Function` with 7 globals shadowed as `undefined` (window, document, fetch, XMLHttpRequest, process, globalThis, self). `require()` throws — logic modules receive all data through ToolLogicContext parameter.
- Timeout: `Promise.race` with 5-second deadline prevents runaway logic modules.
- Widget data flow: RendererPanel → AnalysisPanel (local state) → ToolWidgetSlot. No prop drilling through App.
- Highlight data flow: RendererPanel → AnalysisPanel → App (state) → Editor → HighlightLayer. Cleared on project switch.
- Deco priority: grammar suggestions always win overlap ties, then tool highlights, then entity names.

**Deliverable:** Full tool pipeline: local logic (instant) → optional Claude chain (deep) → widget + highlights + report.

### Phase 4: Agent assembly + overlay surface ✓ COMPLETE

**Scope:** The renderer chat agent can generate complete tool packages on demand. Overlay surface for full-screen tool views. Sidebar surface integration.

**Files modified:**
- `src/components/RendererPanel.tsx` — `toolRefreshToken` state; `onFileChanged` detects `tools/` path changes and increments token; token added to registry useEffect deps for auto-reload.
- `src/lib/tool-registry.ts` — added `overlayTools: RegisteredTool[]` to ToolRegistry interface, EMPTY_REGISTRY, and buildToolRegistry output.
- `src/components/Icon.tsx` — added 15 icons (Target, Search, Clock, AlertTriangle, Hash, Tag, Zap, BarChart2, Globe, Heart, Star, Filter, Link, Puzzle + imports); `TOOL_ICON_MAP` (27 entries); exported `resolveToolIcon(name): React.FC<P>` with PuzzleIcon fallback.
- `src/components/AnalysisPanel.tsx` — sidebar tool tab buttons between action group and system tabs; sidebar drawer content rendering via ToolWidgetSlot in Suspense; overlay tool ToolWidgetSlot rendering (portal to body via ToolOverlay); view state type widened to `string | null` to support `sidebar:${toolName}` keys.

**Deliverable:** Writer says "I need a tool that..." → agent creates tool package → registry auto-reloads → tool appears in sidebar/overlay/widget immediately. No app restart needed.

**Bundle:** ToolWidgetSlot chunk = 16.56 kB (gzip 5.95 kB). No main bundle increase. Icons add ~2 kB to main chunk (tree-shaken).

---

## 12 — Security Boundaries

### Filesystem

- Tools are project-scoped. The existing project-boundary hook (`latent-write-project-boundary.cjs`) already blocks writes outside the project directory. Tool code inherits this constraint.
- Tool manifests are validated on load: `inputs.files` patterns cannot escape the project root.

### Code execution

- Logic modules run in a restricted scope. No `window`, `document`, `fetch`, `require`, `process`.
- Widget modules render through React — no raw DOM manipulation.
- The app wraps all tool execution in try/catch with a 5-second timeout.
- Tool code is transpiled by esbuild (not `eval`ed raw) — syntax errors are caught at compile time.

### Claude operations

- Tool prompts go through the same `claudeStream` path as all renderer operations.
- The same session boundary and cancellation controls apply.
- `estimatedTokens` in the manifest lets the UI warn before expensive operations.

### Overwrite protection

- Tools with `"edited": true` in their manifest are protected from agent overwrite.
- The agent must ask before regenerating a manually edited tool.
- Tool directories can be deleted manually or via a `/tool-remove <name>` command.

---

## 13 — Tool Portability: Cross-Project Import

Writers working on multiple novels will build useful tools for one project and want them in another. Rather than a shared-tools directory (which creates version coupling between projects), the app provides a one-click import that copies tool packages from an existing project into the current one. Tools remain fully independent per project after import — edits to the imported copy don't affect the source.

### 13.1 User flow

1. User opens **Settings panel** in the current project.
2. Clicks **"Import Tools from Project"** button.
3. OS directory picker opens — user navigates to the source project folder and selects it.
4. App scans `tools/*/tool.json` in the selected directory, reads each manifest.
5. An **Import Tools overlay** appears listing discovered tools — each row shows: tool name, description, version, surfaces (icons), and whether a tool with the same name already exists in the current project (conflict indicator).
6. User selects which tools to import via checkboxes.
7. User clicks **Import** — the app copies each selected tool directory into the current project's `tools/`.
8. Tool registry reloads — imported tools appear as slash commands, widgets, etc.

### 13.2 Validation on scan

When the app reads manifests from the source project, it validates each before showing it in the selection list:

- Manifest must pass the same validation rules as local tools (§2).
- If the manifest references `inputs.files` patterns that don't exist in the **current** project, show a warning badge: "May require project files not present here" — but don't block import, since the writer may create those files later.
- If the tool uses Claude (`requiresClaude: true`), no special handling — the prompt template is portable because `{{variables}}` resolve against the current project's files at runtime.

### 13.3 Conflict resolution

When an imported tool has the same `name` as an existing tool in the current project:

| Scenario | Behavior |
|---|---|
| Existing tool has `"edited": false` | Show "Replace" option — agent-generated tool can be overwritten safely |
| Existing tool has `"edited": true` | Show warning: "You have manual edits in this tool." Options: **Skip** (don't import), **Replace** (overwrite — warns again), **Import as copy** (renames to `{name}-imported`, adjusts manifest `name` and `command` with `-imported` suffix) |
| No conflict | Import directly |

The overlay shows conflict status per row so the user can make per-tool decisions before clicking Import.

### 13.4 Electron main process — new IPC handlers

Two new handlers in `project-fs.cjs`:

#### `tool:scanProject` — scan an external project for tools

```javascript
// Handler: receives no args (triggers directory picker), returns tool manifests
ipcMain.handle('tool:scanProject', async () => {
  // Reuse the same dialog pattern as project:open
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Select Project to Import Tools From',
    properties: ['openDirectory'],
    buttonLabel: 'Select Project',
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  const sourcePath = filePaths[0];
  const toolsDir = path.join(sourcePath, 'tools');

  if (!fs.existsSync(toolsDir)) {
    return { ok: true, sourcePath, tools: [] };
  }

  const tools = [];
  const entries = fs.readdirSync(toolsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(toolsDir, entry.name, 'tool.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Include which files the tool directory contains (for size preview)
      const toolFiles = fs.readdirSync(path.join(toolsDir, entry.name));
      tools.push({
        dirName: entry.name,
        manifest,
        files: toolFiles,
        hasLogic: toolFiles.includes('logic.ts'),
        hasWidget: toolFiles.includes('widget.tsx'),
        hasPrompt: toolFiles.includes('prompt.md'),
      });
    } catch {
      // Skip tools with invalid manifests
    }
  }

  return { ok: true, sourcePath, tools };
});
```

#### `tool:importTools` — copy selected tools into current project

```javascript
// Handler: receives source path + array of tool import descriptors
ipcMain.handle('tool:importTools', async (_event, { sourcePath, imports }) => {
  // imports: Array<{ dirName: string, targetName?: string }>
  // targetName is set when "Import as copy" renames the tool
  if (!_openProjectPath) return { ok: false, error: 'No project open' };

  const results = [];
  const targetToolsDir = path.join(_openProjectPath, 'tools');
  if (!fs.existsSync(targetToolsDir)) {
    fs.mkdirSync(targetToolsDir, { recursive: true });
  }

  for (const imp of imports) {
    const srcDir = path.join(sourcePath, 'tools', imp.dirName);
    const targetDirName = imp.targetName || imp.dirName;
    const dstDir = path.join(targetToolsDir, targetDirName);

    try {
      // copyRecursiveSync already exists in project-fs.cjs
      copyRecursiveSync(srcDir, dstDir);

      // If renamed, patch the manifest
      if (imp.targetName && imp.targetName !== imp.dirName) {
        const manifestPath = path.join(dstDir, 'tool.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.name = imp.targetName;
        if (manifest.command) {
          manifest.command = `/${imp.targetName}`;
        }
        manifest.edited = false; // imported copy starts as unedited
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }

      results.push({ dirName: targetDirName, ok: true });
    } catch (err) {
      results.push({ dirName: targetDirName, ok: false, error: err.message });
    }
  }

  return { ok: true, results };
});
```

### 13.5 Preload bridge additions

```javascript
// In preload.cjs — add to the contextBridge.exposeInMainWorld block:
toolScanProject:  ()           => ipcRenderer.invoke('tool:scanProject'),
toolImportTools:  (opts)       => ipcRenderer.invoke('tool:importTools', opts),
```

### 13.6 Renderer type additions

```typescript
// In project-manager.ts — add to ElectronAPI interface:

interface ToolScanResult {
  ok: boolean;
  canceled?: boolean;
  sourcePath?: string;
  tools?: Array<{
    dirName: string;
    manifest: ToolManifest;
    files: string[];
    hasLogic: boolean;
    hasWidget: boolean;
    hasPrompt: boolean;
  }>;
}

interface ToolImportRequest {
  sourcePath: string;
  imports: Array<{
    dirName: string;
    targetName?: string; // set when renaming on conflict
  }>;
}

interface ToolImportResult {
  ok: boolean;
  results?: Array<{
    dirName: string;
    ok: boolean;
    error?: string;
  }>;
}

// On ElectronAPI:
toolScanProject: () => Promise<ToolScanResult>;
toolImportTools: (opts: ToolImportRequest) => Promise<ToolImportResult>;
```

### 13.7 Renderer helper functions

```typescript
// In a new file: src/lib/tool-import.ts
// or added to tool-registry.ts once that exists

export async function scanExternalProject(): Promise<ToolScanResult> {
  const a = api();
  if (!a) return { ok: false };
  return a.toolScanProject();
}

export async function importTools(
  sourcePath: string,
  imports: Array<{ dirName: string; targetName?: string }>,
): Promise<ToolImportResult> {
  const a = api();
  if (!a) return { ok: false };
  return a.toolImportTools({ sourcePath, imports });
}
```

### 13.8 Import Tools overlay UI

The overlay follows the same visual pattern as `WidgetConfigOverlay` (glass panel, portal to body, escape to close):

```
┌─────────────────────────────────────────────────┐
│  Import Tools                              [✕]  │
│  from: ~/Documents/MyFirstNovel                 │
│─────────────────────────────────────────────────│
│                                                 │
│  ☑  Timeline Auditor        v1.0.0              │
│     Verify temporal references  ·  chat widget  │
│                                                 │
│  ☑  Name Scanner            v1.0.0              │
│     Diff nouns vs naming ref  ·  chat highlight  │
│                                                 │
│  ☐  Thread Tracker          v1.2.0  ⚠ EXISTS    │
│     Track open threads  ·  chat widget           │
│     ↳ You have manual edits. Skip / Replace /   │
│       Import as "thread-tracker-imported"        │
│                                                 │
│  ☑  Conspiracy Tracker      v1.0.0              │
│     Knowledge matrix for plot thread  ·  widget  │
│     ⚠ Uses files: *_STORY_PRIMARY.txt           │
│                                                 │
│─────────────────────────────────────────────────│
│                         Cancel    Import (3)    │
└─────────────────────────────────────────────────┘
```

Component: `src/components/ToolImportOverlay.tsx`

Uses baseline UI primitives:
- Same `.wc-overlay` / `.wc-panel` glass backdrop as WidgetConfigOverlay
- Custom checkboxes (same pattern as widget config)
- Surface icons (chat, widget, overlay, highlight) as small pills
- Conflict badges using the `ToolBadge` pattern (yellow "EXISTS" pill)
- Footer: Cancel + Import (shows selected count)

### 13.9 Settings panel integration

The Import Tools button lives in the Settings panel alongside other project-level actions. It is only visible when:
- Running in Electron (desktop app) — `isDesktopApp()` returns true
- A project is currently open

```tsx
// In the settings panel component:
{isDesktopApp() && projectPath && (
  <button
    type="button"
    className="settings-action-btn"
    onClick={handleImportTools}
  >
    Import Tools from Project
  </button>
)}
```

The button click triggers:
1. `scanExternalProject()` — opens directory picker and returns manifests.
2. If tools found → open `ToolImportOverlay` with the scan results.
3. If no tools found → show inline message: "No tools found in the selected project."
4. If canceled → do nothing.

### 13.10 Post-import actions

After import completes:

1. **Reload tool registry** — call the registry's refresh method so newly imported tools are immediately available as slash commands and widgets.
2. **Show summary toast** — "Imported 3 tools: Timeline Auditor, Name Scanner, Conspiracy Tracker"
3. **Close the overlay** automatically on success.
4. **If any imports failed** — keep the overlay open, show error per tool, let the user retry or dismiss.

### 13.11 Edge cases

| Case | Handling |
|---|---|
| Source directory has no `tools/` folder | Show "No tools found in this project" — don't error |
| Source directory is the current project | Detect path match, show "Cannot import from the current project" |
| Source tool's `logic.ts` imports from project-specific paths | Logic modules use `ToolContext` for data, not direct imports — portable by design |
| Source tool's `prompt.md` uses `{{file:specific-file.md}}` | The variable resolves at runtime in the current project — if the file doesn't exist, the variable resolves to empty string with a warning. The scan overlay flags this (§13.2) |
| User selects a non-project directory (no `.renderer/`, no `tools/`) | Returns empty tool list — same as "no tools found" |
| Tool directory contains unexpected files beyond the standard 4 | `copyRecursiveSync` copies everything in the tool directory — custom reference files, data files, etc. are preserved |
| Disk space insufficient | `copyRecursiveSync` will throw — caught by the try/catch in `tool:importTools`, reported as per-tool error |

### 13.12 Implementation phase

This feature slots into **Phase 1** (§11) since it only requires manifest reading and file copying — no runtime code loading. The IPC handlers reuse existing patterns (`dialog.showOpenDialog`, `copyRecursiveSync`, `ipcMain.handle`). The overlay UI reuses existing glass panel patterns.

**Files to create:**
- `src/components/ToolImportOverlay.tsx` — import selection UI
- `src/lib/tool-import.ts` — renderer-side import helpers (or fold into `tool-registry.ts`)

**Files to modify:**
- `electron/project-fs.cjs` — add `tool:scanProject` and `tool:importTools` IPC handlers
- `electron/preload.cjs` — expose `toolScanProject` and `toolImportTools`
- `src/lib/project-manager.ts` — add types and wrapper functions to `ElectronAPI`
- Settings panel component — add "Import Tools from Project" button

---

## 15 — Tool SDK: Exposed API & Agent Instruction Delivery

### Design principle

The agent should **never search the codebase** to build tool UI. Instead, the app exposes a self-contained SDK — a barrel module of pre-made primitives, a curated icon set, and a comprehensive instruction document deployed into the project directory. The agent reads one file (`tools/TOOL_SDK.md`), gets everything it needs, and assembles tools without touching internal app code.

Three layers make this work:
1. **Runtime layer** — the `tool-kit` barrel module injected into tool scope at load time.
2. **Instruction layer** — `TOOL_SDK.md` auto-deployed to every project, referenced by a one-line pointer in `CLAUDE.md`.
3. **Gate layer** — a settings toggle that must be enabled before tools load.

---

### 15.1 — The tool-kit barrel module

A single file (`src/tools/tool-kit.ts`) re-exports every primitive available to tool code. This is the **only import surface** tools see — they never import from internal app paths.

```typescript
// src/tools/tool-kit.ts — injected into tool scope at load time
// Tools import as: import { ToolCard, ToolButton, ... } from "glass-editor/tool-kit";

// ── Layout ──────────────────────────────────────────────────────────────
export { ToolCard } from "./primitives/ToolCard";
export { ToolOverlay } from "./primitives/ToolOverlay";
export { ToolSidePanel } from "./primitives/ToolSidePanel";

// ── Controls ────────────────────────────────────────────────────────────
export { ToolButton } from "./primitives/ToolButton";
export { ToolToggle } from "./primitives/ToolToggle";
export { ToolRange } from "./primitives/ToolRange";
export { ToolPillGroup } from "./primitives/ToolPillGroup";
export { ToolTabBar } from "./primitives/ToolTabBar";
export { ToolSectionLabel } from "./primitives/ToolSectionLabel";

// ── Data Display ────────────────────────────────────────────────────────
export { ToolBadge } from "./primitives/ToolBadge";
export { ToolDataRow } from "./primitives/ToolDataRow";
export { ToolDataTable } from "./primitives/ToolDataTable";

// ── Charts ──────────────────────────────────────────────────────────────
export { ToolSparkline } from "./primitives/ToolSparkline";
export { ToolProgressRing } from "./primitives/ToolProgressRing";
export { ToolDialRing } from "./primitives/ToolDialRing";
export { ToolArcRing } from "./primitives/ToolArcRing";
export { ToolHeatmap } from "./primitives/ToolHeatmap";

// ── Icons (curated subset of lucide-react) ──────────────────────────────
export {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  BarChart2, BookOpen, Brain, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, Clock, Copy, Download, Edit3,
  ExternalLink, Eye, EyeOff, FileText, Filter, Flag, FolderOpen,
  Globe, Hash, Heart, HelpCircle, Image, Info, Layers, Link,
  List, MapPin, Maximize2, MessageSquare, Minus, MoreHorizontal,
  PenTool, Plus, RefreshCw, Search, Settings, Shuffle, Sparkles,
  Star, Tag, Target, Trash2, TrendingDown, TrendingUp, Type,
  Upload, User, Users, Wand2, X, Zap,
} from "./primitives/ToolIcons";
```

#### Icon surface implementation

`src/tools/primitives/ToolIcons.tsx` re-exports lucide-react icons through the same `wrap()` pattern used in `Icon.tsx` (1.8px stroke, round caps, default size 18). The curated list (~55 icons) covers common tool needs. The icons are tree-shaken — unused icons add zero bundle cost.

```typescript
// src/tools/primitives/ToolIcons.tsx
import type { LucideProps } from "lucide-react";
// Re-import from lucide-react, wrap identically to Icon.tsx
import { AlertTriangle as _AT, ArrowDown as _AD, /* ... */ } from "lucide-react";

type P = Omit<LucideProps, "size"> & { size?: number };
const wrap = (Icon: React.FC<LucideProps>) =>
  ({ size = 18, ...p }: P) => <Icon size={size} strokeWidth={1.8} {...p} />;

export const AlertTriangle = wrap(_AT);
export const ArrowDown = wrap(_AD);
// ... all curated icons
```

**Why curate instead of exposing all 1,200+ lucide icons?**
- Tree-shaking requires static imports. Dynamic `import("lucide-react")[iconName]` defeats it.
- 55 icons covers widget, overlay, tab, and status display needs.
- The agent's instruction doc lists exactly which icons exist — no guessing, no failed imports.
- Expanding the set is a one-line addition to `ToolIcons.tsx`.

#### Performance isolation

The tool-kit barrel has **near-zero cost** when no tools are loaded:
- `ToolWidgetSlot` is lazy-loaded via `React.lazy()` — the 19.88KB chunk (ToolKit + icons + primitives) only downloads when a widget tool actually renders.
- Main bundle impact: +1.5KB (the lazy import reference + AnalysisPanel registry loading logic).
- When `customToolsEnabled` is false (default), no tool code runs at all — the registry returns `EMPTY_REGISTRY` and no IPC calls are made.
- CSS for tool primitives uses the existing design system tokens (no new stylesheet).

When tools ARE loaded, they use the same React reconciler as the rest of the app. No iframe, no shadow DOM, no separate React root. This means tools get the same animation performance, shared state context (chapter data, analysis results), and glass rendering pipeline.

---

### 15.2 — Tool surface types

The agent can create tools that render into four surfaces. Each surface has a matching primitive from the tool-kit:

| Surface | Manifest value | Primitive | Where it appears |
|---|---|---|---|
| Slash command + chat output | `"chat"` | (none — text output) | Renderer chat panel |
| Widget card | `"widget"` | `ToolCard` | Analysis panel widget grid |
| Side panel tab | `"sidebar"` | `ToolSidePanel` | New button in analysis tab column → own drawer |
| Full-screen overlay | `"overlay"` | `ToolOverlay` | Portal to body, escape-to-close |

#### Sidebar surface — analysis tab integration (NEW)

Tools with `"surfaces": ["sidebar"]` get a button in the analysis panel's tab column (the vertical strip on the right edge). Clicking it opens the tool's panel in the analysis drawer, alongside the existing widgets/graph/renderer/settings views.

**Manifest extension:**

```jsonc
{
  "surfaces": ["sidebar"],
  "sidebar": {
    "icon": "Target",        // lucide icon name from the curated set
    "position": "before-settings",  // "top" | "before-settings" | "after-settings"
    "width": "default"       // "default" (320px) | "wide" (480px)
  }
}
```

**Analysis panel modification** (`AnalysisPanel.tsx`):

The tab column currently has 4 static buttons. With tools, it becomes:

```
  [◁]           ← widgets tab (existing)
  [¶] [≡]       ← action buttons (existing)
  ─────────────
  [⊙]           ← tool: "Target" icon from manifest
  [⦿]           ← tool: another tool's icon
  ─────────────
  [⊞]           ← graph (existing)
  [✦]           ← renderer (existing)
  [⚙]           ← settings (existing)
```

Tool tabs appear between the action group and the system tabs. Each tool tab follows the same `analysis-tab` CSS pattern — active state with `analysis-tab--active`, working state with `analysis-tab--working` pulse.

**ToolSidePanel primitive:**

```typescript
interface ToolSidePanelProps {
  title: string;
  onClose?: () => void;      // optional — closes by clicking tab again
  toolbar?: ReactNode;       // optional header actions (filter, refresh)
  children: ReactNode;
}
export function ToolSidePanel(props: ToolSidePanelProps): JSX.Element;
```

Renders inside the analysis drawer area. Scrollable. Uses the same glass styling as the settings panel interior — `--bg-glass-strong` background, `.settings-section-label` typography for headers, same padding/gap rhythm.

---

### 15.3 — Settings gate: Custom Tools toggle

Custom tools are gated behind an advanced settings toggle. This serves three purposes:
1. **Default safety** — new users don't accidentally load untested tool code.
2. **Agent guardrail** — when disabled, the agent's instructions tell it to advise enabling the toggle before creating tools.
3. **Clean UX** — no tool-related UI (sidebar tabs, widget slots, command hints) appears until opt-in.

#### Preferences change

```typescript
// In preferences.ts — add to Preferences interface:
customToolsEnabled?: boolean;

// In DEFAULTS:
customToolsEnabled: false,

// In loadPrefs():
customToolsEnabled: p.customToolsEnabled ?? false,
```

#### Settings panel UI

Appears in the settings panel as an "Advanced" section (below existing settings):

```
── Advanced ──────────────────────────
Custom Tool Plugins        [  ○  ]
Load custom tools from this project's
tools/ directory. Requires app restart.
```

Uses the existing `settings-toggle-row` + `GlassToggle` pattern. Description text in `settings-desc` style.

When toggled ON for the first time, a confirmation inline appears: "Custom tools execute code from your project's tools/ directory. Only enable this for projects you trust." with a "Got it" dismiss.

#### Gate enforcement

```typescript
// In tool-registry.ts:
export function buildToolRegistry(projectPath: string, enabled: boolean): ToolRegistry {
  if (!enabled) return EMPTY_REGISTRY;
  // ... scan tools/ directory, validate manifests, load modules
}

// In RendererPanel.tsx — useCombinedCommands:
function useCombinedCommands(toolRegistry: ToolRegistry) {
  // When registry is empty (disabled), combined === PIPELINE_COMMANDS only
}

// In AnalysisPanel.tsx — tool tabs:
// When registry is empty, no tool tabs render
```

**Agent warning (in TOOL_SDK.md):**

> Before creating tools, check if custom tools are enabled. If `tools/` directory exists but no tool commands are recognized, advise the user: "Custom tool plugins are currently disabled. Enable them in Settings → Advanced → Custom Tool Plugins, then restart the app."

---

### 15.4 — Agent instruction delivery: TOOL_SDK.md

The CLAUDE.md stays lean — just a one-line pointer. The full tool-creation instructions live in a separate file deployed to the project.

#### CLAUDE.md addition

Add to `buildClaudeMdContent()` in `project-fs.cjs`, at the end (after the existing task classification section):

```markdown
## Custom Tools

This project supports custom per-project tools (slash commands, widgets, side panels, overlays). If the user asks to create, modify, or manage tools, **read `tools/TOOL_SDK.md` first** — it contains the complete component API, manifest format, and assembly instructions. Do not attempt tool creation without reading that file.

Custom tools must be enabled in Settings → Advanced → Custom Tool Plugins before they will load.
```

This adds ~40 tokens to CLAUDE.md — negligible.

#### TOOL_SDK.md contents

A bundled markdown file that comprehensively documents:

1. **Manifest schema** — complete `tool.json` format with every field, validation rules, and examples.
2. **Available surfaces** — chat, widget, sidebar, overlay — with example manifests for each.
3. **Component API** — every primitive from the tool-kit barrel: props interface, visual behavior, example usage.
4. **Icon catalogue** — complete list of available lucide icons by name.
5. **Design rules** — condensed version of §5A (color tokens, border technique, typography, animation).
6. **Template variables** — all `{{variables}}` available in `prompt.md`.
7. **ToolContext interface** — what data the `run()` function receives.
8. **ToolResult interface** — what the `run()` function returns.
9. **Guard rails** — what tools cannot do (no DOM, no fetch, no require, no outside-project files).
10. **Examples** — 2-3 complete tool packages showing different surface combinations.

**Estimated size:** ~800-1000 lines of markdown. The agent reads it only when the user requests tool creation — never on normal sessions. This keeps everyday CLAUDE.md context lean.

#### TOOL_SDK.md versioning

```javascript
// At top of the SDK content in project-fs.cjs:
const TOOL_SDK_VERSION = 2;  // bump on every SDK change
const TOOL_SDK_MARKER = `<!-- TOOL_SDK_V${TOOL_SDK_VERSION} -->`;

// Content includes the marker on line 1:
function buildToolSdkContent() {
  return `${TOOL_SDK_MARKER}
# Tool SDK — Latent Write Custom Tools
...
`;
}
```

The version marker allows `ensureToolSdk()` to detect stale versions and auto-update without overwriting user edits (since users don't edit this file — only the agent reads it).

---

### 15.5 — Auto-update for existing workspaces

The SDK doc and `tools/` directory must appear in existing projects automatically, not just new ones.

#### ensureProjectDirs extension

```javascript
// In project-fs.cjs — add 'tools' to the STRUCTURE constant:
const STRUCTURE = {
  // ... existing entries ...
  toolsDir: 'tools',
};

// In ensureProjectDirs — add to the dirs array:
function ensureProjectDirs(projectPath) {
  const dirs = [
    PROJECT_META_DIR,
    STRUCTURE.anchorsDir,
    STRUCTURE.draftsDir,
    STRUCTURE.canonDir,
    STRUCTURE.sceneBankDir,
    STRUCTURE.reviewLogsDir,
    STRUCTURE.tempDir,
    STRUCTURE.toolsDir,       // ← NEW
  ];
  for (const d of dirs) {
    const full = path.join(projectPath, d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }
  ensureSystemDir(projectPath);
  ensureToolSdk(projectPath);  // ← NEW
  ensureClaudeConfig(projectPath);
}
```

#### ensureToolSdk function

```javascript
function ensureToolSdk(projectPath) {
  const sdkPath = path.join(projectPath, STRUCTURE.toolsDir, 'TOOL_SDK.md');
  const content = buildToolSdkContent();
  const marker = `<!-- TOOL_SDK_V${TOOL_SDK_VERSION} -->`;

  if (!fs.existsSync(sdkPath)) {
    // First time — write the SDK doc
    fs.writeFileSync(sdkPath, content, 'utf8');
  } else {
    // Exists — check version marker, update if stale
    const existing = fs.readFileSync(sdkPath, 'utf8');
    if (!existing.startsWith(marker)) {
      fs.writeFileSync(sdkPath, content, 'utf8');
    }
  }
}
```

**Trigger:** `ensureProjectDirs()` is called on every `project:open` (line 1156) and `project:create` (line 1187). This means:
- **New projects** get `tools/TOOL_SDK.md` on creation.
- **Existing projects** get it on next open — no migration script needed.
- **SDK updates** (bumped `TOOL_SDK_VERSION`) auto-deploy on next open.

#### CLAUDE.md auto-update

The existing `ensureClaudeConfig()` checks `if (!existing.includes('Session Entry Protocol'))` to decide whether to regenerate CLAUDE.md. For the tools section, add a similar check:

```javascript
// In ensureClaudeConfig, after the existing write logic:
if (fs.existsSync(claudeMdPath)) {
  const existing = fs.readFileSync(claudeMdPath, 'utf8');
  // Append tools section if missing (don't regenerate the whole file)
  if (!existing.includes('tools/TOOL_SDK.md')) {
    const toolsSection = buildClaudeMdToolsSection();
    fs.appendFileSync(claudeMdPath, '\n' + toolsSection, 'utf8');
  }
}
```

This is the lightest-touch approach: existing CLAUDE.md files get the pointer appended; new ones get it built-in.

---

### 15.6 — What the agent sees (information flow)

```
Writer says: "I need a tool that tracks which characters know about the conspiracy"
       │
       ▼
Agent reads CLAUDE.md
       │
       ├─ Sees: "read tools/TOOL_SDK.md first"
       │
       ▼
Agent reads tools/TOOL_SDK.md (~800 lines)
       │
       ├─ Knows: manifest format, available primitives, icon list, design rules
       ├─ Knows: guard rails and validation requirements
       ├─ Knows: whether to use logic.ts (local) or prompt.md (Claude) or both
       │
       ▼
Agent checks: is custom tools enabled?
       │
       ├─ If tools/ dir is empty → advise user to enable toggle in Settings → Advanced
       │
       ▼
Agent reads project context
       │
       ├─ NOVEL_CONFIGURATION.md, *_STORY_PRIMARY.txt, NAMING_REFERENCE.md
       ├─ Existing tools/ to avoid duplication
       │
       ▼
Agent generates tool package into tools/<name>/
       │
       ├─ tool.json — validated manifest
       ├─ logic.ts — local heuristics (imports nothing from app internals)
       ├─ prompt.md — Claude template with {{variables}}
       ├─ widget.tsx — imports from "glass-editor/tool-kit" only
       │
       ▼
App detects new files → reloads tool registry → tool appears
```

**Total context cost for tool creation:** CLAUDE.md pointer (~40 tokens) + TOOL_SDK.md (~2000 tokens on demand). Normal sessions that don't involve tool creation pay only the 40-token pointer.

---

### 15.7 — Implementation additions to Phase plan (§11)

**Phase 0 (before Phase 1):** SDK deployment infrastructure

- Add `toolsDir: 'tools'` to STRUCTURE constant.
- Implement `buildToolSdkContent()` and `ensureToolSdk()`.
- Append tools pointer to `buildClaudeMdContent()`.
- Add `customToolsEnabled` to `Preferences` interface + defaults.
- Add toggle row to settings panel.

This is pure scaffolding — no tool loading, no runtime code. Existing projects get the `tools/` dir and `TOOL_SDK.md` on next open.

**Phase 1 additions:** Ship the tool-kit barrel alongside manifest + prompt-only tools.

- Create `src/tools/tool-kit.ts` barrel.
- Create `src/tools/primitives/ToolIcons.tsx` with curated icon set.
- Create all primitive components (ToolButton, ToolCard, etc.) as thin wrappers.
- Gate tool registry behind `customToolsEnabled` preference.

**Phase 2 additions:** Sidebar surface.

- Extend AnalysisPanel tab column to accept dynamic tool tabs from registry.
- Implement `ToolSidePanel` primitive.
- Wire tab click → tool panel render in analysis drawer.

---

### 15.8 — Open question: SDK doc as bundled resource vs. template

Two options for where `TOOL_SDK.md` content lives in the app source:

**Option A: Inline in project-fs.cjs** (like `buildClaudeMdContent`).
- Pro: single source of truth, no extra files to bundle.
- Con: 800+ lines of template string in a .cjs file is unwieldy.

**Option B: Bundled resource file** (like `novel-writing-system/`).
- Ship `resources/TOOL_SDK.md` in the Electron app bundle.
- `ensureToolSdk()` copies from the bundle, similar to `ensureSystemDir()`.
- Pro: the SDK doc is a readable .md file in the source tree — easy to edit and review.
- Con: one more file to track in the build pipeline.

**Recommendation:** Option B. The novel-writing-system already uses this pattern successfully. The SDK doc is primarily prose + code examples — better authored as a .md file than a JS template literal.

---

## 16 — Open Questions

1. ~~**Should tools be shareable between projects?**~~ Resolved — see §13. Tools are copied via import, not shared. Each project owns its copy independently.

2. **Should tools have dependencies on each other?** E.g., the reveal tracker might want thread tracker output as input. This adds complexity but enables powerful composition.

3. ~~**Should the widget grid be user-reorderable?**~~ Resolved — widget config overlay (already implemented) handles this for built-in widgets. Tool widgets will follow the same pattern once tool widgets are integrated in Phase 2.

4. **How deep should highlight integration go?** Tool annotations in the editor overlay add visual noise. Should there be a toggle per tool, or a global "tool highlights" toggle?

5. **Should tools run automatically on chapter change?** Some tools (name scanner, timeline auditor) are useful as background checks that run whenever the writer switches chapters, like the existing analysis pipeline. Others (reveal tracker) are expensive and should be on-demand only. The manifest could declare `"autoRun": true | false`.

6. **Should the import flow support bulk re-import (update)?** A writer who imported tools months ago might want to pull newer versions from the source project. The current design is one-shot copy. A "re-import" variant could diff manifests by version and offer selective updates — but this adds complexity. Deferred until there's a real user need.

7. **Should TOOL_SDK.md be gitignored?** Since it's auto-generated and auto-updated, it could be treated like a build artifact. But agents need it in the working tree to read it. Recommend: do NOT gitignore — it's cheap (one .md file), stable, and having it in version control means collaborators also get it without running the app first.

8. ~~**How does the agent know about the tool system without bloating CLAUDE.md?**~~ Resolved — see §15.4. CLAUDE.md gets a 40-token pointer; full instructions live in `tools/TOOL_SDK.md` read on demand.
