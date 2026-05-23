// Project filesystem operations — runs in Electron main process.
// Provides IPC handlers for opening, reading, and writing project directories.
const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_META_DIR = '.renderer';
const PROJECT_FILE = 'project.json';
const PROJECT_NOVEL_FILE = 'novel.txt';

// Known project structure — maps file roles to relative paths
const STRUCTURE = {
  config: 'NOVEL_CONFIGURATION.md',
  legacyStoryPrimary: 'STORY_PRIMARY.txt',
  namingRef: 'NAMING_REFERENCE.md',
  anchorsDir: 'anchors',
  draftsDir: 'drafts',
  canonDir: 'canon',
  sceneBankDir: 'scene-bank',
  reviewLogsDir: 'review-logs',
  tempDir: 'temp',
  systemDir: 'novel-writing-system',
  toolsDir: 'tools',
};

let _openProjectPath = null;

const LAST_PROJECT_FILE = 'last-project.json';
const CLAUDE_PROJECT_BOUNDARY_HOOK_FILE = 'latent-write-project-boundary.cjs';
const CLAUDE_PROJECT_BOUNDARY_HOOK_ARG = '${CLAUDE_PROJECT_DIR}/.claude/hooks/latent-write-project-boundary.cjs';
const CLAUDE_PROJECT_BOUNDARY_HOOK_SOURCE = String.raw`const fs = require('fs');
const path = require('path');

const DIRECT_WRITE_TOOLS = new Set(['Write', 'Edit']);
const DESTINATION_COMMANDS = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
const TARGET_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'chmod', 'chown', 'chgrp', 'truncate', 'tee']);

function canonicalizePath(targetPath) {
  const absolutePath = path.resolve(targetPath);
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    const parentDir = path.dirname(absolutePath);
    try {
      return path.join(fs.realpathSync(parentDir), path.basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

function isInsideProject(targetPath, projectDir) {
  return targetPath === projectDir || targetPath.startsWith(projectDir + path.sep);
}

function splitCommandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === '\\' && index + 1 < command.length) {
        index += 1;
        current += command[index];
        continue;
      }
      current += char;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    if (char === ';' || char === '\n' || char === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShell(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === '\\' && index + 1 < command.length) {
        index += 1;
        current += command[index];
        continue;
      }
      current += char;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isPathLikeToken(token) {
  if (!token || token === '-' || token.startsWith('--')) return false;
  return token.startsWith('/')
    || token.startsWith('./')
    || token.startsWith('../')
    || token.startsWith('~/')
    || token.includes('/');
}

function sanitizeCandidatePath(rawPath) {
  let candidate = String(rawPath || '').trim();
  if (!candidate || candidate === '-') return null;

  if ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'"))) {
    candidate = candidate.slice(1, -1);
  }

  candidate = candidate.replace(/^[({[]+/, '').replace(/[)\]},;]+$/, '');
  if (!candidate || candidate.startsWith('$')) return null;
  return candidate;
}

function resolveCandidatePath(rawPath, cwdSource) {
  const candidate = sanitizeCandidatePath(rawPath);
  if (!candidate) return null;

  if (candidate === '~') {
    return process.env.HOME ? canonicalizePath(process.env.HOME) : null;
  }

  if (candidate.startsWith('~/')) {
    if (!process.env.HOME) return null;
    return canonicalizePath(path.join(process.env.HOME, candidate.slice(2)));
  }

  return canonicalizePath(path.isAbsolute(candidate)
    ? candidate
    : path.resolve(cwdSource, candidate));
}

function addOutsideTarget(rawPath, projectDir, cwdSource, outsideTargets) {
  const resolvedPath = resolveCandidatePath(rawPath, cwdSource);
  if (!resolvedPath || isInsideProject(resolvedPath, projectDir) || outsideTargets.includes(resolvedPath)) {
    return;
  }
  outsideTargets.push(resolvedPath);
}

function collectRedirectionTargets(command, projectDir, cwdSource, outsideTargets) {
  const redirectionPattern = /(?:^|[\s;|&])(?:\d*>>?|\d*>\||&>>?|&>|>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/g;
  let match;
  while ((match = redirectionPattern.exec(command)) !== null) {
    addOutsideTarget(match[1] || match[2] || match[3], projectDir, cwdSource, outsideTargets);
  }
}

function collectCommandTargets(tokens, projectDir, cwdSource, outsideTargets) {
  let index = 0;
  while (index < tokens.length && isAssignmentToken(tokens[index])) index += 1;
  if (index >= tokens.length) return;

  const commandName = path.basename(tokens[index]);
  const args = tokens.slice(index + 1);
  const pathArgs = args.filter((token) => isPathLikeToken(token) && !token.startsWith('-'));
  if (!pathArgs.length) return;

  if (DESTINATION_COMMANDS.has(commandName)) {
    addOutsideTarget(pathArgs[pathArgs.length - 1], projectDir, cwdSource, outsideTargets);
    return;
  }

  if (TARGET_COMMANDS.has(commandName)) {
    pathArgs.forEach((target) => addOutsideTarget(target, projectDir, cwdSource, outsideTargets));
    return;
  }

  const usesInPlaceEdit = ['sed', 'perl', 'ruby'].includes(commandName)
    && args.some((token) => token === '-i' || /^-i/.test(token) || /^-[A-Za-z]*i[A-Za-z]*$/.test(token));
  if (usesInPlaceEdit) {
    pathArgs.forEach((target) => addOutsideTarget(target, projectDir, cwdSource, outsideTargets));
  }
}

function findOutsideBashWriteTargets(command, projectDir, cwdSource) {
  const outsideTargets = [];
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    collectRedirectionTargets(segment, projectDir, cwdSource, outsideTargets);
    collectCommandTargets(tokenizeShell(segment), projectDir, cwdSource, outsideTargets);
  }

  return outsideTargets;
}

function findOutsideWriteTargets(payload, projectDir, cwdSource) {
  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input ?? {};

  if (DIRECT_WRITE_TOOLS.has(toolName)) {
    const rawPath = toolInput.file_path || toolInput.path;
    const resolvedPath = resolveCandidatePath(rawPath, cwdSource);
    return resolvedPath && !isInsideProject(resolvedPath, projectDir) ? [resolvedPath] : [];
  }

  if (toolName === 'Bash') {
    return findOutsideBashWriteTargets(String(toolInput.command || ''), projectDir, cwdSource);
  }

  return [];
}

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

if (!raw.trim()) process.exit(0);

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const projectDirSource = process.env.CLAUDE_PROJECT_DIR || payload?.cwd;
const cwdSource = payload?.cwd || projectDirSource;
if (!projectDirSource || !cwdSource) process.exit(0);

const projectDir = canonicalizePath(projectDirSource);
const outsideTargets = findOutsideWriteTargets(payload, projectDir, cwdSource);
if (!outsideTargets.length) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Blocked outside-project write via ' + String(payload.tool_name || 'tool') + ': ' + outsideTargets[0],
  },
}));
`;

