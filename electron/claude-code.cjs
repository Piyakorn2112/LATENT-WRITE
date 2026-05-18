// Claude Code subprocess manager — spawns `claude` CLI from Electron main process.
// Streams output back to the renderer via IPC events for live progress display.
const { ipcMain, BrowserWindow } = require('electron');
const { spawn, execSync } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');

let _activeProcess = null;
let _claudePath = null;
let _activeSession = null;

function setActiveSession({ sessionId, operation = null, cwd = null }) {
  _activeSession = {
    sessionId: sessionId || null,
    operation,
    cwd,
    startedAt: Date.now(),
  };
}

function clearActiveSession(sessionId) {
  if (!_activeSession) return;
  if (!sessionId || _activeSession.sessionId === sessionId) {
    _activeSession = null;
  }
}

function findClaude() {
  if (_claudePath) return _claudePath;
  try {
    _claudePath = execSync('which claude', { encoding: 'utf8' }).trim();
    return _claudePath;
  } catch {
    const common = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(process.env.HOME || '', '.claude', 'bin', 'claude'),
      path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    ];
    const fs = require('fs');
    for (const p of common) {
      if (fs.existsSync(p)) { _claudePath = p; return p; }
    }
    return null;
  }
}

function sendToRenderer(channel, data) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (!w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function appendFragment(fragments, lane, text) {
  const normalized = String(text || '');
  if (!normalized) return;
  const last = fragments[fragments.length - 1];
  if (last && last.lane === lane) {
    last.text += normalized;
    return;
  }
  fragments.push({ lane, text: normalized });
}

function formatToolNotice(value) {
  if (!value || value.type !== 'tool_use' || !value.name) return null;
  const input = value.input || {};
  const name = value.name;
  const mutates = name === 'Write' || name === 'Edit';
  if (name === 'Write' || name === 'Edit' || name === 'Read') {
    const fp = input.file_path || input.path || '';
    return { notice: `⟩ ${name}: ${fp ? path.basename(fp) : '(unknown)'}`, filePath: fp, mutates };
  }
  if (name === 'Bash') {
    const cmd = String(input.command || '').slice(0, 80);
    return { notice: `⟩ Bash: ${cmd}`, filePath: null, mutates: false };
  }
  return { notice: `⟩ ${name}`, filePath: null, mutates: false };
}

function collectMessageContent(value, fragments, preferredLane = 'assistant') {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMessageContent(item, fragments, preferredLane));
    return;
  }
  if (typeof value === 'string') {
    appendFragment(fragments, preferredLane, value);
    return;
  }
  if (typeof value !== 'object') return;

  if (typeof value.thinking === 'string') {
    appendFragment(fragments, 'thinking', value.thinking);
  }

  if (value.type === 'tool_use' && typeof value.name === 'string') {
    const tool = formatToolNotice(value);
    if (tool) {
      appendFragment(fragments, 'tool', tool.notice);
      if (tool.mutates) {
        sendToRenderer('claude:file-changed', { filePath: tool.filePath });
      }
    }
    return;
  }

  if (value.type === 'thinking' && typeof value.text === 'string') {
    appendFragment(fragments, 'thinking', value.text);
  } else if (value.type === 'text' && typeof value.text === 'string') {
    appendFragment(fragments, preferredLane, value.text);
  } else if (!('type' in value) && typeof value.text === 'string') {
    appendFragment(fragments, preferredLane, value.text);
  }

  if (value.message) collectMessageContent(value.message, fragments, preferredLane);
  if (value.delta) collectMessageContent(value.delta, fragments, preferredLane);
  if (value.content) collectMessageContent(value.content, fragments, preferredLane);
  if (value.content_block) collectMessageContent(value.content_block, fragments, preferredLane);
  if (value.content_block_delta) collectMessageContent(value.content_block_delta, fragments, preferredLane);
}

function extractStreamFragments(event) {
  const fragments = [];
  if (!event || typeof event !== 'object') return fragments;

  if (event.type === 'assistant') {
    collectMessageContent(event.message, fragments, 'assistant');
    collectMessageContent(event.delta, fragments, 'assistant');
  } else if (event.type === 'result') {
    if (event.is_error && typeof event.result === 'string') {
      appendFragment(fragments, 'system', event.result);
    }
  } else if (event.type === 'rate_limit_event') {
    // Claude Code handles rate limits internally (waits and retries).
    // No need to surface to user — they'll see a brief pause in output.
  } else {
    const lane = event.type === 'system' ? 'thinking' : 'assistant';
    collectMessageContent(event.message, fragments, lane);
    collectMessageContent(event.delta, fragments, lane);
    if (typeof event.text === 'string') appendFragment(fragments, lane, event.text);
    if (typeof event.error === 'string') appendFragment(fragments, 'system', event.error);
  }

  return fragments;
}

