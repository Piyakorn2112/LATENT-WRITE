/**
 * Tool Runner — executes custom tools via prompt template + local logic.
 */

import type { RegisteredTool } from "./tool-registry";

// ── Tool highlight type (used by logic modules and HighlightLayer) ─────────

export interface ToolHighlight {
  start: number;
  end: number;
  type: string;
  label: string;
  severity: "info" | "warning" | "error";
}

// ── Logic module types ─────────────────────────────────────────────────────

export interface ToolLogicContext {
  chapterContent: string;
  chapterTitle: string;
  chapterIndex: number;
  allChapters: Array<{ title: string; content: string; number: number }>;
  analysis: unknown;
  worldData: unknown;
  files: Record<string, string>;
  previousState: unknown;
}

export interface ToolLogicResult {
  summary: string;
  widgetData?: unknown;
  highlights?: ToolHighlight[];
  report?: string;
  state?: unknown;
  chainClaude?: boolean;
  claudeContext?: string;
}

// ── Tool context (data passed to tool execution) ────────────────────────────

export interface ToolExecutionContext {
  chapterContent: string;
  chapterTitle: string;
  chapterNumber: number;
  storyPrimary: string;
  namingReference: string;
  novelConfig: string;
  projectFiles: Record<string, string>;
  previousReport: string | null;
}

// ── Template resolution ─────────────────────────────────────────────────────

function extractSection(storyPrimary: string, sectionNum: number): string {
  const sectionRegex = new RegExp(
    `===\\s*(?:SECTION|Section)\\s*${sectionNum}[^=]*===([\\s\\S]*?)(?====\\s*(?:SECTION|Section)\\s*\\d|$)`,
    "i"
  );
  const match = storyPrimary.match(sectionRegex);
  return match ? match[1].trim() : "";
}

export function resolvePromptTemplate(template: string, ctx: ToolExecutionContext, toolContext?: string): string {
  let resolved = template;

  const replacements: Record<string, string> = {
    "{{chapter_content}}": ctx.chapterContent,
    "{{chapter_title}}": ctx.chapterTitle,
    "{{chapter_number}}": String(ctx.chapterNumber),
    "{{story_primary}}": ctx.storyPrimary,
    "{{naming_reference}}": ctx.namingReference,
    "{{novel_config}}": ctx.novelConfig,
    "{{tool_previous_report}}": ctx.previousReport || "",
  };

  for (const [variable, value] of Object.entries(replacements)) {
    resolved = resolved.replaceAll(variable, value);
  }

  // Section-specific variables: {{story_primary_section_N}}
  resolved = resolved.replace(/\{\{story_primary_section_(\d+)\}\}/g, (_, num) => {
    return extractSection(ctx.storyPrimary, parseInt(num, 10));
  });

  // File references: {{file:relative/path.md}}
  resolved = resolved.replace(/\{\{file:([^}]+)\}\}/g, (_, filePath) => {
    return ctx.projectFiles[filePath.trim()] ?? `[File not found: ${filePath}]`;
  });

  // Tool context (injected by logic module — empty in prompt-only mode)
  resolved = resolved.replaceAll("{{tool_context}}", toolContext ?? "");

  return resolved;
}

// ── Build execution context ─────────────────────────────────────────────────

interface ProjectReader {
  readFile: (relPath: string) => Promise<{ ok: boolean; content?: string }>;
  listTree?: () => Promise<Array<{ name: string; type: string }>>;
}

export async function buildToolContext(
  tool: RegisteredTool,
  chapterContent: string,
  chapterTitle: string,
  chapterNumber: number,
  reader: ProjectReader,
): Promise<ToolExecutionContext> {
  const readFileContent = async (path: string): Promise<string> => {
    const result = await reader.readFile(path);
    return result.ok && result.content ? result.content : "";
  };

  // Read core project files
  const [storyPrimary, namingReference, novelConfig] = await Promise.all([
    findAndReadStoryPrimary(reader),
    readFileContent("NAMING_REFERENCE.md"),
    readFileContent("NOVEL_CONFIGURATION.md"),
  ]);

  // Read tool-specific input files
  const projectFiles: Record<string, string> = {};
  if (tool.manifest.inputs.files.length > 0) {
    await Promise.all(
      tool.manifest.inputs.files.map(async (pattern) => {
        // Simple glob: just read the literal path (no wildcard expansion yet)
        const content = await readFileContent(pattern);
        if (content) projectFiles[pattern] = content;
      }),
    );
  }

  // Read previous report if output path is set
  let previousReport: string | null = null;
  if (tool.manifest.outputs.report) {
    const reportDir = tool.manifest.outputs.report;
    const reportPath = `${reportDir}latest.md`;
    const result = await reader.readFile(reportPath);
    if (result.ok && result.content) {
      previousReport = result.content;
    }
  }

  return {
    chapterContent,
    chapterTitle,
    chapterNumber,
    storyPrimary,
    namingReference,
    novelConfig,
    projectFiles,
    previousReport,
  };
}

