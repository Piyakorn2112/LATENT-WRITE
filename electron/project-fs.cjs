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
  ];
  for (const d of dirs) {
    const full = path.join(projectPath, d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  }
  ensureSystemDir(projectPath);
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