function emitStreamFragments(sessionId, fragments) {
  for (const fragment of fragments) {
    sendToRenderer('claude:stream-data', {
      sessionId,
      lane: fragment.lane,
      text: fragment.text,
    });
  }
}

const _usedSessionIds = new Set();

function buildClaudeArgs({ skill, sessionId, resume, model, effort, name }) {
  const args = [
    '--print', '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
  ];
  if (skill) args.push('--skill', skill);
  if (sessionId) {
    if (resume || _usedSessionIds.has(sessionId)) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }
  }
  if (name) args.push('--name', name);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

function markSessionUsed(sessionId) {
  if (sessionId) _usedSessionIds.add(sessionId);
}

function isPathInsideProject(filePath, projectDir) {
  if (!filePath || !projectDir) return true;
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectDir, filePath);
  const normalizedProject = path.resolve(projectDir);
  return resolved === normalizedProject || resolved.startsWith(normalizedProject + path.sep);
}

function extractMutatingToolPaths(event) {
  const paths = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.type === 'tool_use' && v.input) {
      const name = typeof v.name === 'string' ? v.name : '';
      const fp = v.input.file_path || v.input.path;
      if (fp && (name === 'Write' || name === 'Edit')) {
        paths.push({ filePath: fp, toolName: name });
      }
    }
    if (v.message) walk(v.message);
    if (v.content) walk(v.content);
    if (v.content_block) walk(v.content_block);
  };
  walk(event);
  return paths;
}

function attachStructuredOutput(proc, initialSessionId, onAssistantText, safeCwd) {
  let currentSessionId = initialSessionId;
  let stdoutBuffer = '';

  const flushLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed);
      if (event.session_id || event.sessionId) {
        currentSessionId = event.session_id || event.sessionId;
      }

      if (safeCwd) {
        const toolPaths = extractMutatingToolPaths(event);
        for (const toolPath of toolPaths) {
          if (!isPathInsideProject(toolPath.filePath, safeCwd)) {
            sendToRenderer('claude:stream-data', {
              sessionId: currentSessionId,
              lane: 'system',
              text: `Late safety stop: ${toolPath.toolName} targeted ${path.basename(toolPath.filePath)} outside the project directory. Session cancelled.`,
            });
            proc.kill('SIGTERM');
            return;
          }
        }
      }

      const fragments = extractStreamFragments(event);
      if (typeof onAssistantText === 'function') {
        for (const fragment of fragments) {
          if (fragment.lane === 'assistant') onAssistantText(fragment.text);
        }
      }
      emitStreamFragments(currentSessionId, fragments);
    } catch {
      if (typeof onAssistantText === 'function') onAssistantText(trimmed);
      sendToRenderer('claude:stream-data', {
        sessionId: currentSessionId,
        lane: 'assistant',
        text: trimmed,
      });
    }
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      flushLine(line);
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text) return;
    sendToRenderer('claude:stream-data', {
      sessionId: currentSessionId,
      lane: 'thinking',
      text,
    });
  });

  return () => {
    if (stdoutBuffer.trim()) flushLine(stdoutBuffer.trim());
    return currentSessionId;
  };
}