// ── Bundled novel-writing-system resolution ─────────────────────────────────
// In dev: sibling directory next to glass-editor (../../novel-writing-system)
// In packaged app: extraResources/novel-writing-system
function getBundledSystemPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'novel-writing-system');
  }
  const candidates = [
    path.join(__dirname, '..', '..', 'novel-writing-system'),
    path.join(app.getAppPath(), '..', 'novel-writing-system'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

function copyRecursiveSync(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    if (item === '.git' || item === 'node_modules' || item === '.DS_Store') continue;
    const srcPath = path.join(src, item);
    const dstPath = path.join(dst, item);
    if (fs.statSync(srcPath).isDirectory()) {
      copyRecursiveSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function ensureSystemDir(projectPath) {
  const dest = path.join(projectPath, STRUCTURE.systemDir);
  if (fs.existsSync(dest)) return true;
  const bundled = getBundledSystemPath();
  if (!bundled) return false;
  try {
    copyRecursiveSync(bundled, dest);
    return true;
  } catch (err) {
    console.error('[project-fs] Failed to copy novel-writing-system:', err.message);
    return false;
  }
}

const TOOL_SDK_VERSION = 3;
const TOOL_SDK_MARKER = `<!-- TOOL_SDK_V${TOOL_SDK_VERSION} -->`;

function buildToolSdkContent() {
  return `${TOOL_SDK_MARKER}
# Tool SDK — Latent Write Custom Tools

This document is the complete reference for creating custom per-project tools. The renderer agent reads this file when the user requests tool creation. Do not edit manually — it is auto-updated by the app.

---

## 1 — Tool Structure

A tool is a directory inside \`tools/\` containing:

\`\`\`
tools/<tool-name>/
  tool.json      ← manifest (required)
  logic.ts       ← local heuristic functions (optional)
  prompt.md      ← Claude prompt template (optional)
  widget.tsx     ← widget/overlay/sidebar component (optional)
\`\`\`

At minimum a tool needs \`tool.json\` + either \`logic.ts\` or \`prompt.md\` (or both).

---

## 2 — Manifest Format (tool.json)

\`\`\`jsonc
{
  "name": "my-tool",                  // kebab-case, unique within project
  "display": "My Tool",              // human label for UI
  "version": "1.0.0",
  "description": "What this tool does in one line",

  "command": "/my-tool",             // slash command (must not collide with built-ins)
  "shortcut": null,                  // optional keyboard shortcut

  "surfaces": ["chat"],             // where the tool renders (see §3)

  "inputs": {
    "chapter": "current",            // "current" | "all" | "range"
    "analysis": false,               // needs ChapterAnalysisResult
    "worldData": false,              // needs WorldData
    "files": []                      // project file glob patterns
  },

  "outputs": {
    "report": null,                  // path for saved reports, e.g. "review-logs/my-tool/"
    "widget": false,                 // true if widget.tsx exists
    "highlights": false              // true to inject editor annotations
  },

  "requiresClaude": false,           // true if prompt.md is used
  "estimatedTokens": 0,             // approximate Claude input cost
  "edited": false                    // true = user manually edited; blocks agent overwrite

  // Sidebar-specific (only when surfaces includes "sidebar"):
  // "sidebar": { "icon": "Target", "position": "before-settings", "width": "default" }
}
\`\`\`

### Reserved commands (cannot use)

\`/scan\`, \`/draft\`, \`/review\`, \`/lore\`, \`/assemble\`, \`/update\`, \`/init\`, \`/context\`, \`/clear\`, \`/help\`, \`/model\`, \`/models\`, \`/effort\`

### Validation rules

- \`name\`: unique across all project tools, kebab-case
- \`command\`: starts with \`/\`, no collision with reserved commands
- \`surfaces\`: non-empty array of: \`"chat"\`, \`"widget"\`, \`"sidebar"\`, \`"overlay"\`, \`"highlight"\`
- \`inputs.files\`: patterns must resolve inside project directory (no \`../\` escapes)

---

## 3 — Surfaces

| Surface | Manifest value | What it does |
|---|---|---|
| Chat output | \`"chat"\` | Tool output appears as messages in renderer chat |
| Widget card | \`"widget"\` | Renders a card in the analysis panel grid |
| Side panel tab | \`"sidebar"\` | Adds a button to the analysis tab column with own panel |
| Full-screen overlay | \`"overlay"\` | Opens a full-screen glass overlay |
| Editor highlights | \`"highlight"\` | Injects annotations into the editor highlight layer |

A tool can declare multiple surfaces: \`"surfaces": ["chat", "widget", "highlight"]\`

### Sidebar config

When using \`"sidebar"\`, add:
\`\`\`jsonc
"sidebar": {
  "icon": "Target",              // icon name from §7 icon catalogue
  "position": "before-settings", // "top" | "before-settings" | "after-settings"
  "width": "default"             // "default" (320px) | "wide" (480px)
}
\`\`\`

---

## 4 — Logic Module (logic.ts)

Runs locally in the renderer — no Claude, no network, instant results.

\`\`\`typescript
export interface ToolContext {
  chapterContent: string;
  chapterTitle: string;
  chapterIndex: number;
  allChapters: Array<{ title: string; content: string; number: number }>;
  analysis: ChapterAnalysisResult | null;
  worldData: WorldData | null;
  files: Record<string, string>;   // relative path → content
  previousState: unknown;
}

export interface ToolResult {
  summary: string;                 // shown in renderer chat
  widgetData?: unknown;            // passed to widget.tsx
  highlights?: Array<{
    start: number;
    end: number;
    type: string;
    label: string;
    severity: "info" | "warning" | "error";
  }>;
  report?: string;                 // saved to outputs.report path
  state?: unknown;                 // persisted for next run
  chainClaude?: boolean;           // trigger prompt.md after local run
  claudeContext?: string;          // extra context for prompt.md
}

export function run(ctx: ToolContext): ToolResult;
\`\`\`

### State persistence

The app automatically persists and restores tool state across sessions:

- **Saving:** If \`run()\` returns a \`state\` object, the app writes it to \`<outputs.report>/state.json\`.
- **Loading on next run:** On the next execution, \`ctx.previousState\` contains the parsed JSON from the saved state file. Use it to restore counters, scan timestamps, or incremental data.
- **Startup hydration:** When the app opens a project, saved state files are loaded and passed to widgets as their initial \`data\` prop — so widgets display the last scan results immediately without re-running.

Return \`widgetData\` and \`state\` with the same shape so the widget renders correctly from both live runs and saved state.

### Constraints

- No access to: \`window\`, \`document\`, \`fetch\`, \`require\`, \`process\`
- Data comes only through ToolContext
- 5-second execution timeout
- Must export a \`run\` function

---

## 5 — Prompt Template (prompt.md)

Template variables use \`{{double_braces}}\`:

| Variable | Resolves to |
|---|---|
| \`{{chapter_content}}\` | Current chapter text |
| \`{{chapter_title}}\` | Current chapter title |
| \`{{chapter_number}}\` | Current chapter number |
| \`{{story_primary}}\` | Full story primary content |
| \`{{story_primary_section_0}}\` | Section 0 (Writing Directives) only |
| \`{{story_primary_section_10}}\` | Section 10 (Chapter Entries) only |
| \`{{naming_reference}}\` | Full NAMING_REFERENCE.md |
| \`{{novel_config}}\` | Full NOVEL_CONFIGURATION.md |
| \`{{tool_context}}\` | claudeContext from logic result |
| \`{{tool_previous_report}}\` | Previous report from outputs.report |
| \`{{file:relative/path.md}}\` | Content of a specific project file |

---

## 6 — Widget Module (widget.tsx)

### CRITICAL ARCHITECTURE RULES

1. **Two exports, two surfaces.** A widget.tsx file supports two distinct components:
   - \`export default function XxxWidget(...)\` → renders in the **analysis panel widget grid** (small card)
   - \`export function SidePanel(...)\` → renders in the **sidebar drawer** (full-height panel)
   These are DIFFERENT surfaces. The default export is NOT used for sidebar. If your tool has \`"sidebar"\` in surfaces, you MUST export a named \`SidePanel\` function.

2. **Widget scope is sandboxed.** Your component receives ONLY these props — nothing else exists:
   - \`data\`: the \`widgetData\` object from logic.ts result (or null if not yet run)
   - \`chapterTitle\`: current chapter title string
   - \`isAnalyzing\`: boolean indicating if analysis is running
   There is NO \`ctx\`, NO \`allChapters\`, NO \`chapterIndex\`, NO \`chapterContent\` in widget scope. All data your widget needs must come through \`data\` (set by logic.ts \`widgetData\`).

3. **Errors crash the widget, not the app.** Tool widgets run inside an error boundary. If your code throws, only your widget shows an error card — the rest of the app continues. But you should still guard against null data.

4. **Available imports — ONLY these three modules:**
   - \`"glass-editor/tool-kit"\` — all UI primitives (ToolCard, ToolButton, etc.)
   - \`"react"\` — useState, useEffect, useMemo, etc.
   - \`"react/jsx-runtime"\` — automatic (don't import explicitly)
   Any other import (fs, path, fetch, window APIs) will throw at runtime.

5. **\`runCommand(cmd)\` is the ONLY way to trigger actions.** Import it from \`"glass-editor/tool-kit"\`. It dispatches a slash command to the renderer chat. Use it in button onClick handlers — especially empty states. There is NO other command API — do not invent \`runTool\`, \`dispatch\`, \`executeCommand\`, etc.

### Empty state: MUST use runCommand button

When \`data\` is null (tool hasn't run yet), show a ToolButton that calls \`runCommand\`. **NEVER display "Run /command" as plain text** — always provide a clickable button:

\`\`\`tsx
import { ToolCard, ToolButton, runCommand } from "glass-editor/tool-kit";

if (!data) {
  return (
    <ToolCard bg="rgba(30, 58, 95, 0.35)" accent="#5ab8e0" topLeft="My Tool">
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "var(--font-ui)", margin: "0 0 8px" }}>
          Not yet scanned
        </p>
        <ToolButton variant="secondary" onClick={() => runCommand("/my-tool")}>
          Scan Chapter
        </ToolButton>
      </div>
    </ToolCard>
  );
}
\`\`\`

### Widget card (default export) — analysis panel

The widget card sits in the analysis panel **widget grid** alongside built-in widgets. It is a small, glanceable status card — NOT a full panel. Use \`ToolCard\` as root. Keep content minimal: a badge, 2-3 data rows max, and a \`runCommand\` button in the empty state.

\`\`\`tsx
import { ToolCard, ToolBadge, ToolDataRow, ToolButton, runCommand } from "glass-editor/tool-kit";

interface MyData { count: number; items: string[] }

export default function MyToolWidget({ data, isAnalyzing }: {
  data: MyData | null;
  chapterTitle: string;
  isAnalyzing: boolean;
}) {
  if (!data) {
    return (
      <ToolCard bg="rgba(30, 58, 95, 0.35)" accent="#5ab8e0" topLeft="My Tool">
        <div style={{ textAlign: "center", padding: "6px 0" }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "var(--font-ui)", margin: "0 0 8px" }}>
            Not yet scanned
          </p>
          <ToolButton variant="secondary" onClick={() => runCommand("/my-tool")}>Scan</ToolButton>
        </div>
      </ToolCard>
    );
  }
  return (
    <ToolCard
      bg="rgba(30, 58, 95, 0.35)"
      accent="#5ab8e0"
      topLeft="My Tool"
      topRight={<ToolBadge label="DONE" status="pass" />}
    >
      <ToolDataRow label="Items" value={data.count} status="pass" />
    </ToolCard>
  );
}
\`\`\`

### Side panel (named export) — sidebar drawer

The sidebar is a FULL-HEIGHT panel that renders **inside the app's glass panel shell** — exactly like the Settings, Renderer, and Timeline panels. \`ToolSidePanel\` is the ONLY root you should use. It renders the glass container (\`settings-panel liquid-glass\`), scroll wrapper, header, and toolbar slot for you.

**CRITICAL: Do NOT add glass treatment yourself.** No \`backdropFilter\`, no \`background: var(--bg-glass)\`, no \`boxShadow: var(--shadow-glass)\`, no \`borderRadius: 22\` or \`30\`. \`ToolSidePanel\` already provides all of this. Just put your content (tabs, lists, buttons) as direct children.

**Layout (handled automatically by ToolSidePanel):**
- Width: 370 px (set by the analysis drawer — your component fills it)
- Height: full viewport minus 40 px insets (your component fills it)
- Glass shell: \`border-radius: 30px\`, liquid-glass blur + specular ring
- Inner padding: 16px 14px, gap: 12px, scrollable content area with \`overflow-y: auto\`

Use \`ToolTabBar\` for filtering, \`ToolButton\` for actions, and \`runCommand\` for re-scan buttons. Sidebar panels should have interactive controls (buttons, toggles, filters) — not just display data.

\`\`\`tsx
import { runCommand } from "glass-editor/tool-kit";

export function SidePanel({ data, isAnalyzing }: {
  data: MyData | null;
  chapterTitle: string;
  isAnalyzing: boolean;
}) {
  const [tab, setTab] = useState("all");

  if (!data) {
    return (
      <ToolSidePanel title="My Tool">
        <div style={{ padding: "32px 16px", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", fontFamily: "var(--font-ui)", margin: "0 0 12px" }}>
            Not yet scanned
          </p>
          <ToolButton variant="primary" onClick={() => runCommand("/my-tool")}>Run Scan</ToolButton>
        </div>
      </ToolSidePanel>
    );
  }

  return (
    <ToolSidePanel
      title="My Tool"
      toolbar={<ToolTabBar tabs={[...]} value={tab} onChange={setTab} />}
    >
      {/* Interactive list with buttons/actions for each item */}
    </ToolSidePanel>
  );
}
\`\`\`

### Layout geometry reference

The analysis drawer applies \`zoom: 0.77\` — so 480 CSS px renders at ~370 px visual. All values below are CSS pixels (pre-zoom). NEVER set explicit pixel widths on root containers — use \`100%\` or let flex layout fill the available space.

**Widget card (\`ToolCard\`)**
| Property | Value |
|---|---|
| Outer width | 456 px (fills drawer content area, set by parent flex) |
| Card padding | 20 px all sides |
| Usable content width | **416 px** |
| Min outer height | 150 px → min content height ~110 px |
| Card border-radius | 32 px |
| Content corner radius | 12 px (concentric: 32 − 20) |
| Bottom margin | 12 px (between stacked cards) |

**Side panel (\`ToolSidePanel\`)**
| Property | Value |
|---|---|
| Outer width | 456 px (fills drawer content area) |
| Glass shell radius | 30 px |
| Inner padding | 16 px top/bottom, 14 px left/right |
| Usable content width | **428 px** |
| Content height | Fills available height via \`flex: 1; overflow-y: auto\` |
| Header ↔ content gap | 12 px |

**Overflow handling rules:**
- **Single-line text:** \`overflow: hidden; text-overflow: ellipsis; white-space: nowrap\`
- **Multi-line clamp:** \`display: -webkit-box; -webkit-line-clamp: N; -webkit-box-orient: vertical; overflow: hidden\`
- **Long lists:** Let content overflow naturally inside \`.tool-side-panel-content\` (it scrolls). Do NOT nest your own scroll container.
- **Horizontal:** Never allow horizontal scroll. If content exceeds width, truncate or wrap.
- **Tables/grids:** Use \`table-layout: fixed\` and truncate cells, or wrap to a vertical list if too wide.

**Spacing contract:**
- Between sections/groups: **12 px** (flex gap, set by ToolSidePanel)
- Between list items: **8 px**
- Label ↔ value: **4–6 px**
- Icon + text inline: **6 px** gap
- Button row: **8 px** gap
- Inner element padding: **8–12 px** (match your nesting depth)

### Sidebar vs Widget — design intent

| | Widget card | Sidebar panel |
|---|---|---|
| **Dimensions** | Auto-sized card in grid (fills 456 px, zoom 0.77) | Full height, fills 456 px drawer (auto, handled by ToolSidePanel) |
| **Glass treatment** | None (opaque bg via ToolCard) | Automatic (ToolSidePanel renders the glass shell) |
| **Purpose** | Status at a glance | Interactive management |
| **Root component** | \`ToolCard\` | \`ToolSidePanel\` (renders glass + scroll + header) |
| **Interactivity** | Read-only / minimal | Buttons, toggles, lists |
| **Example** | "5 open threads" badge | Full thread list with mark-as-resolved buttons |

### Two approaches for custom elements inside widgets

1. **Kit-first (recommended):** import ToolCard, ToolBadge, etc. from the tool-kit. Zero design risk.
2. **Custom UI:** write your own JSX + inline styles. You MUST read and follow \`tools/TOOL_DESIGN.md\` rules. Use only the token values and patterns documented there.

**Before creating any custom visual component** (not using tool-kit primitives), read \`tools/TOOL_DESIGN.md\`. It contains the complete color system, border treatment, typography scale, radius concentricity rules, and micro-interaction contracts.

---

## 7 — Available Components (glass-editor/tool-kit)

### Layout

| Component | Props | Description |
|---|---|---|
| \`ToolCard\` | \`bg, accent, topLeft, topRight, bottomLeft, bottomRight, deco, heroAlign, children\` | Widget card container |
| \`ToolOverlay\` | \`title, onClose, sidebar?, children\` | Full-screen glass overlay |
| \`ToolSidePanel\` | \`title, onClose?, toolbar?, children\` | Side panel content wrapper |

### Controls

| Component | Props | Description |
|---|---|---|
| \`ToolButton\` | \`variant("primary"\\|"secondary"), children, onClick, disabled?\` | System button |
| \`ToolToggle\` | \`checked, onChange, label, description?\` | Glass toggle + label row |
| \`ToolRange\` | \`label, value, min, max, step?, formatValue?, onChange\` | Labeled slider |
| \`ToolPillGroup\` | \`options[{value,label}], value, onChange\` | Exclusive pill selector |
| \`ToolTabBar\` | \`tabs[{value,label,count?,status?}], value, onChange\` | Tab bar |
| \`ToolSectionLabel\` | \`children(string)\` | Uppercase section divider |

### Data Display

| Component | Props | Description |
|---|---|---|
| \`ToolBadge\` | \`label, status("pass"\\|"fail"\\|"warning"\\|"info"\\|"neutral")\` | Status pill |
| \`ToolDataRow\` | \`label, value, status?\` | Key-value row |
| \`ToolDataTable\` | \`columns[{key,label,align?}], rows[], highlightRow?\` | Compact table |

### Charts

| Component | Props | Description |
|---|---|---|
| \`ToolSparkline\` | \`values(0-1[]), color?, width?, height?\` | Catmull-Rom sparkline |
| \`ToolProgressRing\` | \`value(0-1), label?, color?, size?\` | Circular progress |
| \`ToolDialRing\` | \`value(0-1), label?, color?, size?\` | Dotted gauge ring |
| \`ToolArcRing\` | \`value(0-1), label?, unit?, color?, size?, thickness?\` | Continuous arc gauge |
| \`ToolHeatmap\` | \`xLabels[], yLabels[], values[][], colorScale?, onCellClick?\` | Grid heatmap |

### Functions

| Function | Signature | Description |
|---|---|---|
| \`runCommand\` | \`(command: string) => void\` | Dispatch a slash command to the renderer chat. **This is the ONLY way to trigger commands from widget buttons.** Example: \`runCommand("/threads")\` |

---

## 8 — Available Icons

Import by name from \`"glass-editor/tool-kit"\`:

\`\`\`typescript
import { AlertTriangle, Check, Target, TrendingUp } from "glass-editor/tool-kit";
\`\`\`

**Full list:**
AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BarChart2, BookOpen, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Copy, Download, Edit3, ExternalLink, Eye, EyeOff, FileText, Filter, Flag, FolderOpen, Globe, Hash, Heart, HelpCircle, Image, Info, Layers, Link, List, MapPin, Maximize2, MessageSquare, Minus, MoreHorizontal, PenTool, Plus, RefreshCw, Search, Settings, Shuffle, Sparkles, Star, Tag, Target, Trash2, TrendingDown, TrendingUp, Type, Upload, User, Users, Wand2, X, Zap

All icons: 18px default, 1.8px stroke, round caps/joins. Pass \`size\` prop to resize.

---

## 9 — Design Rules (STRICT)

These are the non-negotiable minimums. For the full system — with color tokens, radius math, typography scale, border technique, and micro-interaction contracts — **read \`tools/TOOL_DESIGN.md\`** before writing any custom UI.

1. **Widget card text** — \`rgba(255,255,255,…)\` for all text inside dark card backgrounds. Never \`var(--text)\` inside cards.
2. **Widget card backgrounds** — \`rgba(r,g,b,0.35)\` pattern.
3. **Status colors** — pass: \`#34c759\`, fail: \`#f43f5e\`, warning: \`#fbbf24\`, info: \`#5ab8e0\`, neutral: \`#94a3b8\`.
4. **Glass borders** — \`::before\` pseudo-element with gradient mask. Never \`border: 1px solid\`. See TOOL_DESIGN.md §2.
5. **Shadows** — \`--shadow-glass\` / \`--shadow-glass-hover\` only. No custom box-shadow values.
6. **Radius concentricity** — outer radius = inner radius + padding. See TOOL_DESIGN.md §3.
7. **Typography** — \`--font-body\` for titles, \`--font-ui\` for everything else. Sizes from the scale only.
8. **Motion** — spring: \`cubic-bezier(0.34, 1.56, 0.64, 1)\`. Standard: \`ease\` 0.12-0.18s. No custom curves.
9. **Custom UI is allowed** — but read TOOL_DESIGN.md first and follow every rule. You are a professional designer.

---

## 10 — Guard Rails

- Tool code CANNOT access files outside the project directory.
- Tool code CANNOT make network requests.
- Tool code CANNOT access DOM, window, or Node APIs.
- Tools with \`"edited": true\` are protected — ask before overwriting.
- Always set \`"edited": false\` on newly generated tools.
- Declare \`estimatedTokens\` honestly in the manifest.
- If custom tools toggle is disabled, advise user: "Enable Custom Tool Plugins in Settings → Advanced first."
- **Before writing ANY custom widget UI** (not using tool-kit primitives), you MUST read \`tools/TOOL_DESIGN.md\`. This is not optional.
- **JSON.parse replaces the entire default object.** When reading optional JSON files in logic.ts, never do \`let x = {defaults}; try { x = JSON.parse(raw); } catch {}\` — the parsed \`{}\` wipes your defaults. Instead, destructure with fallbacks: \`const parsed = JSON.parse(raw); x = { key: parsed.key ?? defaultValue, ... }\`.

---

## 11 — Complete Examples

### Example A: Name Scanner (widget only, logic-only)

**tools/name-scanner/tool.json:**
\`\`\`json
{
  "name": "name-scanner",
  "display": "Name Scanner",
  "version": "1.0.0",
  "description": "Diff chapter nouns against NAMING_REFERENCE.md",
  "command": "/names",
  "shortcut": null,
  "surfaces": ["chat", "widget"],
  "inputs": { "chapter": "current", "analysis": false, "worldData": false, "files": ["NAMING_REFERENCE.md"] },
  "outputs": { "report": "review-logs/name-scanner/", "widget": true, "highlights": false },
  "requiresClaude": false,
  "estimatedTokens": 0,
  "edited": false
}
\`\`\`

**tools/name-scanner/logic.ts:**
\`\`\`typescript
export function run(ctx: ToolContext): ToolResult {
  const namingRef = ctx.files["NAMING_REFERENCE.md"] || "";
  const knownNames = new Set(
    namingRef.match(/^- \\*\\*(.+?)\\*\\*/gm)?.map(m => m.replace(/^- \\*\\*|\\*\\*$/g, "")) || []
  );
  const words = ctx.chapterContent.match(/[A-Z][a-z]{2,}/g) || [];
  const unknown = [...new Set(words)].filter(w => !knownNames.has(w));
  return {
    summary: unknown.length === 0
      ? "All proper nouns match NAMING_REFERENCE.md."
      : \`Found \${unknown.length} unrecognized name(s): \${unknown.join(", ")}\`,
    widgetData: { known: knownNames.size, unknown, total: words.length },
  };
}
\`\`\`

**tools/name-scanner/widget.tsx:**
\`\`\`tsx
import { ToolCard, ToolBadge, ToolDataRow, ToolButton, runCommand } from "glass-editor/tool-kit";

interface ScanData { known: number; unknown: string[]; total: number }

// DEFAULT EXPORT = widget card in analysis panel grid
export default function NameScannerWidget({ data, isAnalyzing }: {
  data: ScanData | null; chapterTitle: string; isAnalyzing: boolean;
}) {
  // ALWAYS guard for null data — show empty state with runCommand button
  if (!data) {
    return (
      <ToolCard bg="rgba(40, 55, 70, 0.35)" accent="#5ab8e0" topLeft="Names">
        <div style={{ textAlign: "center", padding: "6px 0" }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "var(--font-ui)", margin: "0 0 8px" }}>
            Not yet scanned
          </p>
          <ToolButton variant="secondary" onClick={() => runCommand("/names")}>Scan Names</ToolButton>
        </div>
      </ToolCard>
    );
  }
  const status = data.unknown.length === 0 ? "pass" : "warning";
  return (
    <ToolCard
      bg="rgba(40, 55, 70, 0.35)"
      accent={status === "pass" ? "#34d399" : "#fbbf24"}
      topLeft="Names"
      topRight={<ToolBadge label={status === "pass" ? "CLEAR" : \`\${data.unknown.length} NEW\`} status={status} />}
      bottomLeft={\`\${data.known} known\`}
    >
      {data.unknown.length === 0
        ? <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-ui)" }}>All names verified</span>
        : data.unknown.slice(0, 4).map((n: string) => (
            <ToolDataRow key={n} label={n} value="?" status="warning" />
          ))
      }
    </ToolCard>
  );
}
\`\`\`

### Example B: Thread Tracker (widget + sidebar + highlights, Claude chain)

Demonstrates the multi-surface pattern: widget card for status-at-a-glance, sidebar panel for interactive management.

**tools/thread-tracker/tool.json:**
\`\`\`json
{
  "name": "thread-tracker",
  "display": "Thread Tracker",
  "version": "1.0.0",
  "description": "Identifies unresolved story threads across all chapters",
  "command": "/threads",
  "shortcut": null,
  "surfaces": ["chat", "widget", "sidebar", "highlight"],
  "inputs": { "chapter": "all", "analysis": false, "worldData": false, "files": [] },
  "outputs": { "report": "review-logs/thread-tracker/", "widget": true, "highlights": true },
  "requiresClaude": true,
  "estimatedTokens": 4000,
  "edited": false,
  "sidebar": { "icon": "Link", "position": "before-settings", "width": "default" }
}
\`\`\`

**tools/thread-tracker/widget.tsx (KEY: two exports + runCommand):**
\`\`\`tsx
import { useState } from "react";
import {
  ToolCard, ToolBadge, ToolDataRow, ToolButton,
  ToolSidePanel, ToolTabBar, ToolSectionLabel, runCommand,
} from "glass-editor/tool-kit";

interface Thread { id: string; text: string; type: string; sourceChapter: number; status: string }
interface ThreadData { threads: Thread[]; open: number; resolved: number }

// ─── DEFAULT EXPORT: widget card (analysis panel grid) ──────────────────────
export default function ThreadWidget({ data, isAnalyzing }: {
  data: ThreadData | null; chapterTitle: string; isAnalyzing: boolean;
}) {
  if (!data) {
    return (
      <ToolCard bg="rgba(30, 58, 95, 0.35)" accent="#5ab8e0" topLeft="Threads">
        <div style={{ textAlign: "center", padding: "6px 0" }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "var(--font-ui)", margin: "0 0 8px" }}>
            Not yet scanned
          </p>
          <ToolButton variant="secondary" onClick={() => runCommand("/threads")}>Scan Threads</ToolButton>
        </div>
      </ToolCard>
    );
  }
  const badge = data.open === 0 ? "CLEAR" : \`\${data.open} OPEN\`;
  const status = data.open === 0 ? "pass" : data.open > 5 ? "fail" : "warning";
  return (
    <ToolCard
      bg="rgba(30, 58, 95, 0.35)" accent="#5ab8e0" topLeft="Threads"
      topRight={<ToolBadge label={badge} status={status} />}
      bottomLeft={\`\${data.threads.length} total\`}
    >
      {data.threads.filter(t => t.status === "open").slice(0, 3).map(t => (
        <ToolDataRow key={t.id} label={\`Ch \${t.sourceChapter}\`} value={t.text} status="warning" />
      ))}
    </ToolCard>
  );
}

// ─── NAMED EXPORT: sidebar panel (full-height interactive panel) ────────────
// This is a SEPARATE component for the sidebar surface. NOT the widget card.
export function SidePanel({ data, isAnalyzing }: {
  data: ThreadData | null; chapterTitle: string; isAnalyzing: boolean;
}) {
  const [tab, setTab] = useState("open");

  if (!data) {
    return (
      <ToolSidePanel title="Thread Tracker">
        <div style={{ padding: "32px 16px", textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", fontFamily: "var(--font-ui)", margin: "0 0 12px" }}>
            Not yet scanned
          </p>
          <ToolButton variant="primary" onClick={() => runCommand("/threads")}>Run Thread Scan</ToolButton>
        </div>
      </ToolSidePanel>
    );
  }

  const threads = data.threads;
  const filtered = tab === "all" ? threads : threads.filter(t => t.status === tab);
  const tabs = [
    { value: "open", label: "Open", count: data.open },
    { value: "resolved", label: "Done", count: data.resolved },
    { value: "all", label: "All", count: threads.length },
  ];

  return (
    <ToolSidePanel
      title="Thread Tracker"
      toolbar={<ToolTabBar tabs={tabs} value={tab} onChange={setTab} />}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "6px 8px" }}>
        {filtered.map(t => (
          <div key={t.id} style={{
            padding: "9px 11px", borderRadius: 12,
            background: "transparent", transition: "background 0.14s ease",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, fontFamily: "var(--font-ui)",
                color: "rgba(255,255,255,0.65)", background: "rgba(255,255,255,0.09)",
                borderRadius: 4, padding: "2px 5px",
              }}>
                CH {t.sourceChapter}
              </span>
              <span style={{
                fontSize: 12, color: "var(--text)", fontFamily: "var(--font-ui)",
                flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {t.text}
              </span>
            </div>
          </div>
        ))}
      </div>
    </ToolSidePanel>
  );
}
\`\`\`

### Common mistakes — DO NOT

| Mistake | Why it breaks | Fix |
|---|---|---|
| \`ctx.allChapters\` in widget | \`ctx\` doesn't exist in widget scope | Use \`data\` prop (set by logic.ts widgetData) |
| Missing \`SidePanel\` export | Sidebar renders blank/default widget | Add \`export function SidePanel(...)\` |
| \`"Run /command"\` text as empty state | Not actionable, bad UX | Use \`<ToolButton>\` |
| \`var(--text)\` inside ToolCard | Cards have dark bg, CSS vars resolve wrong | Use \`rgba(255,255,255,...)\` |
| No null guard on \`data\` | Throws on first render before tool runs | Always check \`if (!data)\` first |
| Importing \`fs\`, \`path\`, or \`fetch\` | Sandboxed — only react + tool-kit available | Pass data through logic.ts widgetData |
| \`runTool("/cmd")\` or \`dispatch\` | Only \`runCommand\` exists — import it from tool-kit | \`import { runCommand } from "glass-editor/tool-kit"\` |
| \`x = JSON.parse(raw)\` on optional file | Parsed \`{}\` wipes all default properties | Destructure with \`??\` fallbacks per field |
| Adding \`backdropFilter\`/\`borderRadius\`/glass styles in SidePanel | Duplicates the glass shell — double blur, wrong radius, broken specular ring | \`ToolSidePanel\` handles all glass treatment. Just put content as children |
| Setting \`width: 370px\` or fixed dimensions in SidePanel | Width is set by the analysis drawer, height is set by the panel container | Let \`ToolSidePanel\` fill its container — use \`flex: 1\` and \`min-height: 0\` on scrollable content |
| No text truncation on labels | Long names overflow card/panel edge, break layout | Add \`overflow: hidden; text-overflow: ellipsis; white-space: nowrap\` on single-line labels |
| Nested scroll container inside SidePanel | Double scrollbars, traps scroll events, broken momentum | Put flat content in \`ToolSidePanel\` children — the content area scrolls for you |
| Using \`position: absolute/fixed\` for layout in panels | Escapes the flex column, overlaps header/toolbar, broken on resize | Use flex layout with \`gap\`, \`flex-shrink: 0\` for fixed headers, \`flex: 1\` for scrollable body |
| Hardcoding pixel widths on inner elements | Breaks when drawer width or zoom changes | Use \`width: 100%\` or \`flex: 1\`, let flex fill the available space |
`;
}

const TOOL_DESIGN_VERSION = 1;
const TOOL_DESIGN_MARKER = `<!-- TOOL_DESIGN_V${TOOL_DESIGN_VERSION} -->`;

function buildToolDesignContent() {
  return `${TOOL_DESIGN_MARKER}
# Tool Design System — Latent Write

> Read this file ONLY when creating custom widget UI (not using tool-kit primitives).
> If you are using ToolCard, ToolBadge, etc. from the tool-kit barrel, those components
> already enforce these rules — you do not need to read this file.

You are acting as a professional interface designer. Every visual choice must be intentional, systematic, and follow the physical-material metaphor. This is a glass design system — surfaces feel physical, hierarchy feels spatial.

---

## 1 — Color System

### Widget card palette

Widget cards render on dark translucent backgrounds. All internal text uses rgba alpha stacks — never system-level \`var(--text)\` tokens.

**Backgrounds** — always \`rgba(r, g, b, 0.35)\`:
\`\`\`
rgba(30, 58, 95, 0.35)    — deep blue (tension, timeline)
rgba(50, 35, 65, 0.35)    — purple (voice, character)
rgba(25, 55, 55, 0.35)    — teal (structure, continuity)
rgba(45, 35, 30, 0.35)    — warm brown (pacing, rhythm)
rgba(35, 45, 55, 0.35)    — slate (diagnostics, stats)
rgba(40, 55, 70, 0.35)    — steel (names, data)
\`\`\`

**Accent colors** — full saturation, used for fills, active states, sparklines:
\`\`\`
#5ab8e0    blue (default/info)
#f59e0b    amber (rising, caution)
#a78bfa    purple (voice, character)
#34d399    green (pass, growth)
#f43f5e    red (fail, high tension)
#94a3b8    neutral (inactive, calm)
#fbbf24    yellow (warning)
\`\`\`

**Status semantic colors:**
\`\`\`
pass:    #34c759 (light) / #30d158 (dark)
fail:    #f43f5e
warning: #fbbf24
info:    #5ab8e0
neutral: #94a3b8
\`\`\`

**Text inside widget cards** — rgba white stacks:
\`\`\`
Primary:   rgba(255, 255, 255, 0.90)
Secondary: rgba(255, 255, 255, 0.65)
Tertiary:  rgba(255, 255, 255, 0.45)
Muted:     rgba(255, 255, 255, 0.25)
Dividers:  rgba(255, 255, 255, 0.07)
\`\`\`

### Panel/overlay palette (system tokens)

For ToolOverlay, ToolSidePanel, and settings-style surfaces — use CSS variables:
\`\`\`
--bg-glass-strong       Panel/overlay backgrounds
--bg-glass-hover        Hover states
--overlay-scrim-bg      Backdrop scrim: rgba(20,20,22,0.18)
--text                  Primary text
--text-secondary        Secondary text, cancel buttons
--text-tertiary         Muted labels
--divider-line          Borders, separators
\`\`\`

---

## 2 — Glass Border Technique (MANDATORY)

Every glass panel and card uses the gradient-mask border pseudo-element. **Never use \`border: 1px solid\`.**

\`\`\`css
.my-surface {
  position: relative;
  overflow: hidden;
  border: none;
  border-radius: 32px;    /* see §3 for correct radius */
  background: var(--bg-glass-strong);
  box-shadow: var(--shadow-glass);
}

.my-surface::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--border-glass-grad);
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
\`\`\`

**Panel borders:** \`padding: 1px\` in the pseudo, \`background: var(--border-glass-grad)\`
**Widget card borders:** \`padding: 1.2px\`, \`background: var(--border-glass-grad-widget)\`

**Shadows** — only two tokens, never custom:
\`\`\`
--shadow-glass:       rest state
--shadow-glass-hover: hover/active state
\`\`\`

---

## 3 — Radius Concentricity Rule

> **Outer radius = Inner radius + Padding between them**

This is structural, not decorative. The gap between nested rounded surfaces must look like a uniform ring, not a collision.

\`\`\`
outer_radius = inner_radius + gap_padding

Examples:
  Overlay panel:   38px outer,  22px padding → inner items: 16px
  Widget card:     32px outer,  14px padding → inner items:  9px (floor: 4px)
  Settings panel:  30px outer,  16px padding → inner items: 14px
  Tab pill:        9999px outer, 6px padding → inner: 9999px (pill stays round)
\`\`\`

### Radius scale (exact values)

| Surface | Radius |
|---|---|
| Overlay panels | 38px |
| Widget cards | 32px |
| Settings panel | 30px |
| Card-radius general | 22px (\`--card-radius\`) |
| Analysis tabs | 16px |
| Settings buttons | 14px |
| List row hover bg | 12px |
| Buttons / pills | 9999px (\`--btn-radius\`) |
| Checkboxes | 6px |
| Inner content items | compute: \`parent_radius - parent_padding\` |

**Floor:** If computed inner radius < 4px, use 4px.

---

## 4 — Typography

Two font stacks, strict separation:

| Stack | Token | Used for |
|---|---|---|
| Body | \`--font-body\` | Overlay titles, display headings |
| UI | \`--font-ui\` | ALL controls, labels, badges, stats, widget content |

### Widget card type scale (all \`--font-ui\`)

| Role | Size | Weight | Spacing |
|---|---|---|---|
| Hero number | 3rem or 1.85rem | 800 | -0.04em |
| Hero unit suffix | 0.75rem or 0.6rem | 700 | 0.10em-0.14em |
| Corner label (TL/TR) | 10px | 600 | 0.12em uppercase |
| Corner dim (BL/BR) | 10px | 500 | 0.06em normal case |
| Section header | 10px | 700 | 0.14em uppercase |
| Stat number | 13px | 700 | — |
| Stat key | 10px | 500 | 0.04em |
| Segment label | 10px | 500 | — |
| Badge | 9px | 700 | 0.08em uppercase |
| Trend text | 9-10px | 500-600 | 0.04em |

### Panel/overlay type scale

| Role | Family | Size | Weight | Spacing |
|---|---|---|---|---|
| Panel title | \`--font-body\` | 1.25rem | normal | — |
| Section label | \`--font-ui\` | 9-10.5px | 600-700 | 0.08-0.12em uppercase |
| Button text | \`--font-ui\` | 12px | 600 | 0.04em |
| Tab text | \`--font-ui\` | 11px | 600 | 0.04em |

**Rules:**
- Never use arbitrary font-size values outside this scale.
- Titles are lighter weight; data is heavier weight. Weight is earned by importance.
- Uppercase + wide tracking is reserved for labels and section headers.

---

## 5 — Button System

Both variants share:
\`\`\`
font-family: var(--font-ui)
font-size: 12px
font-weight: 600
letter-spacing: 0.04em
padding: 9px 18px
border-radius: var(--btn-radius)  /* 9999px */
border: 1px solid var(--divider-line)
transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease
\`\`\`

**Primary:** \`background: var(--text)\`, \`color: var(--bg)\`, \`border-color: var(--text)\`. Hover → \`var(--text-secondary)\`.
**Secondary:** \`background: transparent\`, \`color: var(--text-secondary)\`. Hover → \`background: var(--bg-glass-hover)\`, \`color: var(--text)\`.

---

## 6 — Animation & Micro-Interactions

### Easing curves (only these two — no custom curves)

**Spring** (bouncy elements — knobs, toggles, badge reveals):
\`\`\`
cubic-bezier(0.34, 1.56, 0.64, 1)
\`\`\`

**Standard** (fades, backgrounds, border changes):
\`\`\`
ease — 0.12s to 0.18s duration
\`\`\`

### Scale progression (interactive elements)

| State | Scale | Duration |
|---|---|---|
| Rest | 1.0 | — |
| Hover | 1.08 | 0.28s spring |
| Press (toggle/knob) | 1.35 | 0.28s spring |
| Press (slider knob) | 1.62 | 0.28s spring |

Press state creates a "glass puck" — knob becomes translucent, track bleeds through:
\`\`\`css
background: linear-gradient(180deg,
  rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.52) 100%);
box-shadow:
  inset 0 0 0 1px rgba(255,255,255,0.55),
  inset 0 1px 0 rgba(255,255,255,0.85),
  0 2px 6px rgba(0,0,0,0.22),
  0 12px 28px rgba(0,0,0,0.22);
\`\`\`

### Widget mount animation

Staggered reveal: each card delays ~40ms after the previous. CSS transition on \`opacity\` + \`transform\` (translateY up).

### Tab working state

Pulsing icon for "in progress":
\`\`\`css
@keyframes pulse {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.10); }
}
\`\`\`

### Icon button press

\`\`\`css
:active:not(:disabled) { transform: scale(0.88); }
\`\`\`

Scale decreases with surface area — small buttons compress more, large cards less.

---

## 7 — Content Primitives (CSS classes inside widget cards)

These classes exist in the app stylesheet — use them by className in custom widgets:

| Primitive | Class | What it renders |
|---|---|---|
| Content wrapper | \`.wg-content\` | flex column, full width |
| Section group | \`.wg-section\` | flex column, gap: 7px |
| Divider | \`.wg-divider\` | 1px line, rgba(255,255,255,0.07) |
| Header row | \`.wg-header-row\` + \`.wg-header-title\` | 10px uppercase title |
| Header badge | \`.wg-header-badge\` | 9px bold pill |
| Stat | \`.wg-stat\` + \`.wg-stat-num\` + \`.wg-stat-key\` | number + label |
| Segment row | \`.wg-seg\` + \`.wg-seg-dot\` + \`.wg-seg-label\` | colored dot + label |
| Channel bar | \`.wg-channel\` + \`.wg-channel-track\` + \`.wg-channel-fill\` | progress bar |
| Dot separator | \`.wg-dot-sep\` | small dot between inline stats |

---

## 8 — Structural Rules

1. **Padding rhythm** — widget cards use 14px internal padding. Panel surfaces use 16-22px.
2. **Gap rhythm** — use 4px, 7px, 8px, 12px, 14px, 16px. No arbitrary gaps.
3. **Nesting depth** — maximum 2 levels of visual nesting inside a card. Deeper hierarchy = flatten with section labels + dividers.
4. **Content density** — widget cards show 3-5 data points max. If more, use a compact table or expandable sections.
5. **Inline styles** — use \`style={{ }}\` for dynamic values (colors from data, computed widths). Use CSS classes for static structure.
6. **Color from data** — when a tool computes a score, map it to the status palette. Don't invent gradient interpolations.
7. **No scroll inside widget cards** — if content overflows, truncate or use "show more" that opens an overlay.
8. **Sparkline/chart sizing** — width matches card content area. Height: 28-40px for sparklines, 48-80px for rings/gauges.
`;
}

function ensureToolSdk(projectPath) {
  const sdkDir = path.join(projectPath, STRUCTURE.toolsDir);
  if (!fs.existsSync(sdkDir)) fs.mkdirSync(sdkDir, { recursive: true });

  const sdkPath = path.join(sdkDir, 'TOOL_SDK.md');
  if (!fs.existsSync(sdkPath)) {
    fs.writeFileSync(sdkPath, buildToolSdkContent(), 'utf8');
  } else {
    const existing = fs.readFileSync(sdkPath, 'utf8');
    if (!existing.startsWith(TOOL_SDK_MARKER)) {
      fs.writeFileSync(sdkPath, buildToolSdkContent(), 'utf8');
    }
  }

  const designPath = path.join(sdkDir, 'TOOL_DESIGN.md');
  if (!fs.existsSync(designPath)) {
    fs.writeFileSync(designPath, buildToolDesignContent(), 'utf8');
  } else {
    const existing = fs.readFileSync(designPath, 'utf8');
    if (!existing.startsWith(TOOL_DESIGN_MARKER)) {
      fs.writeFileSync(designPath, buildToolDesignContent(), 'utf8');
    }
  }
}

function getAppDataPath() {
  return app.getPath('userData');
}

function getLastProjectPath() {
  try {
    const f = path.join(getAppDataPath(), LAST_PROJECT_FILE);
    if (!fs.existsSync(f)) return null;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (data.path && fs.existsSync(data.path)) return data.path;
    return null;
  } catch { return null; }
}

function setLastProjectPath(projectPath) {
  try {
    const f = path.join(getAppDataPath(), LAST_PROJECT_FILE);
    fs.writeFileSync(f, JSON.stringify({ path: projectPath, updated: Date.now() }), 'utf8');
  } catch { /* ignore */ }
}

function getProjectMeta(projectPath) {
  const metaPath = path.join(projectPath, PROJECT_META_DIR, PROJECT_FILE);
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }
  return null;
}

function saveProjectMeta(projectPath, meta) {
  const metaDir = path.join(projectPath, PROJECT_META_DIR);
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, PROJECT_FILE),
    JSON.stringify(meta, null, 2),
    'utf8'
  );
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`[project-fs] Failed to parse ${filePath}:`, err.message);
    return null;
  }
}