async function findAndReadStoryPrimary(reader: ProjectReader): Promise<string> {
  const tree = await reader.listTree?.() ?? [];
  const spFile = tree.find(
    (n) => n.type === "file" && n.name.endsWith("_STORY_PRIMARY.txt"),
  );
  if (spFile) {
    const result = await reader.readFile(spFile.name);
    if (result.ok && result.content) return result.content;
  }
  // Fallback: legacy name
  const fallback = await reader.readFile("STORY_PRIMARY.txt");
  return fallback.ok && fallback.content ? fallback.content : "";
}

// ── Build Claude prompt for a tool ──────────────────────────────────────────

export function buildToolPrompt(tool: RegisteredTool, ctx: ToolExecutionContext, toolContext?: string): string | null {
  if (!tool.promptTemplate) return null;
  return resolvePromptTemplate(tool.promptTemplate, ctx, toolContext);
}

// ── Tool result types ───────────────────────────────────────────────────────

export interface ToolRunResult {
  ok: boolean;
  prompt: string | null;
  error?: string;
  estimatedTokens: number;
}

export function prepareToolRun(tool: RegisteredTool, ctx: ToolExecutionContext, toolContext?: string): ToolRunResult {
  if (!tool.promptTemplate) {
    return {
      ok: false,
      prompt: null,
      error: `Tool "${tool.manifest.display}" has no prompt.md template`,
      estimatedTokens: 0,
    };
  }

  const prompt = buildToolPrompt(tool, ctx, toolContext);
  if (!prompt) {
    return { ok: false, prompt: null, error: "Failed to resolve prompt template", estimatedTokens: 0 };
  }

  return {
    ok: true,
    prompt,
    estimatedTokens: tool.manifest.estimatedTokens || Math.ceil(prompt.length / 4),
  };
}

// ── Logic module execution ─────────────────────────────────────────────────

interface ToolCompiler {
  compile: (opts: { code: string; format: "ts" | "tsx" }) => Promise<{ ok: boolean; code?: string; error?: string }>;
}

interface LogicReader {
  readFile: (relPath: string) => Promise<{ ok: boolean; content?: string }>;
}

function evaluateLogicModule(compiledCode: string): ((ctx: ToolLogicContext) => ToolLogicResult) | null {
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const emptyRequire = (id: string): never => { throw new Error(`Logic modules cannot import "${id}"`); };
  try {
    const fn = new Function(
      "require", "exports", "module",
      "window", "document", "fetch", "XMLHttpRequest", "process", "globalThis", "self",
      compiledCode,
    );
    fn(emptyRequire, exports, module,
       undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  } catch (e) {
    console.error("[tool-logic] eval error:", e);
    return null;
  }
  const run = (module.exports as { run?: unknown }).run
    ?? (module.exports as { default?: { run?: unknown } }).default?.run;
  if (typeof run === "function") return run as (ctx: ToolLogicContext) => ToolLogicResult;
  return null;
}

const LOGIC_TIMEOUT_MS = 5000;

export async function executeToolLogic(
  tool: RegisteredTool,
  ctx: ToolLogicContext,
  compiler: ToolCompiler,
  reader: LogicReader,
): Promise<{ ok: boolean; result?: ToolLogicResult; error?: string }> {
  const source = await reader.readFile(`${tool.dirPath}/logic.ts`);
  if (!source.ok || !source.content) {
    return { ok: false, error: "Failed to read logic.ts" };
  }

  const compiled = await compiler.compile({ code: source.content, format: "ts" });
  if (!compiled.ok || !compiled.code) {
    return { ok: false, error: compiled.error ?? "Logic compilation failed" };
  }

  const runFn = evaluateLogicModule(compiled.code);
  if (!runFn) {
    return { ok: false, error: "Logic module has no run() export" };
  }

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => runFn(ctx)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Logic module timed out (5s)")), LOGIC_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Logic execution failed" };
  }
}