function registerClaudeCode() {
  // Check if Claude Code is installed and accessible
  ipcMain.handle('claude:status', () => {
    const claudePath = findClaude();
    if (!claudePath) {
      return {
        installed: false,
        path: null,
        active: false,
        activeSessionId: null,
        activeOperation: null,
        activeCwd: null,
      };
    }
    try {
      const version = execSync(`"${claudePath}" --version 2>/dev/null || echo unknown`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      return {
        installed: true,
        path: claudePath,
        version,
        active: !!_activeProcess,
        activeSessionId: _activeSession?.sessionId ?? null,
        activeOperation: _activeSession?.operation ?? null,
        activeCwd: _activeSession?.cwd ?? null,
      };
    } catch {
      return {
        installed: true,
        path: claudePath,
        version: 'unknown',
        active: !!_activeProcess,
        activeSessionId: _activeSession?.sessionId ?? null,
        activeOperation: _activeSession?.operation ?? null,
        activeCwd: _activeSession?.cwd ?? null,
      };
    }
  });

  // Run a Claude Code command with --print (non-interactive, single response)
  // Returns the full response text.
  ipcMain.handle('claude:run', async (_event, { prompt, cwd, skill }) => {
    const claudePath = findClaude();
    if (!claudePath) return { ok: false, error: 'Claude Code not found' };

    return new Promise((resolve) => {
      const args = ['--print'];
      if (skill) args.push('--skill', skill);

      const proc = spawn(claudePath, args, {
        cwd: cwd || process.env.HOME,
        env: { ...process.env, TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        resolve({
          ok: code === 0,
          output: stdout,
          error: stderr,
          exitCode: code,
        });
      });

      proc.on('error', (err) => {
        resolve({ ok: false, output: '', error: err.message, exitCode: -1 });
      });

      // Write prompt to stdin and close
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  });

  // Run Claude Code with streaming — sends progress events to renderer.
  // If resume fails with "already in use", auto-retries with a fresh session.
  function launchStream({ claudePath, prompt, cwd, skill, sessionId, model, effort, name, resume, _retried }) {
    const args = buildClaudeArgs({ skill, sessionId, model, effort, name, resume });
    const proc = spawn(claudePath, args, {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _activeProcess = proc;
    setActiveSession({ sessionId, cwd: cwd || null });
    sendToRenderer('claude:stream-start', { sessionId });

    const startTime = Date.now();
    let stderrBuf = '';
    const finalizeOutput = attachStructuredOutput(proc, sessionId, null, cwd || null);

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('close', (code) => {
      _activeProcess = null;
      const finalSessionId = finalizeOutput();
      markSessionUsed(finalSessionId);
      markSessionUsed(sessionId);

      const elapsed = Date.now() - startTime;
      if (!_retried && code !== 0 && elapsed < 5000 && stderrBuf.includes('already in use')) {
        const freshId = randomUUID();
        launchStream({ claudePath, prompt, cwd, skill, sessionId: freshId, model, effort, name, resume: false, _retried: true });
        return;
      }

      clearActiveSession(finalSessionId || sessionId);
      sendToRenderer('claude:stream-end', { sessionId: finalSessionId, exitCode: code });
    });
    proc.on('error', (err) => {
      _activeProcess = null;
      markSessionUsed(sessionId);
      clearActiveSession(sessionId);
      sendToRenderer('claude:stream-error', { sessionId, error: err.message });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
    return proc;
  }

  ipcMain.handle('claude:stream', async (_event, { prompt, cwd, skill, sessionId, model, effort, name }) => {
    const claudePath = findClaude();
    if (!claudePath) return { ok: false, error: 'Claude Code not found' };
    if (_activeProcess) return { ok: false, error: 'Another Claude operation is already running' };

    const id = sessionId || randomUUID();
    const shouldResume = !!sessionId;
    launchStream({ claudePath, prompt, cwd, skill, sessionId: id, model, effort, name, resume: shouldResume });
    return { ok: true, sessionId: id };
  });

  // Cancel the active streaming operation
  ipcMain.handle('claude:cancel', () => {
    if (_activeProcess) {
      _activeProcess.kill('SIGTERM');
      _activeProcess = null;
      clearActiveSession();
      return { ok: true };
    }
    return { ok: false, error: 'No active process' };
  });

  // Run a specific Renderer pipeline operation
  // Wraps the prompt with /renderer context and project-specific paths
  ipcMain.handle('claude:pipeline', async (_event, { operation, chapterNum, projectPath, extraContext, sessionId, model, effort, name }) => {
    const claudePath = findClaude();
    if (!claudePath) return { ok: false, error: 'Claude Code not found' };

    const chPad = chapterNum ? String(chapterNum).padStart(3, '0') : '001';

    const prompts = {
      'init': [
        `You are initializing a novel project. The novel-writing-system framework is already installed in this project directory at novel-writing-system/.`,
        ``,
        `Read novel-writing-system/SYSTEM_INDEX.md first to understand the system, then read novel-writing-system/FROM_SCRATCH_PIPELINE.md and follow its instructions.`,
        ``,
        `This project directory already has the standard folder structure:`,
        `  anchors/    — anchor files (frozen world-state snapshots)`,
        `  drafts/     — chapter draft files`,
        `  canon/      — assembled canon chapters`,
        `  scene-bank/ — scene bank files`,
        `  review-logs/ — prose review reports`,
        `  temp/       — context packets and working files`,
        ``,
        `Check if any project files already exist (NOVEL_CONFIGURATION.md, NAMING_REFERENCE.md, *_STORY_PRIMARY.txt). If they do but are empty or incomplete, treat this as a re-initialization — rebuild them from scratch, don't try to repair partial files.`,
        ``,
        `If no project files exist yet, this is a fresh start. Ask me about my novel — premise, characters, world, genre, tone — and use my answers to create:`,
        `1. NAMING_REFERENCE.md`,
        `2. [ProjectName]_STORY_PRIMARY.txt (follow novel-writing-system/STORY_PRIMARY_FORMAT.md)`,
        `3. NOVEL_CONFIGURATION.md (use novel-writing-system/templates/novel-config-template.md)`,
        ``,
        `All files go in this project root directory, not inside novel-writing-system/.`,
      ].join('\n'),

      'context-packet': [
        `Build a context packet for chapter ${chapterNum}.`,
        `Read the story primary (*_STORY_PRIMARY.txt), NOVEL_CONFIGURATION.md, NAMING_REFERENCE.md, and the latest anchor file in anchors/.`,
        `Follow novel-writing-system/CANONICAL_PIPELINE.md Phase 0.`,
        `Save the packet to temp/context_packet_ch${chPad}.md`,
      ].join('\n'),

      'draft': [
        `Draft chapter ${chapterNum} following the canonical pipeline.`,
        `Read novel-writing-system/CANONICAL_PIPELINE.md for the full workflow.`,
        `The context packet should be at temp/context_packet_ch${chPad}.md — if it doesn't exist, build it first (Phase 0).`,
        `Follow Phases 2-3 (scene bank → skeleton draft).`,
        `Save the draft to drafts/ch${chPad}.md`,
      ].join('\n'),

      'review': [
        `Run a prose review on drafts/ch${chPad}.md.`,
        `Read novel-writing-system/SMART_PASS_PROTOCOL.md for the decision flow.`,
        `Read novel-writing-system/PROSE_REVIEW_PROTOCOL.md for pass definitions.`,
        `Run the appropriate passes based on eval scores.`,
        `Save the review log to review-logs/review_ch${chPad}.md`,
      ].join('\n'),

      'assemble': [
        `Assemble chapter ${chapterNum} from drafts/ch${chPad}.md into the canon file in canon/.`,
        `Follow novel-writing-system/CANONICAL_PIPELINE.md Phase 6.`,
        `Verify transitions with the previous chapter if it exists.`,
      ].join('\n'),

      'artifact-update': [
        `Run Phase 7 artifact updates for chapter ${chapterNum}.`,
        `Follow novel-writing-system/CANONICAL_PIPELINE.md Phase 7.`,
        `Update: NAMING_REFERENCE.md, the anchor file in anchors/, the story primary (*_STORY_PRIMARY.txt), and scene bank entries.`,
      ].join('\n'),

      'lore-check': [
        `Run a Lore Consistency Check (Phase 4.5) on drafts/ch${chPad}.md.`,
        `Follow novel-writing-system/CANONICAL_PIPELINE.md Phase 4.5.`,
        `Check timeline arithmetic, naming cross-check against NAMING_REFERENCE.md, and knowledge boundary against the story primary.`,
      ].join('\n'),
    };

    let prompt = prompts[operation];
    if (!prompt) return { ok: false, error: `Unknown operation: ${operation}` };
    if (extraContext) prompt = `${extraContext}\n\n${prompt}`;

    if (_activeProcess) {
      return { ok: false, error: 'Another operation is already running' };
    }

    const resolvedSessionId = sessionId || randomUUID();
    const args = buildClaudeArgs({ sessionId: resolvedSessionId, model, effort, name });
    const proc = spawn(claudePath, args, {
      cwd: projectPath,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    _activeProcess = proc;
    setActiveSession({ sessionId: resolvedSessionId, operation, cwd: projectPath });
    sendToRenderer('claude:stream-start', { sessionId: resolvedSessionId, operation });

    let fullOutput = '';
    const finalizeOutput = attachStructuredOutput(proc, resolvedSessionId, (text) => {
      fullOutput += text;
    }, projectPath);

    return new Promise((resolve) => {
      proc.on('close', (code) => {
        _activeProcess = null;
        const finalSessionId = finalizeOutput();
        markSessionUsed(finalSessionId);
        markSessionUsed(resolvedSessionId);
        clearActiveSession(finalSessionId || resolvedSessionId);
        sendToRenderer('claude:stream-end', { sessionId: finalSessionId, exitCode: code });
        resolve({ ok: code === 0, output: fullOutput, exitCode: code, sessionId: finalSessionId });
      });

      proc.on('error', (err) => {
        _activeProcess = null;
        markSessionUsed(resolvedSessionId);
        clearActiveSession(resolvedSessionId);
        sendToRenderer('claude:stream-error', { sessionId: resolvedSessionId, error: err.message });
        resolve({ ok: false, error: err.message, sessionId: resolvedSessionId });
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  });
}

module.exports = { registerClaudeCode };