function sanitizeStoryPrimaryBase(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^_+|_+$/g, '');
}

function canonicalStoryPrimaryName(projectPath) {
  const meta = getProjectMeta(projectPath);
  const base = sanitizeStoryPrimaryBase(meta?.name || path.basename(projectPath));
  return base ? `${base}_STORY_PRIMARY.txt` : STRUCTURE.legacyStoryPrimary;
}

function findStoryPrimaryFile(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;

  const entries = fs.readdirSync(projectPath);
  const candidates = [
    canonicalStoryPrimaryName(projectPath),
    STRUCTURE.legacyStoryPrimary,
    ...entries.filter((name) => name.endsWith('_STORY_PRIMARY.txt')),
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const full = path.join(projectPath, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

function hasStoryPrimary(projectPath) {
  return !!findStoryPrimaryFile(projectPath);
}

function isExpectedProjectEntry(name) {
  return name === PROJECT_META_DIR
    || name === PROJECT_NOVEL_FILE
    || name === STRUCTURE.config
    || name === STRUCTURE.namingRef
    || name === STRUCTURE.anchorsDir
    || name === STRUCTURE.draftsDir
    || name === STRUCTURE.canonDir
    || name === STRUCTURE.sceneBankDir
    || name === STRUCTURE.reviewLogsDir
    || name === STRUCTURE.tempDir
    || name === STRUCTURE.systemDir
    || name === STRUCTURE.legacyStoryPrimary
    || name === '.claude'
    || name === 'CLAUDE.md'
    || /_STORY_PRIMARY\.txt$/i.test(name);
}

function findUnexpectedUninitializedEntries(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const ignorable = new Set(['.DS_Store', 'Thumbs.db']);
  return fs.readdirSync(dirPath)
    .filter((name) => !ignorable.has(name))
    .filter((name) => !isExpectedProjectEntry(name));
}

function isRendererProject(dirPath) {
  return (
    fs.existsSync(path.join(dirPath, PROJECT_META_DIR, PROJECT_FILE)) ||
    fs.existsSync(path.join(dirPath, STRUCTURE.config)) ||
    fs.existsSync(path.join(dirPath, STRUCTURE.systemDir))
  );
}

function ensureProjectDirs(projectPath) {
  const dirs = [
    PROJECT_META_DIR,
    STRUCTURE.anchorsDir,
    STRUCTURE.draftsDir,
    STRUCTURE.canonDir,
    STRUCTURE.sceneBankDir,
    STRUCTURE.reviewLogsDir,
    STRUCTURE.tempDir,
    STRUCTURE.toolsDir,
  ];
  for (const d of dirs) {
    const full = path.join(projectPath, d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }
  ensureSystemDir(projectPath);
  ensureToolSdk(projectPath);
  ensureClaudeConfig(projectPath);
}

function buildClaudeMdContent(projectName, storyPrimaryName) {
  return `# ${projectName} — Latent Write Project

The \`novel-writing-system/\` folder contains the full framework. This file is your operating manual — sufficient to run every pipeline operation autonomously. Consult framework files for deep technique detail; do not paste their contents into chat.

**Path translation:** Framework docs reference \`NovelDraft/drafts/\`, \`NovelDraft/temp/\`, etc. In this project the root IS the working directory. Drop the \`NovelDraft/\` prefix — use \`drafts/\`, \`temp/\`, \`anchors/\` directly.

---

## 0 — Session Entry Protocol (DO THIS EVERY TIME)

**Every session — new or continued — begins here. Do not skip.**

### Step 1: Check for \`_START_HERE.md\`

If \`_START_HERE.md\` exists in this project, **read it now.** It is the novel-specific agent entry point — it contains binding quality rules, load order, pipeline customizations, and prose discipline that override the generic instructions in this file. Everything in _START_HERE.md takes precedence. Follow its instructions from that point on.

If \`_START_HERE.md\` does not exist, continue with this file.

### Step 2: Identify session type

| Session type | How to detect | Entry path |
|---|---|---|
| **New project** | \`NOVEL_CONFIGURATION.md\`, \`NAMING_REFERENCE.md\`, and \`${storyPrimaryName}\` are missing or empty | → §10 Initialization |
| **Existing project, new session** | Core files exist, but you have no prior conversation context | → Step 3 below |
| **Continuation** | You already have context from earlier in this conversation | → Step 4 below |

### Step 3: State assessment (existing project, new session)

Before doing anything else, quickly assess where the project stands:

1. **Read the latest anchor file** in \`anchors/\` — this is the fastest way to get oriented. It snapshots character states, timeline positions, and open threads as of the last batch.
2. **Scan \`drafts/\`** — what is the highest chapter number? Are there any chapters with only v1 (unfinished pipeline)?
3. **Scan \`review-logs/\`** — are there pending eval loops (eval file exists without a subsequent higher-version draft)?
4. **Check story primary Section 10** — what is the next unwritten chapter entry?
5. **Check for novel-specific reference files** beyond the standard set. Some novels use additional files (cross-timeline mappings, world bibles, thematic trackers). Read any \`.md\` or \`.txt\` files in the project root that aren't part of the standard directory structure.

After assessment, tell the user what you found: latest chapter, project state, and what you recommend as the next step. Then proceed to Step 4.

### Step 4: Classify the task

→ See §4 for task classification. If the user hasn't specified a task, recommend one based on your state assessment. Never guess silently.

### Story Primary §0: Read Every Session

Regardless of task type, **read story primary Section 0 (Writing Directives) every session** before producing prose. Section 0 contains the binding voice rules, hard prohibitions, and register descriptions that govern every line. Do not rely on memory from prior sessions — re-read it.

---

## 1 — File Format Rules (STRICT)

Prose/narrative content → \`.txt\`. Structured reference/planning docs → \`.md\`.

| File type | Ext | Naming pattern | Example |
|-----------|-----|---------------|---------|
| Story primary | .txt | \`{Name}_STORY_PRIMARY.txt\` | \`${storyPrimaryName}\` |
| Novel configuration | .md | \`NOVEL_CONFIGURATION.md\` | |
| Naming reference | .md | \`NAMING_REFERENCE.md\` | |
| Chapter drafts | .txt | \`drafts/ch{N}_v{V}.txt\` | \`drafts/ch4_v1.txt\`, \`drafts/ch4_v2.txt\` |
| Anchors | .txt | \`anchors/anchor_v{V}_ch{A}-{B}.txt\` | \`anchors/anchor_v1_ch1-10.txt\` |
| Canon novel | .txt | \`novel.txt\` | app-managed |
| Context packets | .md | \`temp/context_packet_ch{N}.md\` | \`temp/context_packet_ch12.md\` |
| Scene bank | .md | \`scene-bank/scene_bank_ch{A}-{B}.md\` | \`scene-bank/scene_bank_ch1-5.md\` |
| Scan reports | .md | \`review-logs/scan-reports/scan_ch{N}_v{V}.md\` | |
| Eval reports | .md | \`review-logs/eval/eval_ch{N}_v{V}.md\` | |
| Edit logs | .md | \`review-logs/edit-logs/edit_ch{N}.md\` | |
| _START_HERE.md | .md | \`_START_HERE.md\` | novel-specific entry point |

**Draft naming:** \`ch{N}_v{V}.txt\` — N = chapter number (no leading zeros), V = version (v1 = first draft, v2 = after expansion/compression, v3 = after line pass). Optional suffix: \`ch4_v1_skeleton.txt\`. No title slugs, no "draft" suffix.

**Prose formatting (STRICT — applies to all .txt files):**
- Scene breaks: \`* * *\` only (asterisk space asterisk space asterisk). Three asterisks with spaces between.
- **NEVER use** \`---\`, \`***\`, \`===\` (except the chapter marker), \`##\`, or any markdown/HTML formatting inside prose.
- No headings, no horizontal rules, no bold/italic markers, no bullet lists inside chapter text.
- Chapter text is plain prose. The only structural elements are: the \`===CHAPTER N: TITLE===\` marker at the top, \`* * *\` between scenes, and the optional \`[word count: N]\` at the end.

## 2 — Directory Structure

\`\`\`
${projectName}/
  ${storyPrimaryName}       ← novel bible (.txt)
  NOVEL_CONFIGURATION.md    ← voice, length, eval weights, disruption registers
  NAMING_REFERENCE.md       ← every proper noun, locked before drafting
  _START_HERE.md            ← novel-specific agent entry point (built after init)
  novel.txt                 ← combined novel for app (do not hand-edit)
  novel-writing-system/     ← framework docs (read-only)
    templates/              ← fillable templates for all document types
  drafts/                   ← versioned chapter drafts (.txt)
  anchors/                  ← world-state snapshots (.txt)
  canon/                    ← assembled final chapters
  scene-bank/               ← scene planning (.md)
  review-logs/
    scan-reports/           ← prose scan results (.md)
    eval/                   ← dimension scores (.md)
    edit-logs/              ← edit records (.md)
    comparisons/
    verification/
  temp/                     ← context packets, working files (.md)
  .renderer/                ← app state (do not edit)
\`\`\`

**If any directory is missing, create it before writing files into it.** The app scaffolds these on project creation, but they may be absent if the project was set up manually.

## 3 — novel.txt Format

The app parses \`novel.txt\` to populate the chapter sidebar:

\`\`\`
===TITLE===
Novel Title

===AUTHOR===
Author Name

===CHAPTER 1: Chapter Title===
Chapter prose here...

===CHAPTER 2: Next Title===
...
\`\`\`

Chapter marker: exactly \`===CHAPTER N: TITLE===\` (N = integer, no leading zero).

---

## 4 — Task Classification (AFTER Session Entry)

Before loading files or producing prose, classify the task:

| Task | When | Pipeline |
|------|------|----------|
| **A. New chapter draft** | Chapter N does not exist as prose | §5 full pipeline |
| **B. Expansion pass** | Chapter exists but below word floor or scene-thin | Load files → expansion → eval loop |
| **C. Prose review** | Plot correct, prose needs work | Load files → scan → targeted passes |
| **D. Eval loop** | Chapter drafted, needs scan/eval/passes until assembly gate | §6 eval loop |
| **E. Canon assembly** | Chapter passed eval, ready for novel.txt | §5 Phase 6-7 |
| **F. Section 10 planning** | Story primary needs new chapter entries | Load story primary → write entries |
| **G. Question / lookup** | User asking about the novel, not producing prose | Load only what the question requires |

If the user has not specified, assess project state and recommend. Do not guess task type silently.

### Multi-chapter commands

When the user says "write next 5 chapters" or "expand these 4 chapters" or any batch:
1. Identify the chapter range (e.g., Ch 12-16)
2. Verify Section 10 has entries for all chapters in the range. If not, plan them first (Task F).
3. **Process each chapter through the full pipeline sequentially.** Do not skip eval for any chapter. Each chapter must reach at least v2 before starting the next.
4. After each chapter: run artifact updates (Phase 7). After the batch: write a new anchor, run batch-level motif check.
5. Tell the user the batch plan upfront: "I'll draft Ch 12-16. Each chapter will go through context packet → skeleton → expansion → lore check → eval loop. I'll update artifacts after each and write an anchor after the batch."

### Resolving vague commands

Users often say things that don't map directly to a task type. Resolve them:

| User says | What they mean | What you do |
|---|---|---|
| "make it better" / "improve this" | Prose quality is unsatisfying | Run standard scan on the chapter → identify specific issues → tell the user what you found → run targeted passes per §6 eval loop |
| "fix this" / "this doesn't work" | Something is wrong but unspecified | Read the chapter → run scan → categorize issues (lore? prose? structure?) → report findings → propose specific fixes |
| "it feels flat" / "it's boring" | Scene pressure or emotional texture is weak | Check scene_pressure, dialogue_humanity, sensory_grounding scores → likely needs Embodiment or Destabilization pass, or scene reconstruction if structural |
| "expand this" / "make it longer" | Chapter is underweight | Classify as Task B → run expansion protocol, not padding |
| "keep going" / "continue" | Write the next chapter | Assess state → identify next unwritten chapter → run Task A pipeline |
| "do the review" / "check quality" | Run eval loop | Classify as Task D → run §6 |
| "rewrite this" | Chapter needs major revision | Run scan first → if PRIMARY < 6 anywhere → scene reconstruction, not prose polish |
| "read start here and write" | Full autonomous mode | Read _START_HERE.md → assess state → identify next chapter(s) → run pipeline |

**Never respond to a vague command with just "what do you mean?" Instead:** assess the chapter's current state, tell the user what you found, and propose specific actions.

---

## 5 — Chapter Pipeline (Full: Task A)

### Per-Session Load Order (BINDING)

Before producing or evaluating prose, load in this order:
1. \`NOVEL_CONFIGURATION.md\` — voice rules, chapter length, eval weights, hard prohibitions
2. Story primary — **Section 0 in full every time** + relevant arc material + target chapter entry from Section 10
3. Latest anchor file in \`anchors/\` — world state, character positions, timeline
4. \`NAMING_REFERENCE.md\`
5. Previous 2 chapters in the same thread (voice continuity). If the novel has multiple threads/timelines, also load the most recent chapter from the other thread for cross-thread grounding.
6. Relevant scene-bank entries
7. Active review logs for this chapter (if revision)
8. Any novel-specific reference files (cross-timeline mappings, world bibles, thematic trackers) when the chapter touches their content

### Phase 0: Build Context Packet → \`temp/context_packet_ch{N}.md\`

Context packets are session-scoped working memory — create them freely, they are disposable. Use template: \`novel-writing-system/templates/context-packet-template.md\`. Populate with:

\`\`\`markdown
# Context Packet — Chapter {N}: {Title}

**Thread:** {timeline/POV thread}
**Timeline:** {when this takes place}
**POV:** {character} ({POV mode from config})
**Word target:** {from NOVEL_CONFIGURATION.md}

## Chapter Function
{What this chapter does — from story primary arc entry}

## Required Beats
{Verbatim from story primary — character beats, prose directive, constraints}

## Scene List ({count} scenes)
1. {location} — {dramatic purpose} — {what changes} — {residue}
2. ...

## Character Notes
{Per character: knowledge state, pressure, behavioral register from latest anchor}

## Open Threads
{Must appear / must NOT resolve}

## Locks
{Names, numbers, timeline, relationships, motifs locked for this chapter}

## Sensory Anchors
{Key physical details — objects, spaces, weather, textures}

## Forbidden
{No-go items, foreshadowing restrictions, prohibited patterns}
\`\`\`

### Phase 1: Load Relevant Canon
Do not load wide chapter ranges. Follow the per-session load order above.

### Phase 2: Scene Bank Pass
Build scene list BEFORE drafting. Per scene: POV, location, dramatic purpose, conflict pressure, what changes, what residue remains. Minimum 2-4 scenes per chapter.

Translate story primary beats → scenes. Beat = intent (what character does). Scene = event (what situation forces it). Keep separate. Check beat progression: is this chapter's beat a visible step forward in the character's arc, not the same pressure in new clothing?

### Phase 3: Skeleton Draft → \`drafts/ch{N}_v1.txt\`
First pass, 1,400-2,200 words. Requirements: all beats present, no fact contradictions, no missing transitions, every scene changes something (knowledge, pressure, intimacy, leverage, or emotional cost).

**Over-and-Cut technique (recommended):** Draft at **120% of chapter max** — overshoot deliberately. The compression pass (Phase 4b) cuts to target. Cutting excess is cleaner than inflating thin prose.

### Phase 4a: Expansion → \`drafts/ch{N}_v2.txt\`
Reach target word count. **Allowed:** extend negotiation, add environmental resistance, interrupted thought, physical actions altering power/tempo, aftermath beats, transitions with emotional carryover. **Forbidden:** repeating known info, philosophical restatement, exposition summary, generic emotion labels.

### Phase 4b: Compression (if Over-and-Cut or over-length)
Cut in this order: annotation sentences → acquisition backstory → belief elaboration after statement → scene exit summaries → restatements in different language → explanatory dialogue beats. If a cut weakens the chapter, the chapter was underpowered — fix the scene, don't restore the cut.

### Phase 4.5: Lore Consistency Check (BINARY GATE)
Three required checks:
- **Timeline arithmetic** — for every duration, write the calculation explicitly: "Month 6 (Ch 12) + 2 months = Month 8 (Ch 15). Consistent."
- **Naming cross-check** — every proper noun matches naming reference exactly. New nouns added before assembly.
- **Knowledge boundary** — each character acts only on info they could possess. Check character state ledger.

Any P1 lore failure halts progress. Fix immediately.

### Phase 5: Line Pass / Prose Review → \`drafts/ch{N}_v3.txt\`
Run the standard scan first (named-pattern checklist from \`novel-writing-system/PROSE_REVIEW_PROTOCOL.md\`). Then proceed to §6 eval loop.

### Phase 6: Canon Assembly → \`novel.txt\`
Only after the eval loop gate passes:
- Merge into \`novel.txt\` with correct \`===CHAPTER N: TITLE===\` markers
- Verify neighboring chapter transitions are intact

### Phase 7: Artifact Update (DO NOT SKIP)
Skipping artifact updates creates state drift that compounds every chapter. After assembly, update ALL that apply:
- **Naming reference** — add new proper nouns, marked \`[ADDED Ch N]\`
- **Anchor file** — write new anchor if batch closes a range (every 5-10 chapters)
- **Story primary Section 4** — update character knowledge/location state
- **Story primary Section 5** — update relationship state changes
- **Story primary Section 6** — update political/faction state if changed
- **Story primary Section 8** — update open thread statuses
- **Story primary Section 9** — update motif ledger if a motif appeared
- **Story primary Section 10** — mark chapter entry as \`[DRAFTED]\` or \`[ASSEMBLED]\`
- **Scene bank** — mark entries \`used\`, \`deferred\`, or \`dropped\`
- **NOVEL_CONFIGURATION.md** — add disruption register if new POV character
- **_START_HERE.md** — update if the novel's binding rules, load order, or quality discipline changed

---

## 6 — Eval Loop (Quality Gate)

This loop separates "drafted" from "ready for canon." Full scoring details: \`novel-writing-system/SMART_PASS_PROTOCOL.md\`.

**All eval outputs go to files.** Do not run eval passes inline in conversation. Write scan reports, eval scores, and pass results to the appropriate files in \`review-logs/\`.

**Loop steps:**

1. **Scan** — Run standard scan (named patterns from PROSE_REVIEW_PROTOCOL). Save to \`review-logs/scan-reports/scan_ch{N}_v{V}.md\`.
2. **Eval** — Score on every active dimension from NOVEL_CONFIGURATION.md. Save to \`review-logs/eval/eval_ch{N}_v{V}.md\`.
3. **Lore check** (binary gate) — Timeline arithmetic, naming, knowledge boundary. P1 failure → fix → restart at step 1.
4. **Length check** — Outside target range? Run compression (over) or expansion (under) → restart at step 1.
5. **Targeted passes** — For each PRIMARY dimension scoring 6-7, run the targeted pass per SMART_PASS_PROTOCOL. Run order: Compression → Voice Calibration → Arc Coherence → Embodiment → Destabilization. Never run Destabilization before Embodiment.
6. **Re-eval** — return to step 2.
7. **Assembly gate passes when:**
   - Lore integrity: PASS
   - All PRIMARY dimensions >= 7
   - SECONDARY average >= 6, no SECONDARY < 5
   - Length: in target window
8. **Iteration cap:** If the same chapter cycles 5 times on the same dimension, STOP. Report to user. The planning is broken, not the prose.

---

## 7 — Review Pass Reference

| Pass | Trigger | What it does |
|------|---------|--------------|
| Standard Scan | Every chapter | Named failure patterns (over-explanation, acquisition backstory, belief elaboration) |
| Lore Check | Every chapter | Timeline arithmetic, naming, knowledge boundaries |
| Light Pass | All dims >= 8 | Minimal mechanical fixes |
| Standard Pass | Default | AI fingerprint removal, prose quality, scene execution |
| Expansion-Coupled | Below 80% word target | Add scenes, then review |
| Compression | Above 110% target, or OAC active | Cut in priority order (see Phase 4b) |
| Embodiment | Sound structure, reads at distance | Sensory grounding, lived experience |
| Destabilization | Correct but airless | Asymmetry, avoidance, interruption, imprecision (1-2 moments max) |
| Voice Calibration | Voice < 7 or long gap | Realign to NOVEL_CONFIGURATION voice rules |
| Arc Coherence | Arc coherence < 7 | Character beats not advancing trajectory |

---

## 8 — Output Discipline

**ALL long-form output goes to FILES, not chat.** This is non-negotiable.

| Producing... | Save to | Format |
|-------------|---------|--------|
| Chapter draft | \`drafts/ch{N}_v{V}.txt\` | \`===CHAPTER N: TITLE===\` header, plain prose, \`* * *\` scene breaks, \`[word count: N]\` final line |
| Context packet | \`temp/context_packet_ch{N}.md\` | See §5 Phase 0 template |
| Scan report | \`review-logs/scan-reports/scan_ch{N}_v{V}.md\` | Pattern → location → severity → fix |
| Eval report | \`review-logs/eval/eval_ch{N}_v{V}.md\` | Dimension → score 1-10 → rationale → ceiling/floor flags |
| Story primary update | Edit in place | Mark \`[updated YYYY-MM-DD]\` on changed sections |
| Naming ref update | Edit in place | New entries marked \`[ADDED Ch N]\` |

**In chat:** share brief summaries, key findings, decision points, and file paths. Never paste full drafts, full framework docs, or full file contents into the conversation. When you read project files for context, summarize — don't quote. When you read framework files for instructions, follow them silently — don't reproduce them.

---

## 9 — Initialization (New Novel)

If \`NOVEL_CONFIGURATION.md\`, \`NAMING_REFERENCE.md\`, and \`${storyPrimaryName}\` do not exist or are incomplete, the project needs initialization. Full protocol: \`novel-writing-system/FROM_SCRATCH_PIPELINE.md\`.

**Two input types:**
- **Story Bible** — structured plan. Run phases S0-S5.
- **Rough Draft** — existing prose. Run phases R0-R4, then S1-S3.

**Initialization order (do not skip):**

1. **Naming Reference** — extract every proper noun. Mark \`[INITIALIZED]\`. Must be complete before drafting.
2. **Story Primary** (\`${storyPrimaryName}\`) — the novel bible, outranks all artifacts. Use \`novel-writing-system/STORY_PRIMARY_FORMAT.md\`.
   - Section 0 (Writing Directives) MUST be complete before drafting
   - Sections 1-5 must be populated
   - Sections 6-9 populated or marked \`[NOT YET ESTABLISHED]\`
   - Section 10: plan first 10 chapters in chapter-entry format
3. **Novel Configuration** — use template \`novel-writing-system/templates/novel-config-template.md\`.
4. **Seed Chapters (Ch 1-10)** — word minimum relaxed for Ch 1-5. All motifs planted by Ch 5. Voice check after Ch 3.
5. **First Anchor** — write after Ch 10 assembled.
6. **Build \`_START_HERE.md\`** — after initialization is complete (core files exist, first chapters drafted), construct the novel-specific agent entry point. See §9.1 below.

**Complete when:** all three core files exist and are populated, Section 0 is complete, Section 10 has Ch 1-10.

### §9.1 — Constructing _START_HERE.md

\`_START_HERE.md\` is what allows any future session — on any model, with no prior context — to operate autonomously on this novel. Build it after the first batch of seed chapters, when the novel's rules and patterns are established.

**Structure:**

\`\`\`markdown
# _START_HERE.md — {Novel Title}: Agent Execution Entry Point

**Read this file first, every time, no matter the task.**

## 1 — Identify the novel
Title, working protagonist(s), format, chapter count, word target, working directory, canon file path.

## 2 — Identify the task type
(Copy the task classification table from this CLAUDE.md §4, or customize if the novel has additional task types.)

## 3 — Pipelines
For each task type: specific load order, pipeline phases, hard checks. Customize load order with novel-specific files (cross-timeline mappings, world bibles, etc.). Include the context packet template with novel-specific fields.

## 4 — Quality Discipline (binding)
Extract from NOVEL_CONFIGURATION.md and story primary §0:
- Voice register rules (per POV character if multi-POV)
- Hard prohibitions (what this novel must never do)
- Reveal sequence rules (what cannot be confirmed before which chapter)
- POV discipline (rules specific to this novel)
- Any withholding rules (names, events, info that must not appear in prose)

## 5 — When stuck
Default decisions for this novel (quieter, shorter, withhold, body over abstraction, delay reveal).

## 6 — Output format expectations
Where each file type goes, naming conventions, chapter marker format.

## 7 — The reference system
Table of framework files and when to consult each.

## 8 — Update log
Track when _START_HERE.md was created and updated.
\`\`\`

**Key principles:**
- _START_HERE.md centralizes everything a cold-start model needs. A model reading only this file should be able to draft a chapter correctly.
- It does NOT duplicate the full framework — it references framework files for deep technique detail.
- It DOES contain novel-specific binding rules verbatim (not by reference), because these must be in front of the model before every line-level decision.
- Update it when novel rules change (new POV characters, new withholding rules, new reference files).

---

## 10 — Framework Reference

| Need... | File |
|---------|------|
| Full chapter pipeline detail | \`novel-writing-system/CANONICAL_PIPELINE.md\` |
| Eval dimensions + pass decision flow | \`novel-writing-system/SMART_PASS_PROTOCOL.md\` |
| Named-pattern scan checklist | \`novel-writing-system/PROSE_REVIEW_PROTOCOL.md\` |
| Story primary section guide | \`novel-writing-system/STORY_PRIMARY_FORMAT.md\` |
| Scene bank + 7→9 expansion moves | \`novel-writing-system/SCENE_BANK_AND_EXPANSION.md\` |
| Over-and-Cut + AI drafting techniques | \`novel-writing-system/WRITING_TECHNIQUES.md\` |
| From-scratch initialization | \`novel-writing-system/FROM_SCRATCH_PIPELINE.md\` |
| Quick orientation | \`novel-writing-system/SYSTEM_INDEX.md\` |
| Templates (all doc types) | \`novel-writing-system/templates/\` |

Load these when their specific guidance is needed. Do not preload all. Do not paste their contents into chat.

**If \`novel-writing-system/\` is missing or empty:** This file contains enough pipeline detail to operate. Use the built-in instructions (§5 pipeline, §6 eval loop, §7 passes) directly. The framework files provide deeper technique definitions and templates but are not strictly required for basic operation. If the user asks you to follow a specific framework file that doesn't exist, inform them and offer to proceed with the instructions in this file.

---

## 11 — Workflow Guidance

**Before any work request, assess:**
1. Does \`_START_HERE.md\` exist? → read it first, it takes precedence.
2. Do initialization files exist? If not → guide through init (§9).
3. What chapters exist in \`drafts/\` and \`novel.txt\`? → determines what is ready and what is next.
4. Is there a recent anchor? → fastest way to get oriented on project state.
5. Are there unfinished pipelines (v1 without v2, eval without subsequent revision)? → those should be completed before starting new chapters.

**Map user intent:**

| User says | Action |
|-----------|--------|
| "Start" / "set up" / "initialize" | Check init state, guide through FROM_SCRATCH_PIPELINE |
| "Write chapter X" / "next chapter" | Task A → run full pipeline §5 |
| "Write next N chapters" / "draft 5 chapters" | Multi-chapter batch → see §4 multi-chapter protocol |
| "Continue" / "keep going" / "read start here and write" | Read _START_HERE.md → assess state → identify next chapter → run pipeline |
| "Review" / "check quality" / "do the review" | Task C or D → run scan → eval loop §6 |
| "Make it better" / "improve" / "fix this" | See §4 vague command resolution table |
| "Expand this" / "make it longer" | Task B → expansion pass, not padding |
| "It feels flat" / "boring" / "lifeless" | Scan → check scene pressure, sensory grounding, dialogue humanity → Embodiment or Destabilization pass |
| "Until quality meets" / "until it's good enough" | Run full eval loop §6 — "quality meets" = assembly gate passes (all PRIMARY ≥ 7, SECONDARY avg ≥ 6, lore PASS) |
| "Lore check" | Run Phase 4.5 checks |
| "Finalize" / "assemble" | Task E → Phase 6-7 |
| "Plan next chapters" | Task F → extend Section 10 |
| "What should I do next?" | Read state, recommend next step |
| Vague / unclear | Assess chapter state, tell user what you found, offer 2-3 specific options |

**When unsure:** state what you think they want, recommend, offer options. Don't ask open-ended questions without also suggesting a concrete action.

**When stuck on a prose decision, default to:** the quieter option, the shorter option, the one that withholds rather than confirms, the one that uses the body rather than the abstraction, the one that delays the reveal.

**Batch workflow:** When drafting multiple chapters in sequence, complete each chapter through the full pipeline (at least v2 + eval) before starting the next. Write a new anchor after every 5-10 chapter batch. Run batch-level motif frequency checks at the batch close. Report progress to the user between chapters: "Ch 12 assembled. Starting Ch 13."

## 12 — Rules (Non-Negotiable)

- All project files in **project root**. Never inside \`novel-writing-system/\`.
- Story primary: \`${storyPrimaryName}\`
- **Prose files .txt. Reference/planning files .md. No exceptions.**
- Drafts: \`ch{N}_v{V}.txt\` in \`drafts/\`. No title slugs, no leading zeros in chapter numbers.
- Anchors: \`anchor_v{V}_ch{A}-{B}.txt\` in \`anchors/\`.
- Names must exist in NAMING_REFERENCE.md BEFORE appearing in prose.
- Timeline durations must be verifiable by explicit arithmetic.
- Do not skip pipeline phases for major chapter work.
- Do not invent next-task scope if the user hasn't specified. Ask.
- Write complete content. Never empty placeholder files.
- **Always write output to files.** Drafts, evals, scans, and context packets are files, not chat messages.
- **No markdown in prose files.** No \`---\`, \`***\`, \`##\`, or formatting inside .txt chapter files. Scene breaks are \`* * *\` only.
- **Read story primary §0 every session.** Do not draft from memory of voice rules.
- **Read _START_HERE.md every session** (if it exists). It is the novel's constitution.

---

## Custom Tools

This project supports custom per-project tools (slash commands, widgets, side panels, overlays). If the user asks to create, modify, or manage tools:

1. **Read \`tools/TOOL_SDK.md\`** — component API, manifest format, assembly instructions.
2. **Read \`tools/TOOL_DESIGN.md\`** (only when building custom UI) — color system, border treatment, typography, radius concentricity, micro-interactions. You are a professional designer when creating visual components.

Do not attempt tool creation without reading TOOL_SDK.md. Custom tools must be enabled in Settings → Advanced → Custom Tool Plugins before they will load.
`;
}

function ensureClaudeConfig(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const hooksDir = path.join(claudeDir, 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookScriptPath = path.join(hooksDir, CLAUDE_PROJECT_BOUNDARY_HOOK_FILE);
  if (!fs.existsSync(hookScriptPath) || fs.readFileSync(hookScriptPath, 'utf8') !== CLAUDE_PROJECT_BOUNDARY_HOOK_SOURCE) {
    fs.writeFileSync(hookScriptPath, CLAUDE_PROJECT_BOUNDARY_HOOK_SOURCE, 'utf8');
  }

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const settings = readJsonObject(settingsPath);
  if (settings === null) return;

  if (!settings.permissions) {
    settings.permissions = {
      permissions: {
        allow: ['Read', 'Write', 'Edit', 'Bash(*)'],
        deny: [],
      },
    }.permissions;
  }

  const preToolUse = Array.isArray(settings.hooks?.PreToolUse)
    ? [...settings.hooks.PreToolUse]
    : [];
  const isBoundaryHook = (hook) => (
    hook?.type === 'command'
    && hook.command === 'node'
    && Array.isArray(hook.args)
    && hook.args[0] === CLAUDE_PROJECT_BOUNDARY_HOOK_ARG
  );
  const boundaryHook = {
    type: 'command',
    command: 'node',
    args: [CLAUDE_PROJECT_BOUNDARY_HOOK_ARG],
    timeout: 5,
  };
  const boundaryGroupIndex = preToolUse.findIndex((group) => (
    Array.isArray(group?.hooks) && group.hooks.some(isBoundaryHook)
  ));

  if (boundaryGroupIndex >= 0) {
    const existingGroup = preToolUse[boundaryGroupIndex];
    preToolUse[boundaryGroupIndex] = {
      ...existingGroup,
      matcher: 'Write|Edit|Bash',
      hooks: existingGroup.hooks.map((hook) => (isBoundaryHook(hook) ? boundaryHook : hook)),
    };
  } else {
    preToolUse.unshift({
      matcher: 'Write|Edit|Bash',
      hooks: [boundaryHook],
    });
  }

  settings.hooks = {
    ...(settings.hooks || {}),
    PreToolUse: preToolUse,
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  const meta = getProjectMeta(projectPath);
  const projectName = meta?.name || path.basename(projectPath);
  const storyPrimaryName = `${projectName.replace(/\s+/g, '_')}_STORY_PRIMARY.txt`;

  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, buildClaudeMdContent(projectName, storyPrimaryName), 'utf8');
  } else {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (!existing.includes('Session Entry Protocol')) {
      fs.writeFileSync(claudeMdPath, buildClaudeMdContent(projectName, storyPrimaryName), 'utf8');
    } else if (!existing.includes('tools/TOOL_SDK.md')) {
      const toolsSection = `\n---\n\n## Custom Tools\n\nThis project supports custom per-project tools (slash commands, widgets, side panels, overlays). If the user asks to create, modify, or manage tools:\n\n1. **Read \\\`tools/TOOL_SDK.md\\\`** — component API, manifest format, assembly instructions.\n2. **Read \\\`tools/TOOL_DESIGN.md\\\`** (only when building custom UI) — color system, border treatment, typography, radius concentricity, micro-interactions. You are a professional designer when creating visual components.\n\nDo not attempt tool creation without reading TOOL_SDK.md. Custom tools must be enabled in Settings → Advanced → Custom Tool Plugins before they will load.\n`;
      fs.appendFileSync(claudeMdPath, toolsSection, 'utf8');
    }
  }
}

function listDir(dirPath, ext) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(f => !ext || f.endsWith(ext))
    .sort()
    .map(f => ({
      name: f,
      path: path.join(dirPath, f),
      size: fs.statSync(path.join(dirPath, f)).size,
      mtime: fs.statSync(path.join(dirPath, f)).mtimeMs,
    }));
}

const PROJECT_TREE_PREVIEWABLE_EXTENSIONS = new Set(['.md', '.txt']);
const PROJECT_TREE_IGNORED_NAMES = new Set([
  PROJECT_META_DIR,
  '.DS_Store',
  '.git',
  '.svn',
  'node_modules',
]);

function shouldIncludeProjectTreeEntry(name) {
  if (PROJECT_TREE_IGNORED_NAMES.has(name)) return false;
  return !name.startsWith('.');
}

function sortProjectTreeNodes(left, right) {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeProjectRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function buildProjectTree(dirPath, rootPath = dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => shouldIncludeProjectTreeEntry(entry.name))
    .flatMap((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = normalizeProjectRelativePath(path.relative(rootPath, fullPath));

      if (entry.isDirectory()) {
        return [{
          name: entry.name,
          path: relativePath,
          type: 'directory',
          supported: false,
          children: buildProjectTree(fullPath, rootPath),
        }];
      }

      if (!entry.isFile()) return [];

      return [{
        name: entry.name,
        path: relativePath,
        type: 'file',
        supported: PROJECT_TREE_PREVIEWABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
      }];
    })
    .sort(sortProjectTreeNodes);
}

function registerProjectFS() {
  // Open existing project directory
  ipcMain.handle('project:open', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Open Renderer Project',
      properties: ['openDirectory'],
      buttonLabel: 'Open Project',
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };

    const dirPath = filePaths[0];

    if (!isRendererProject(dirPath)) {
      const unexpectedEntries = findUnexpectedUninitializedEntries(dirPath);
      if (unexpectedEntries.length > 0) {
        const preview = unexpectedEntries.slice(0, 6).map((name) => `• ${name}`).join('\n');
        const extra = unexpectedEntries.length > 6 ? `\n• +${unexpectedEntries.length - 6} more` : '';
        const warning = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Use This Folder', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          message: 'This folder is not initialized as a Latent Write project.',
          detail:
            'It already contains files or folders that are not part of the standard project structure. Continuing will add Latent Write project files into this directory.\n\n'
            + `${preview}${extra}`,
        });
        if (warning.response !== 0) return { ok: false, canceled: true };
      }

      ensureProjectDirs(dirPath);
      saveProjectMeta(dirPath, {
        name: path.basename(dirPath),
        created: Date.now(),
        lastOpened: Date.now(),
      });
    } else {
      ensureToolSdk(dirPath);
      ensureClaudeConfig(dirPath);
      const meta = getProjectMeta(dirPath) || {};
      meta.lastOpened = Date.now();
      saveProjectMeta(dirPath, meta);
    }

    _openProjectPath = dirPath;
    setLastProjectPath(dirPath);

    return { ok: true, path: dirPath, meta: getProjectMeta(dirPath) };
  });

  // Create new project in selected directory
  ipcMain.handle('project:create', async (_event, { name }) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Create Renderer Project',
      defaultPath: path.join(app.getPath('documents'), name || 'MyNovel'),
      buttonLabel: 'Create',
      properties: ['createDirectory'],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const dirPath = filePath;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    ensureProjectDirs(dirPath);
    saveProjectMeta(dirPath, {
      name: name || path.basename(dirPath),
      created: Date.now(),
      lastOpened: Date.now(),
    });
    _openProjectPath = dirPath;
    setLastProjectPath(dirPath);
    return { ok: true, path: dirPath, meta: getProjectMeta(dirPath) };
  });

  // Get current open project path
  ipcMain.handle('project:current', () => {
    if (!_openProjectPath) return null;
    return {
      path: _openProjectPath,
      meta: getProjectMeta(_openProjectPath),
      hasConfig: fs.existsSync(path.join(_openProjectPath, STRUCTURE.config)),
      hasStoryPrimary: hasStoryPrimary(_openProjectPath),
      hasNamingRef: fs.existsSync(path.join(_openProjectPath, STRUCTURE.namingRef)),
      hasSystem: fs.existsSync(path.join(_openProjectPath, STRUCTURE.systemDir)),
    };
  });

  // Read a file from the project
  ipcMain.handle('project:readFile', (_event, relativePath) => {
    if (!_openProjectPath) return { ok: false, error: 'No project open' };
    const full = path.join(_openProjectPath, relativePath);
    if (!fs.existsSync(full)) return { ok: false, error: 'File not found' };
    return { ok: true, content: fs.readFileSync(full, 'utf8'), path: full };
  });

  // Write a file to the project
  ipcMain.handle('project:writeFile', (_event, relativePath, content) => {
    if (!_openProjectPath) return { ok: false, error: 'No project open' };
    const full = path.join(_openProjectPath, relativePath);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { ok: true, path: full };
  });

  // List drafts
  ipcMain.handle('project:listDrafts', () => {
    if (!_openProjectPath) return [];
    return listDir(path.join(_openProjectPath, STRUCTURE.draftsDir), '.md');
  });

  // List anchors
  ipcMain.handle('project:listAnchors', () => {
    if (!_openProjectPath) return [];
    return listDir(path.join(_openProjectPath, STRUCTURE.anchorsDir), '.md');
  });

  // List review logs
  ipcMain.handle('project:listReviewLogs', () => {
    if (!_openProjectPath) return [];
    return listDir(path.join(_openProjectPath, STRUCTURE.reviewLogsDir));
  });

  // List all chapters in canon directory
  ipcMain.handle('project:listCanon', () => {
    if (!_openProjectPath) return [];
    const canonPath = path.join(_openProjectPath, STRUCTURE.canonDir);
    if (!fs.existsSync(canonPath)) return [];
    const files = fs.readdirSync(canonPath).filter(f => f.endsWith('.txt') || f.endsWith('.md'));
    return files.sort().map(f => ({
      name: f,
      path: path.join(canonPath, f),
      size: fs.statSync(path.join(canonPath, f)).size,
    }));
  });

  ipcMain.handle('project:listTree', () => {
    if (!_openProjectPath) return [];
    return buildProjectTree(_openProjectPath);
  });

  // Get project directory path (for Claude Code to operate on)
  ipcMain.handle('project:getPath', () => _openProjectPath);

  // Check if novel-writing-system exists, offer to copy it
  ipcMain.handle('project:hasSystem', () => {
    if (!_openProjectPath) return false;
    return fs.existsSync(path.join(_openProjectPath, STRUCTURE.systemDir));
  });

  // Editor state persistence — stores JSON in .renderer/ directory
  ipcMain.handle('project:saveState', (_event, key, data) => {
    if (!_openProjectPath) return { ok: false, error: 'No project open' };
    const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '');
    const stateDir = path.join(_openProjectPath, PROJECT_META_DIR);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(stateDir, `${safe}.json`), data, 'utf8');
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('project:loadState', (_event, key) => {
    if (!_openProjectPath) return { ok: false, data: null };
    const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '');
    const f = path.join(_openProjectPath, PROJECT_META_DIR, `${safe}.json`);
    if (!fs.existsSync(f)) return { ok: false, data: null };
    try {
      return { ok: true, data: fs.readFileSync(f, 'utf8') };
    } catch { return { ok: false, data: null }; }
  });

  // Last-opened project path — auto-reopen on startup
  ipcMain.handle('project:getLastPath', () => getLastProjectPath());

  ipcMain.handle('project:reopenLast', async () => {
    const lastPath = getLastProjectPath();
    if (!lastPath) return null;
    _openProjectPath = lastPath;
    ensureSystemDir(lastPath);
    ensureClaudeConfig(lastPath);
    const meta = getProjectMeta(lastPath);
    if (meta) { meta.lastOpened = Date.now(); saveProjectMeta(lastPath, meta); }
    return {
      path: lastPath,
      meta: meta,
      hasConfig: fs.existsSync(path.join(lastPath, STRUCTURE.config)),
      hasStoryPrimary: hasStoryPrimary(lastPath),
      hasNamingRef: fs.existsSync(path.join(lastPath, STRUCTURE.namingRef)),
      hasSystem: fs.existsSync(path.join(lastPath, STRUCTURE.systemDir)),
    };
  });

  // Copy novel-writing-system into project (from bundled source or explicit path)
  // ── Tool compile (esbuild transform for widget.tsx / logic.ts) ──────────

  ipcMain.handle('tool:compile', async (_event, { code, format }) => {
    try {
      const { transform } = require('esbuild-wasm');
      const result = await transform(code, {
        loader: format === 'tsx' ? 'tsx' : 'ts',
        format: 'cjs',
        target: 'es2022',
        jsx: 'automatic',
      });
      return { ok: true, code: result.code };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Tool import ──────────────────────────────────────────────────────────

  ipcMain.handle('tool:scanProject', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Select Project to Import Tools From',
      properties: ['openDirectory'],
      buttonLabel: 'Select Project',
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };

    const sourcePath = filePaths[0];
    if (_openProjectPath && path.resolve(sourcePath) === path.resolve(_openProjectPath)) {
      return { ok: false, error: 'Cannot import from the current project' };
    }

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

  ipcMain.handle('tool:importTools', async (_event, { sourcePath, imports }) => {
    if (!_openProjectPath) return { ok: false, error: 'No project open' };

    const targetToolsDir = path.join(_openProjectPath, 'tools');
    if (!fs.existsSync(targetToolsDir)) {
      fs.mkdirSync(targetToolsDir, { recursive: true });
    }

    const results = [];
    for (const imp of imports) {
      const dirName = imp.dirName;
      const targetDirName = imp.targetName || dirName;
      if (dirName.includes('..') || dirName.includes('/') || targetDirName.includes('..') || targetDirName.includes('/')) {
        results.push({ dirName: targetDirName, ok: false, error: 'Invalid directory name' });
        continue;
      }
      const srcDir = path.join(sourcePath, 'tools', dirName);
      const dstDir = path.join(targetToolsDir, targetDirName);

      try {
        copyRecursiveSync(srcDir, dstDir);

        if (imp.targetName && imp.targetName !== imp.dirName) {
          const manifestPath = path.join(dstDir, 'tool.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifest.name = imp.targetName;
          if (manifest.command) manifest.command = `/${imp.targetName}`;
          manifest.edited = false;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        }

        results.push({ dirName: targetDirName, ok: true });
      } catch (err) {
        results.push({ dirName: targetDirName, ok: false, error: err.message });
      }
    }

    return { ok: true, results };
  });

  ipcMain.handle('project:installSystem', (_event, sourcePath) => {
    if (!_openProjectPath) return { ok: false, error: 'No project open' };
    const dest = path.join(_openProjectPath, STRUCTURE.systemDir);
    if (fs.existsSync(dest)) return { ok: true, alreadyExists: true };

    const src = sourcePath || getBundledSystemPath();
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'Novel writing system source not found' };

    try {
      copyRecursiveSync(src, dest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerProjectFS };
