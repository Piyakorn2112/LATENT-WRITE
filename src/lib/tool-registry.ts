/**
 * Tool Registry — discovers, validates, and stores per-project custom tools.
 * Called on project open when customToolsEnabled is true.
 */

// ── Manifest types ────────────────────────────────────��─────────────────────

export type ToolSurface = "chat" | "widget" | "sidebar" | "overlay" | "highlight";

export interface ToolManifest {
  name: string;
  display: string;
  version: string;
  description: string;
  command: string;
  shortcut?: string | null;
  surfaces: ToolSurface[];
  inputs: {
    chapter: "current" | "all" | "range";
    analysis: boolean;
    worldData: boolean;
    files: string[];
  };
  outputs: {
    report?: string | null;
    widget: boolean;
    highlights: boolean;
  };
  requiresClaude: boolean;
  estimatedTokens: number;
  edited: boolean;
  autoRun?: boolean;
  sidebar?: {
    icon: string;
    position: "top" | "before-settings" | "after-settings";
    width: "default" | "wide";
  };
}

export interface RegisteredTool {
  manifest: ToolManifest;
  dirPath: string;
  hasLogic: boolean;
  hasWidget: boolean;
  hasPrompt: boolean;
  promptTemplate: string | null;
}

export interface ToolRegistry {
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredTool>;
  widgetTools: RegisteredTool[];
  sidebarTools: RegisteredTool[];
  overlayTools: RegisteredTool[];
}

// ── Reserved commands ───────────────────────────────────────────────────────

const RESERVED_COMMANDS = new Set([
  "/scan", "/draft", "/review", "/lore", "/assemble", "/update",
  "/init", "/context", "/clear", "/help", "/model", "/models", "/effort",
]);

// ── Validation ──────────────────────────────────────────────────────────────

export interface ManifestError {
  toolDir: string;
  message: string;
}

const VALID_SURFACES: Set<string> = new Set(["chat", "widget", "sidebar", "overlay", "highlight"]);

function validateManifest(manifest: unknown, dirName: string, existingNames: Set<string>): ManifestError | null {
  if (!manifest || typeof manifest !== "object") {
    return { toolDir: dirName, message: "Invalid JSON" };
  }
  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || !/^[a-z0-9-]+$/.test(m.name)) {
    return { toolDir: dirName, message: "name must be kebab-case" };
  }
  if (existingNames.has(m.name)) {
    return { toolDir: dirName, message: `Duplicate tool name: ${m.name}` };
  }
  if (typeof m.command !== "string" || !m.command.startsWith("/")) {
    return { toolDir: dirName, message: "command must start with /" };
  }
  if (RESERVED_COMMANDS.has(m.command)) {
    return { toolDir: dirName, message: `command ${m.command} is reserved` };
  }
  if (!Array.isArray(m.surfaces) || m.surfaces.length === 0) {
    return { toolDir: dirName, message: "surfaces must be a non-empty array" };
  }
  for (const s of m.surfaces) {
    if (!VALID_SURFACES.has(s)) {
      return { toolDir: dirName, message: `Unknown surface: ${s}` };
    }
  }
  if (m.inputs && typeof m.inputs === "object") {
    const inputs = m.inputs as Record<string, unknown>;
    if (Array.isArray(inputs.files)) {
      for (const f of inputs.files) {
        if (typeof f === "string" && f.includes("../")) {
          return { toolDir: dirName, message: "inputs.files cannot escape project directory" };
        }
      }
    }
  }
  return null;
}

// ── Empty registry ──────────────────────────────────────────────────────────

export const EMPTY_REGISTRY: ToolRegistry = {
  tools: new Map(),
  commands: new Map(),
  widgetTools: [],
  sidebarTools: [],
  overlayTools: [],
};

// ── Build registry from project files ───────────────────────────────────────

interface ProjectReader {
  listTree: () => Promise<Array<{ name: string; path: string; type: string; children?: unknown[] }>>;
  readFile: (relPath: string) => Promise<{ ok: boolean; content?: string }>;
}

export async function buildToolRegistry(reader: ProjectReader, opts?: { skipPrompts?: boolean }): Promise<{
  registry: ToolRegistry;
  errors: ManifestError[];
}> {
  const errors: ManifestError[] = [];
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredTool>();
  const widgetTools: RegisteredTool[] = [];
  const sidebarTools: RegisteredTool[] = [];
  const overlayTools: RegisteredTool[] = [];
  const existingNames = new Set<string>();

  const tree = await reader.listTree();
  const toolsNode = tree.find((n) => n.name === "tools" && n.type === "directory");
  if (!toolsNode || !Array.isArray(toolsNode.children)) {
    return { registry: EMPTY_REGISTRY, errors };
  }

  for (const child of toolsNode.children) {
    const node = child as { name: string; type: string; children?: Array<{ name: string }> };
    if (node.type !== "directory") continue;
    if (!node.children?.some((f) => f.name === "tool.json")) continue;

    const dirName = node.name;
    const manifestResult = await reader.readFile(`tools/${dirName}/tool.json`);
    if (!manifestResult.ok || !manifestResult.content) {
      errors.push({ toolDir: dirName, message: "Failed to read tool.json" });
      continue;
    }

    let manifest: ToolManifest;
    try {
      manifest = JSON.parse(manifestResult.content);
    } catch {
      errors.push({ toolDir: dirName, message: "Invalid JSON in tool.json" });
      continue;
    }

    const validationError = validateManifest(manifest, dirName, existingNames);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    const files = node.children?.map((f) => f.name) || [];
    const hasLogic = files.includes("logic.ts");
    const hasWidget = files.includes("widget.tsx");
    const hasPrompt = files.includes("prompt.md");

    let promptTemplate: string | null = null;
    if (hasPrompt && !opts?.skipPrompts) {
      const promptResult = await reader.readFile(`tools/${dirName}/prompt.md`);
      if (promptResult.ok && promptResult.content) {
        promptTemplate = promptResult.content;
      }
    }

    const registered: RegisteredTool = {
      manifest,
      dirPath: `tools/${dirName}`,
      hasLogic,
      hasWidget,
      hasPrompt,
      promptTemplate,
    };

    existingNames.add(manifest.name);
    tools.set(manifest.name, registered);
    commands.set(manifest.command, registered);

    if (manifest.surfaces.includes("widget")) {
      widgetTools.push(registered);
    }
    if (manifest.surfaces.includes("sidebar")) {
      sidebarTools.push(registered);
    }
    if (manifest.surfaces.includes("overlay")) {
      overlayTools.push(registered);
    }
  }

  return {
    registry: { tools, commands, widgetTools, sidebarTools, overlayTools },
    errors,
  };
}
