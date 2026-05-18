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

function ensureClaudeConfig(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Read', 'Write', 'Edit', 'Bash(*)'],
        deny: [],
      },
    }, null, 2), 'utf8');
  }

  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const meta = getProjectMeta(projectPath);
    const projectName = meta?.name || path.basename(projectPath);
    fs.writeFileSync(claudeMdPath, [
      `# ${projectName} — Latent Write Project`,
      '',
      'This is a novel writing project managed by Latent Write. The novel-writing-system framework is installed at `novel-writing-system/`.',
      '',
      '## Project Structure',
      '',
      '| Path | Purpose |',
      '|------|---------|',
      '| `novel-writing-system/` | Writing framework (read-only reference). Start with `SYSTEM_INDEX.md`. |',
      '| `NOVEL_CONFIGURATION.md` | Per-novel settings: chapter length, voice rules, eval weights |',
      '| `NAMING_REFERENCE.md` | All proper nouns, characters, locations, factions |',
      '| `*_STORY_PRIMARY.txt` | Master narrative reference (story primary) |',
      '| `anchors/` | Frozen world-state snapshots |',
      '| `drafts/` | Chapter draft files |',
      '| `canon/` | Assembled final chapters |',
      '| `scene-bank/` | Scene planning files |',
      '| `review-logs/` | Prose review reports |',
      '| `temp/` | Context packets and working files |',
      '| `novel.txt` | App-managed novel data (do not edit directly) |',
      '| `.renderer/` | App state (do not edit) |',
      '',
      '## Initialization',
      '',
      'If `NOVEL_CONFIGURATION.md`, `NAMING_REFERENCE.md`, and `*_STORY_PRIMARY.txt` do not exist (or are empty/incomplete), this project needs initialization.',
      'Follow `novel-writing-system/FROM_SCRATCH_PIPELINE.md`. Ask the user about their novel and create the files.',
      '',
      '## Rules',
      '',
      '- All project files go in the project root, NOT inside `novel-writing-system/`.',
      `- Story primary filename: \`${projectName.replace(/\s+/g, '_')}_STORY_PRIMARY.txt\``,
      '- Read `novel-writing-system/SYSTEM_INDEX.md` before starting any pipeline operation.',
      '- When creating files, always write complete content. Never create empty placeholder files.',
    ].join('\n'), 'utf8');
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
