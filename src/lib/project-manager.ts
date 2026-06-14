/**
 * Project state manager — bridges Electron filesystem IPC to React state.
 * Provides typed accessors for project files, Claude Code integration status,
 * and pipeline operations.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  name: string;
  created: number;
  lastOpened: number;
}

export interface ProjectStatus {
  path: string;
  meta: ProjectMeta | null;
  hasConfig: boolean;
  hasStoryPrimary: boolean;
  hasNamingRef: boolean;
  hasSystem: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  mtime?: number;
}

export interface ProjectTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  supported: boolean;
  children?: ProjectTreeNode[];
}

export interface ClaudeStatus {
  installed: boolean;
  path: string | null;
  version?: string;
  active?: boolean;
  activeSessionId?: string | null;
  activeOperation?: string | null;
  activeCwd?: string | null;
}

export type PipelineOp =
  | "init"
  | "context-packet"
  | "draft"
  | "review"
  | "assemble"
  | "artifact-update"
  | "lore-check";

export interface PipelineResult {
  ok: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  sessionId?: string;
}

export interface StreamEvent {
  sessionId: string;
  text?: string;
  error?: string;
  exitCode?: number;
  operation?: string;
  lane?: "assistant" | "thinking" | "system" | "tool";
}

// ── Tool import types ───────────────────────────────────────────────────────

export interface ToolScanEntry {
  dirName: string;
  manifest: {
    name: string;
    display: string;
    version: string;
    description: string;
    command: string;
    surfaces: string[];
    requiresClaude: boolean;
    edited: boolean;
  };
  files: string[];
  hasLogic: boolean;
  hasWidget: boolean;
  hasPrompt: boolean;
}

export interface ToolScanResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  sourcePath?: string;
  tools?: ToolScanEntry[];
}

export interface ToolImportResult {
  ok: boolean;
  error?: string;
  results?: Array<{ dirName: string; ok: boolean; error?: string }>;
}

// ── Electron API type augmentation ───────────────────────────────────────────

interface ElectronAPI {
  isElectron: boolean;
  // Original APIs (PDF, menu, review, LM)
  exportPdf: (html: string, filename: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  onMenuCommand: (cb: (cmd: string) => void) => () => void;
  setDraftGuardState: (state: { hasUnsavedLocalDraft: boolean }) => void;
  rendererReview: (params: unknown) => Promise<unknown>;
  narrativeLMEmbed: (text: string) => Promise<number[] | null>;
  narrativeLMStatus: () => Promise<string>;
  // Project filesystem
  projectOpen: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; meta?: ProjectMeta }>;
  projectCreate: (opts: { name: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; meta?: ProjectMeta }>;
  projectCurrent: () => Promise<ProjectStatus | null>;
  projectReadFile: (relPath: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
  projectWriteFile: (relPath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  projectListDrafts: () => Promise<FileEntry[]>;
  projectListAnchors: () => Promise<FileEntry[]>;
  projectListCanon: () => Promise<FileEntry[]>;
  projectListTree: () => Promise<ProjectTreeNode[]>;
  projectGetPath: () => Promise<string | null>;
  projectHasSystem: () => Promise<boolean>;
  projectInstallSystem: (src: string) => Promise<{ ok: boolean; error?: string }>;
  projectSaveState: (key: string, data: string) => Promise<{ ok: boolean; error?: string }>;
  projectLoadState: (key: string) => Promise<{ ok: boolean; data: string | null }>;
  projectReopenLast: () => Promise<ProjectStatus | null>;
  // Claude Code
  claudeStatus: () => Promise<ClaudeStatus>;
  claudeRun: (opts: { prompt: string; cwd?: string; skill?: string }) => Promise<PipelineResult>;
  claudeStream: (opts: {
    prompt: string;
    cwd?: string;
    skill?: string;
    sessionId?: string;
    model?: string;
    effort?: string;
    name?: string;
  }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  claudeCancel: () => Promise<{ ok: boolean }>;
  claudePipeline: (opts: {
    operation: PipelineOp;
    chapterNum?: number;
    projectPath: string;
    extraContext?: string;
    sessionId?: string;
    model?: string;
    effort?: string;
    name?: string;
  }) => Promise<PipelineResult>;
  onClaudeStreamStart: (cb: (data: StreamEvent) => void) => () => void;
  onClaudeStreamData: (cb: (data: StreamEvent) => void) => () => void;
  onClaudeStreamEnd: (cb: (data: StreamEvent) => void) => () => void;
  onClaudeStreamError: (cb: (data: StreamEvent) => void) => () => void;
  onClaudeStreamStderr: (cb: (data: StreamEvent) => void) => () => void;
  onClaudeFileChanged: (cb: (data: { filePath: string }) => void) => () => void;
  // Renderer workspace window
  workspaceOpenWindow: () => Promise<{ ok: boolean }>;
  workspaceFocusWindow: () => Promise<{ ok: boolean }>;
  workspaceIsWindowOpen: () => Promise<boolean>;
  onWorkspaceWindowState: (cb: (data: { open: boolean }) => void) => () => void;
  // Tool system
  toolCompile: (opts: { code: string; format: "ts" | "tsx" }) => Promise<{ ok: boolean; code?: string; error?: string }>;
  toolScanProject: () => Promise<ToolScanResult>;
  toolImportTools: (opts: { sourcePath: string; imports: Array<{ dirName: string; targetName?: string }> }) => Promise<ToolImportResult>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// ── API helpers ──────────────────────────────────────────────────────────────

function api(): ElectronAPI | null {
  return typeof window !== "undefined" && window.electronAPI?.isElectron
    ? (window.electronAPI as ElectronAPI)
    : null;
}

export function isDesktopApp(): boolean {
  return !!api();
}

export async function openProject(): Promise<ProjectStatus | null> {
  const a = api();
  if (!a) return null;
  const result = await a.projectOpen();
  if (!result.ok) return null;
  return a.projectCurrent();
}

export async function createProject(name: string): Promise<ProjectStatus | null> {
  const a = api();
  if (!a) return null;
  const result = await a.projectCreate({ name });
  if (!result.ok) return null;
  return a.projectCurrent();
}

export async function getCurrentProject(): Promise<ProjectStatus | null> {
  const a = api();
  if (!a) return null;
  return a.projectCurrent();
}

export async function readProjectFile(relPath: string): Promise<string | null> {
  const a = api();
  if (!a) return null;
  const result = await a.projectReadFile(relPath);
  return result.ok ? result.content! : null;
}

export async function writeProjectFile(relPath: string, content: string): Promise<boolean> {
  const a = api();
  if (!a) return false;
  const result = await a.projectWriteFile(relPath, content);
  return result.ok;
}

export async function listDrafts(): Promise<FileEntry[]> {
  const a = api();
  if (!a) return [];
  return a.projectListDrafts();
}

export async function listAnchors(): Promise<FileEntry[]> {
  const a = api();
  if (!a) return [];
  return a.projectListAnchors();
}

export async function listCanon(): Promise<FileEntry[]> {
  const a = api();
  if (!a) return [];
  return a.projectListCanon();
}

export async function listProjectTree(): Promise<ProjectTreeNode[]> {
  const a = api();
  if (!a) return [];
  return a.projectListTree();
}

export async function getClaudeStatus(): Promise<ClaudeStatus> {
  const a = api();
  if (!a) return { installed: false, path: null };
  return a.claudeStatus();
}

export async function getProjectPath(): Promise<string | null> {
  const a = api();
  if (!a) return null;
  return a.projectGetPath();
}

export async function runPipeline(
  operation: PipelineOp,
  chapterNum?: number,
  extraContext?: string,
  options: {
    sessionId?: string;
    model?: string;
    effort?: string;
    name?: string;
  } = {},
): Promise<PipelineResult> {
  const a = api();
  if (!a) return { ok: false, error: "Not running in desktop app" };
  const projectPath = await a.projectGetPath();
  if (!projectPath) return { ok: false, error: "No project open" };
  return a.claudePipeline({ operation, chapterNum, projectPath, extraContext, ...options });
}

export async function cancelPipeline(): Promise<boolean> {
  const a = api();
  if (!a) return false;
  const result = await a.claudeCancel();
  return result.ok;
}

// ── Desktop state persistence ───────────────────────────────────────────────

export async function saveProjectState(key: string, data: unknown): Promise<boolean> {
  const a = api();
  if (!a) return false;
  const result = await a.projectSaveState(key, JSON.stringify(data));
  return result.ok;
}

export async function loadProjectState<T>(key: string): Promise<T | null> {
  const a = api();
  if (!a) return null;
  const result = await a.projectLoadState(key);
  if (!result.ok || !result.data) return null;
  try { return JSON.parse(result.data) as T; }
  catch { return null; }
}

export async function reopenLastProject(): Promise<ProjectStatus | null> {
  const a = api();
  if (!a) return null;
  return a.projectReopenLast();
}

// ── Tool import helpers ─────────────────────────────────────────────────────

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

// ── Renderer workspace window ────────────────────────────────────────────────

export async function openWorkspaceWindow(): Promise<boolean> {
  const a = api();
  if (!a) return false;
  const result = await a.workspaceOpenWindow();
  return result.ok;
}

export async function focusWorkspaceWindow(): Promise<boolean> {
  const a = api();
  if (!a) return false;
  const result = await a.workspaceFocusWindow();
  return result.ok;
}

export async function isWorkspaceWindowOpen(): Promise<boolean> {
  const a = api();
  if (!a) return false;
  return a.workspaceIsWindowOpen();
}

export function subscribeWorkspaceWindowState(cb: (open: boolean) => void): () => void {
  const a = api();
  if (!a) return () => {};
  return a.onWorkspaceWindowState((data) => cb(!!data?.open));
}

export function subscribeStream(callbacks: {
  onStart?: (data: StreamEvent) => void;
  onData?: (data: StreamEvent) => void;
  onEnd?: (data: StreamEvent) => void;
  onError?: (data: StreamEvent) => void;
  onStderr?: (data: StreamEvent) => void;
  onFileChanged?: (data: { filePath: string }) => void;
}): () => void {
  const a = api();
  if (!a) return () => {};

  const unsubs: Array<() => void> = [];
  if (callbacks.onStart) unsubs.push(a.onClaudeStreamStart(callbacks.onStart));
  if (callbacks.onData) unsubs.push(a.onClaudeStreamData(callbacks.onData));
  if (callbacks.onEnd) unsubs.push(a.onClaudeStreamEnd(callbacks.onEnd));
  if (callbacks.onError) unsubs.push(a.onClaudeStreamError(callbacks.onError));
  if (callbacks.onStderr) unsubs.push(a.onClaudeStreamStderr(callbacks.onStderr));
  if (callbacks.onFileChanged) unsubs.push(a.onClaudeFileChanged(callbacks.onFileChanged));

  return () => unsubs.forEach((u) => u());
}
