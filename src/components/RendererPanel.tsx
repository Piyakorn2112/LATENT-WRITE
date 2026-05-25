import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReviewFlag, ReviewResult, Novel, Chapter, WorldData } from "../types";
import type { Preferences } from "../lib/preferences";
import type { ChapterAnalysis } from "../lib/chapter-analysis";
import type { ChapterParaResult } from "../lib/speech-detect";
import { runLocalReview } from "../lib/local-review";
import { setRendererActive } from "../lib/renderer-active-store";
import { buildChapterDNA, buildNeighborhoodContext, buildContinuityBrief } from "../lib/chapter-dna";
import { profileCharacterVoices, computeTagVariety } from "../lib/character-voice";
import { scoreParagraphs, selectRiskExcerpt } from "../lib/paragraph-risk";
import { diffChapter, formatDiffForPrompt, hashChapter } from "../lib/chapter-diff";
import { summarizeContinuity } from "../lib/continuity";
import { RendererTextWall } from "./RendererTextWall";
import { RendererWorkspaceFull } from "./RendererWorkspaceFull";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import { ArrowUpIcon, Maximize2Icon } from "./Icon";
import { emptyNovel } from "../lib/parser";
import {
  type ProjectStatus,
  type ClaudeStatus,
  type PipelineOp,
  type StreamEvent,
  getCurrentProject,
  getClaudeStatus,
  listCanon,
  loadProjectState,
  readProjectFile,
  runPipeline,
  cancelPipeline,
  saveProjectState,
  subscribeStream,
  openProject,
  createProject,
  isDesktopApp,
} from "../lib/project-manager";
import { clearProjectLocalStorage, loadNovelFromProject, saveNovelToProject } from "../lib/storage";
import { type ToolRegistry, EMPTY_REGISTRY, buildToolRegistry } from "../lib/tool-registry";
import { buildToolContext, prepareToolRun, executeToolLogic, type ToolLogicContext, type ToolLogicResult, type ToolHighlight } from "../lib/tool-runner";

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  chapterId: string | null;
  chapterContent: string | undefined;
  chapterTitle: string | undefined;
  needsProjectSaveWarning?: boolean;
  reviewResult: ReviewResult | null;
  onReviewComplete: (result: ReviewResult) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
  onProjectLoaded: (novel: Novel | null) => void | Promise<void>;
  onNovelRefresh: (novel: Novel | null) => void | Promise<void>;
  // Context injection props — optional, used to enrich Claude prompts
  chapterAnalysis?: ChapterAnalysis | null;
  chapterSpeechResults?: ChapterParaResult[];
  worldData?: WorldData;
  allChapters?: Chapter[];
  chapterIndex?: number;
  onToolHighlights?: (highlights: ToolHighlight[]) => void;
  onToolWidgetData?: (toolName: string, data: unknown) => void;
  visible?: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "thinking" | "tool";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface PersistedRendererChatState {
  version: 1;
  messages: ChatMessage[];
  model: string;
  effort: string;
  chapterNum?: number;
  claudeSessionId: string | null;
  // diff snapshot: stores the chapter hash + Claude's last review summary per chapterId
  lastScanSnapshot?: Record<string, { hash: string; summary: string; timestamp: number }>;
}

interface PendingCanonRegistration {
  fileName: string;
  relPath: string;
  number: number;
  title: string;
  content: string;
}

interface RegistrationMeta {
  number: number;
  title: string;
}

interface NovelIndexIssue {
  missing: RegistrationMeta[];
  stale: RegistrationMeta[];
  orderMismatch: boolean;
}

// ── Pipeline shortcuts ───────────────────────────────────────────────────────

const PIPELINE_COMMANDS: Record<string, { op: PipelineOp; label: string; requiresChapter?: boolean }> = {
  "/init":     { op: "init",            label: "Initialize novel" },
  "/context":  { op: "context-packet",  label: "Build context packet", requiresChapter: true },
  "/draft":    { op: "draft",           label: "Draft chapter", requiresChapter: true },
  "/review":   { op: "review",          label: "Prose review", requiresChapter: true },
  "/lore":     { op: "lore-check",      label: "Lore check", requiresChapter: true },
  "/assemble": { op: "assemble",        label: "Canon assembly", requiresChapter: true },
  "/update":   { op: "artifact-update", label: "Artifact update", requiresChapter: true },
};

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

const EFFORT_LEVELS = ["low", "medium", "high"];
const DEFAULT_MODEL = "sonnet";
const DEFAULT_EFFORT = "high";
const RENDERER_CHAT_STATE_KEY = "renderer-chat";
const LOCAL_SCAN_FLAG_LIMIT = 6;
const CLAUDE_SCAN_MAX_CHARS = 18_000;
const PROJECT_NOVEL_PATH = "novel.txt";
const CANON_DIR_PREFIX = "canon/";
const CANON_HEADER_RE = /^===CHAPTER\s+(\d+):\s*(.+?)===\s*(?:\n|$)/;
const CANON_FILE_NUMBER_RE = /(?:^|[^0-9])ch(?:apter)?[_-]?(\d+)(?=[^0-9]|$)/i;

const TEMPORARY_DRAFT_WARNING = "This draft is still in temporary desktop mode. Open or create a project folder now so it can be saved as novel.txt before using Renderer tools.";
const PROJECT_SESSION_WARNING = "Renderer chat sessions are saved per project. Open or create a project folder before using Renderer.";
const DESKTOP_REQUIRED_LABEL = "See the magic happen on desktop";
const DESKTOP_REQUIRED_MESSAGE = "Renderer comes alive in the desktop app with persistent Claude sessions, live tool streaming, and project-aware writing workflows. Open Latent Write on desktop to start using Renderer.";

function withoutStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message, streaming: false }));
}

function markActiveStreamMessages(messages: ChatMessage[]): { messages: ChatMessage[]; hasStreamableTurn: boolean } {
  const lastUserIndex = messages.reduce((lastIndex, message, index) => (
    message.role === "user" ? index : lastIndex
  ), -1);

  let streamTargetIndex = -1;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" || message.role === "thinking") {
      streamTargetIndex = index;
      break;
    }
  }

  return {
    hasStreamableTurn: streamTargetIndex >= 0,
    messages: messages.map((message, index) => ({
      ...message,
      streaming: index === streamTargetIndex,
    })),
  };
}

function formatSystemFailure(prefix: string, detail?: string | null): string {
  const trimmed = detail?.trim();
  return trimmed ? `${prefix}\n${trimmed}` : prefix;
}

function truncateScanContent(content: string): string {
  if (content.length <= CLAUDE_SCAN_MAX_CHARS) return content;
  return `${content.slice(0, CLAUDE_SCAN_MAX_CHARS).trimEnd()}\n\n[chapter truncated for scan]`;
}

function summarizeLocalScanFlags(flags: ReviewFlag[]): string[] {
  const counts = new Map<string, number>();
  for (const flag of flags) {
    counts.set(flag.type, (counts.get(flag.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}: ${count}`);
}

function formatLocalScanSummary(result: ReviewResult): string {
  if (result.flags.length === 0) {
    return "Local scan found no heuristic matches. That is only the fast on-device pass, not a full clean bill of health.";
  }

  const patternSummary = summarizeLocalScanFlags(result.flags);
  const detailLines = result.flags
    .slice(0, LOCAL_SCAN_FLAG_LIMIT)
    .map((flag) => `• [${flag.type}] ${flag.quote}\n  fix: ${flag.fix}`);
  const hiddenCount = Math.max(0, result.flags.length - LOCAL_SCAN_FLAG_LIMIT);

  return [
    `Local scan found ${result.flags.length} heuristic flag${result.flags.length === 1 ? "" : "s"}.`,
    patternSummary.length > 0 ? `Patterns: ${patternSummary.join(" · ")}` : null,
    ...detailLines,
    hiddenCount > 0 ? `+ ${hiddenCount} more local flag${hiddenCount === 1 ? "" : "s"}.` : null,
  ].filter(Boolean).join("\n");
}

function buildClaudeScanPrompt(
  chapterTitle: string | undefined,
  chapterContent: string,
  localReview: ReviewResult,
  chapterDNA?: string,
  diffBlock?: string,
  excerpt?: { paragraphs: string[]; truncated: boolean },
): string {
  const label = chapterTitle?.trim() || "Current chapter";
  const localFlags = localReview.flags.length === 0
    ? ["Local heuristic scan: no flags. Treat that as inconclusive, not as proof the chapter is clean."]
    : [
        `Local heuristic scan found ${localReview.flags.length} flag${localReview.flags.length === 1 ? "" : "s"}.`,
        ...localReview.flags.slice(0, LOCAL_SCAN_FLAG_LIMIT).map((flag) => `- [${flag.type}] ${flag.quote} | fix: ${flag.fix}`),
      ];

  // Chapter text: use targeted risk excerpt when available, else naive truncation
  const chapterBlock = excerpt
    ? excerpt.paragraphs.join("\n\n") + (excerpt.truncated ? "\n\n[...additional paragraphs omitted by risk filter...]" : "")
    : truncateScanContent(chapterContent);

  const parts: string[] = [
    "You are a prose editor reviewing a chapter. Respond in chat only. No file edits.",
    `Chapter: ${label}`,
  ];

  // Structural context (reduces Claude's own re-derivation work)
  if (chapterDNA) {
    parts.push("", chapterDNA);
  }

  // Iterative diff context (for repeated scans of same chapter)
  if (diffBlock) {
    parts.push("", diffBlock);
  }

  parts.push(
    "",
    `LOCAL SCAN FINDINGS (${localReview.flags.length} flag${localReview.flags.length === 1 ? "" : "s"}):`,
    ...localFlags,
    "",
    excerpt && excerpt.truncated ? "CHAPTER EXCERPT (high-risk paragraphs selected):" : "CHAPTER TEXT:",
    "<<<CHAPTER>>>",
    chapterBlock,
    "<<<END CHAPTER>>>",
    "",
    "TASK:",
    "1. Confirm, reject, or refine the local scan findings.",
    "2. Add 1–3 high-priority issues the scan missed.",
    "3. One concrete next-pass action.",
    "Return: Verdict | Confirmed | Misses/false-positives | Next pass",
  );

  return parts.join("\n");
}

function normalizeRegistrationTitle(number: number, title: string): string {
  const trimmed = title.trim();
  return trimmed || `Chapter ${number}`;
}

function formatRegistrationLabel(entry: RegistrationMeta): string {
  return `Ch ${entry.number} · ${normalizeRegistrationTitle(entry.number, entry.title)}`;
}

function registrationMetaKey(entry: RegistrationMeta): string {
  return `${entry.number}\u001f${normalizeRegistrationTitle(entry.number, entry.title)}`;
}

function extractNovelRegistrations(raw: string): { chapters: RegistrationMeta[]; indexEntries: RegistrationMeta[] } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const chapters: RegistrationMeta[] = [];
  const indexEntries: RegistrationMeta[] = [];
  let inIndex = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "===INDEX===") {
      inIndex = true;
      continue;
    }

    const chapterMatch = trimmed.match(/^===CHAPTER\s+(\d+):\s*(.+?)===$/);
    if (chapterMatch) {
      chapters.push({
        number: Number.parseInt(chapterMatch[1], 10),
        title: normalizeRegistrationTitle(Number.parseInt(chapterMatch[1], 10), chapterMatch[2]),
      });
      inIndex = false;
      continue;
    }

    if (trimmed.startsWith("===") && trimmed.endsWith("===")) {
      inIndex = false;
      continue;
    }

    if (!inIndex) continue;
    const indexMatch = trimmed.match(/^(\d+):\s*(.*)$/);
    if (!indexMatch) continue;
    const number = Number.parseInt(indexMatch[1], 10);
    if (!Number.isFinite(number) || number <= 0) continue;
    indexEntries.push({
      number,
      title: normalizeRegistrationTitle(number, indexMatch[2]),
    });
  }

  return { chapters, indexEntries };
}

function findNovelIndexIssue(raw: string): NovelIndexIssue | null {
  const { chapters, indexEntries } = extractNovelRegistrations(raw);
  if (chapters.length === 0) return null;

  const chapterKeys = chapters.map(registrationMetaKey);
  const indexKeys = indexEntries.map(registrationMetaKey);
  const chapterKeySet = new Set(chapterKeys);
  const indexKeySet = new Set(indexKeys);

  const missing = chapters.filter((entry) => !indexKeySet.has(registrationMetaKey(entry)));
  const stale = indexEntries.filter((entry) => !chapterKeySet.has(registrationMetaKey(entry)));
  const orderMismatch = missing.length === 0
    && stale.length === 0
    && (chapterKeys.length !== indexKeys.length || chapterKeys.some((key, index) => key !== indexKeys[index]));

  if (missing.length === 0 && stale.length === 0 && !orderMismatch) return null;
  return { missing, stale, orderMismatch };
}

function parseCanonRegistration(fileName: string, raw: string): PendingCanonRegistration | null {
  const normalized = raw.replace(/\r\n?/g, "\n").trimEnd();
  if (!normalized.trim()) return null;

  const headerMatch = normalized.match(CANON_HEADER_RE);
  if (headerMatch) {
    const number = Number.parseInt(headerMatch[1], 10);
    if (!Number.isFinite(number) || number <= 0) return null;
    return {
      fileName,
      relPath: `${CANON_DIR_PREFIX}${fileName}`,
      number,
      title: headerMatch[2].trim() || `Chapter ${number}`,
      content: normalized.slice(headerMatch[0].length).replace(/^\n+/, "").trimEnd(),
    };
  }

  const fileNumberMatch = fileName.match(CANON_FILE_NUMBER_RE);
  if (!fileNumberMatch) return null;

  const number = Number.parseInt(fileNumberMatch[1], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    fileName,
    relPath: `${CANON_DIR_PREFIX}${fileName}`,
    number,
    title: `Chapter ${number}`,
    content: normalized,
  };
}

function mergeCanonRegistrations(novel: Novel, pending: PendingCanonRegistration[]): Novel {
  if (pending.length === 0) return novel;

  const existingNumbers = new Set(novel.chapters.map((chapter) => chapter.number));
  const nextChapters: Chapter[] = [];

  for (const entry of pending) {
    if (existingNumbers.has(entry.number)) continue;
    existingNumbers.add(entry.number);
    nextChapters.push({
      id: uid(),
      number: entry.number,
      title: entry.title,
      content: entry.content,
    });
  }

  if (nextChapters.length === 0) return novel;
  return {
    ...novel,
    chapters: [...novel.chapters, ...nextChapters].sort((left, right) => left.number - right.number),
  };
}

function formatCanonRegistrationLabel(entry: PendingCanonRegistration): string {
  return formatRegistrationLabel(entry);
}

function isNovelRegistrationPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === "novel.txt"
    || normalized.endsWith("/novel.txt")
    || normalized.startsWith(CANON_DIR_PREFIX)
    || normalized.includes("/canon/");
}

function parseCommandChapterNumber(text: string, command: string): number | undefined {
  const rawArgs = text.slice(command.length).trim();
  if (!rawArgs) return undefined;
  const match = rawArgs.match(/\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const PlainTextBlock = memo(function PlainTextBlock({ text, tone }: { text: string; tone?: "user" | "system" | "thinking" }) {
  return <div className={`rp-chat-plain-text${tone ? ` rp-chat-plain-text--${tone}` : ""}`}>{text}</div>;
});

// ── Collapsible wrappers for long content ───────────────────────────────────

const MSG_COLLAPSE_HEIGHT = 320;
const CODE_COLLAPSE_HEIGHT = 200;

function CollapsiblePre({ node, children, ...rest }: any) {
  const ref = useRef<HTMLPreElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > CODE_COLLAPSE_HEIGHT);
  });

  const isCollapsed = overflows && collapsed;

  return (
    <div className="rp-code-wrap">
      <pre ref={ref} className={isCollapsed ? "rp-code--clamped" : undefined} {...rest}>
        {children}
      </pre>
      {overflows && (
        <button type="button" className="rp-code-expand" onClick={() => setCollapsed(v => !v)}>
          {collapsed ? "Expand" : "Collapse"}
        </button>
      )}
    </div>
  );
}

const MD_COMPONENTS: Record<string, React.ComponentType<any>> = { pre: CollapsiblePre };

const AssistantBubble = memo(function AssistantBubble({ msg }: { msg: ChatMessage }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (msg.streaming) {
      setOverflows(false);
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > MSG_COLLAPSE_HEIGHT);
  }, [msg.content, msg.streaming]);

  const isClamped = overflows && collapsed && !msg.streaming;

  return (
    <div className="rp-chat-bubble rp-chat-bubble--assistant">
      <div className="rp-chat-message-shell rp-chat-message-shell--assistant">
        {msg.streaming ? (
          <div ref={bodyRef} className="rp-chat-markdown">
            <PlainTextBlock text={msg.content} />
          </div>
        ) : (
          <div
            ref={bodyRef}
            className={`rp-chat-markdown${isClamped ? " rp-chat-markdown--clamped" : ""}`}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
        {msg.streaming && <span className="rp-chat-stream-cursor" aria-hidden="true" />}
        {overflows && !msg.streaming && (
          <button
            type="button"
            className="rp-chat-expand-toggle"
            onClick={() => setCollapsed(v => !v)}
          >
            {collapsed ? "Show full response" : "Collapse"}
          </button>
        )}
      </div>
    </div>
  );
}, (prev, next) => prev.msg === next.msg);

// ── Thinking bubble — collapsed by default, shows last 3 lines, expandable ──

const THINKING_PREVIEW_LINES = 3;

const ThinkingBubble = memo(function ThinkingBubble({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const lines = msg.content.split("\n");
  const isLong = lines.length > THINKING_PREVIEW_LINES;
  const preview = isLong && !expanded
    ? lines.slice(-THINKING_PREVIEW_LINES).join("\n")
    : msg.content;

  return (
    <div className={`rp-chat-bubble rp-chat-bubble--thinking${expanded ? " rp-chat-thinking--expanded" : ""}`}>
      <button
        type="button"
        className="rp-chat-thinking-header"
        onClick={isLong ? () => setExpanded((v) => !v) : undefined}
        disabled={!isLong}
        data-expandable={isLong ? "" : undefined}
      >
        <span className="rp-chat-thinking-label">
          Thinking{isLong && !expanded ? ` · ${lines.length} lines` : ""}
        </span>
        {isLong && <span className="rp-chat-thinking-toggle">{expanded ? "Collapse" : "Expand"}</span>}
      </button>
      <div className="rp-chat-message-shell rp-chat-message-shell--thinking">
        <PlainTextBlock text={preview} tone="thinking" />
      </div>
    </div>
  );
}, (prev, next) => prev.msg === next.msg);

const PendingBubble = memo(function PendingBubble() {
  return (
    <div className="rp-chat-bubble rp-chat-bubble--pending">
      <div className="rp-chat-message-shell rp-chat-message-shell--pending">
        <span className="rp-chat-pending-label">Thinking</span>
        <span className="rp-chat-typing-indicator rp-chat-typing-indicator--pending" aria-hidden="true">
          <span /><span /><span />
        </span>
      </div>
    </div>
  );
});

interface RendererIntroProps {
  hasProject: boolean;
  desktop: boolean;
  onOpenProject: () => void;
  setInput: (val: string) => void;
}

const INTRO_PIPELINE: [string, string, string][] = [
  ["/scan",       "/scan",       "quick prose scan"],
  ["/draft ",     "/draft N",    "new chapter draft"],
  ["/review ",    "/review N",   "eval + prose passes"],
  ["/lore ",      "/lore N",     "lore check"],
  ["/context ",   "/context N",  "context packet"],
  ["/assemble ",  "/assemble N", "canon assembly"],
];

const INTRO_PROMPTS: [string, string][] = [
  ["write the next chapter",            "write the next chapter"],
  ["check for AI fingerprints",         "check for AI fingerprints"],
  ["is chapter  ready to assemble?",    "is chapter N ready to assemble?"],
];

const RendererIntro = memo(function RendererIntro({ hasProject, desktop, onOpenProject, setInput }: RendererIntroProps) {
  return (
    <div className="rp-intro">
      {!hasProject && desktop && (
        <div className="rp-intro-section">
          <div className="rp-intro-label">Start</div>
          <div className="rp-intro-list">
            <button className="rp-intro-cmd-row" onClick={onOpenProject}>
              <span className="rp-intro-cmd">Open Project</span>
              <span className="rp-intro-desc">open existing novel</span>
            </button>
            <button className="rp-intro-cmd-row" onClick={() => setInput("/init")}>
              <span className="rp-intro-cmd">/init</span>
              <span className="rp-intro-desc">initialize new novel</span>
            </button>
          </div>
        </div>
      )}
      <div className="rp-intro-section">
        <div className="rp-intro-label">Tools</div>
        <div className="rp-intro-list">
          {INTRO_PIPELINE.map(([fill, cmd, desc]) => (
            <button key={cmd} className="rp-intro-cmd-row" onClick={() => setInput(fill)}>
              <span className="rp-intro-cmd">{cmd}</span>
              <span className="rp-intro-desc">{desc}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rp-intro-section">
        <div className="rp-intro-label">Try</div>
        <div className="rp-intro-list">
          {INTRO_PROMPTS.map(([fill, label]) => (
            <button key={label} className="rp-intro-prompt-row" onClick={() => setInput(fill)}>
              "{label}"
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

const ChatMessageBubble = memo(function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "thinking") return <ThinkingBubble msg={msg} />;

  if (msg.role === "assistant") {
    return <AssistantBubble msg={msg} />;
  }

  if (msg.role === "tool") {
    return (
      <div className="rp-chat-bubble rp-chat-bubble--tool">
        <div className="rp-chat-tool-pill">{msg.content}</div>
      </div>
    );
  }

  if (msg.role === "system") {
    return (
      <div className="rp-chat-bubble rp-chat-bubble--system">
        <div className="rp-chat-message-shell rp-chat-message-shell--system">
          <PlainTextBlock text={msg.content} tone="system" />
        </div>
      </div>
    );
  }

  return (
    <div className="rp-chat-bubble rp-chat-bubble--user">
      <div className="rp-chat-message-shell rp-chat-message-shell--user">
        <PlainTextBlock text={msg.content} tone="user" />
      </div>
    </div>
  );
}, (prev, next) => prev.msg === next.msg);

// ── Component ────────────────────────────────────────────────────────────────

export function RendererPanel({
  chapterId, chapterContent, chapterTitle,
  needsProjectSaveWarning = false,
  reviewResult: _reviewResult, onReviewComplete,
  prefs: _prefs, onSetPrefs: _onSetPrefs,
  onProjectLoaded,
  onNovelRefresh,
  chapterAnalysis,
  chapterSpeechResults,
  worldData,
  allChapters,
  chapterIndex,
  onToolHighlights,
  onToolWidgetData,
  visible = true,
}: Props) {
  void _onSetPrefs; void _reviewResult;

  // Scan snapshot for diff-based iterative reviews (keyed by chapterId)
  const [scanSnapshots, setScanSnapshots] = useState<Record<string, { hash: string; summary: string; timestamp: number }>>({});

  const [project, setProject]     = useState<ProjectStatus | null>(null);
  const [claude, setClaude]       = useState<ClaudeStatus | null>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistry>(EMPTY_REGISTRY);
  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [input, setInput]         = useState("");
  const [streaming, setStreaming] = useState(false);
  const [awaitingFirstChunk, setAwaitingFirstChunk] = useState(false);
  const [model, setModel]         = useState(DEFAULT_MODEL);
  const [effort, setEffort]       = useState(DEFAULT_EFFORT);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [chatHydrating, setChatHydrating] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [registrationRefreshToken, setRegistrationRefreshToken] = useState(0);
  const [toolRefreshToken, setToolRefreshToken] = useState(0);
  const [missingCanonRegistrations, setMissingCanonRegistrations] = useState<PendingCanonRegistration[]>([]);
  const [novelIndexIssue, setNovelIndexIssue] = useState<NovelIndexIssue | null>(null);
  const [registeringCanon, setRegisteringCanon] = useState(false);
  const [repairingNovelIndex, setRepairingNovelIndex] = useState(false);

  useEffect(() => {
    const isActive = streaming || awaitingFirstChunk;
    setRendererActive(isActive);
    return () => setRendererActive(false);
  }, [streaming, awaitingFirstChunk]);

  const panelMessagesEndRef = useRef<HTMLDivElement>(null);
  const fullscreenMessagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamMsgId = useRef<string | null>(null);
  const thinkingMsgId = useRef<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const fileRefreshTimerRef = useRef<number | null>(null);
  const pendingProjectNoticeRef = useRef<string | null>(null);
  const pendingToolCommandRef = useRef<string | null>(null);
  const hydratedProjectPathRef = useRef<string | null>(null);
  const desktop = isDesktopApp();
  const browserBlocked = !desktop;

  const refreshMissingCanonRegistrations = useCallback(async (): Promise<PendingCanonRegistration[]> => {
    if (!desktop || !project?.path) {
      setMissingCanonRegistrations([]);
      return [];
    }

    const canonEntries = await listCanon();
    if (canonEntries.length === 0) return [];

    const novel = await loadNovelFromProject();
    const existingNumbers = new Set((novel?.chapters ?? []).map((chapter) => chapter.number));
    const pendingEntries = await Promise.all(canonEntries.map(async (entry) => {
      const raw = await readProjectFile(`${CANON_DIR_PREFIX}${entry.name}`);
      if (!raw) return null;
      return parseCanonRegistration(entry.name, raw);
    }));

    const uniqueByNumber = new Map<number, PendingCanonRegistration>();
    for (const entry of pendingEntries) {
      if (!entry || existingNumbers.has(entry.number) || uniqueByNumber.has(entry.number)) continue;
      uniqueByNumber.set(entry.number, entry);
    }

    return [...uniqueByNumber.values()].sort((left, right) => left.number - right.number);
  }, [desktop, project?.path]);

  const refreshNovelIndexIssue = useCallback(async (): Promise<NovelIndexIssue | null> => {
    if (!desktop || !project?.path) {
      setNovelIndexIssue(null);
      return null;
    }

    const rawNovel = await readProjectFile(PROJECT_NOVEL_PATH);
    if (!rawNovel?.trim()) return null;
    return findNovelIndexIssue(rawNovel);
  }, [desktop, project?.path]);

  const resetChatState = useCallback(() => {
    hydratedProjectPathRef.current = null;
    streamMsgId.current = null;
    thinkingMsgId.current = null;
    setMessages([]);
    setStreaming(false);
    setAwaitingFirstChunk(false);
    setModel(DEFAULT_MODEL);
    setEffort(DEFAULT_EFFORT);
    setClaudeSessionId(null);
  }, []);

  const appendStreamChunk = useCallback((role: "assistant" | "thinking", ref: React.MutableRefObject<string | null>, text: string) => {
    if (!text) return;
    setMessages((prev) => {
      let id = ref.current;
      let next = prev;
      if (!id || !prev.some((message) => message.id === id)) {
        id = `${role}-${uid()}`;
        ref.current = id;
        next = [...prev, { id, role, content: "", timestamp: Date.now(), streaming: true }];
      }
      return next.map((message) => (
        message.id === id
          ? { ...message, content: message.content + text, streaming: true }
          : message
      ));
    });
  }, []);

  const addSystemMsg = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: uid(), role: "system", content: text, timestamp: Date.now() }]);
  }, []);

  const addFailureMsg = useCallback((prefix: string, detail?: string | null) => {
    addSystemMsg(formatSystemFailure(prefix, detail));
  }, [addSystemMsg]);

  const clearConversation = useCallback(() => {
    streamMsgId.current = null;
    thinkingMsgId.current = null;
    setMessages([]);
    setStreaming(false);
    setAwaitingFirstChunk(false);
    setClaudeSessionId(null);
  }, []);

  const handleRegisterMissingCanon = useCallback(async () => {
    if (registeringCanon || !desktop || !project?.path) return;

    setRegisteringCanon(true);
    try {
      const pending = await refreshMissingCanonRegistrations();
      if (pending.length === 0) {
        setMissingCanonRegistrations([]);
        addSystemMsg("Canon files are already registered in novel.txt.");
        return;
      }

      const baseNovel = (await loadNovelFromProject()) ?? emptyNovel();
      const nextNovel = mergeCanonRegistrations(baseNovel, pending);
      if (nextNovel.chapters.length === baseNovel.chapters.length) {
        setMissingCanonRegistrations([]);
        return;
      }

      const saved = await saveNovelToProject(nextNovel);
      if (!saved) {
        addFailureMsg("Registering canon chapters failed.", "Could not write novel.txt.");
        return;
      }

      await onNovelRefresh(nextNovel);
      setMissingCanonRegistrations([]);
      setWorkspaceRefreshToken((value) => value + 1);
      setRegistrationRefreshToken((value) => value + 1);
      addSystemMsg(
        pending.length === 1
          ? `Registered ${formatCanonRegistrationLabel(pending[0])} from ${pending[0].relPath} into novel.txt.`
          : `Registered ${pending.length} canon chapters into novel.txt: ${pending.map((entry) => `Ch ${entry.number}`).join(", ")}.`,
      );
    } catch (error) {
      addFailureMsg(
        "Registering canon chapters failed.",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRegisteringCanon(false);
    }
  }, [registeringCanon, desktop, project?.path, refreshMissingCanonRegistrations, addSystemMsg, addFailureMsg, onNovelRefresh]);

  const handleRepairNovelIndex = useCallback(async () => {
    if (repairingNovelIndex || !desktop || !project?.path) return;

    setRepairingNovelIndex(true);
    try {
      const issue = await refreshNovelIndexIssue();
      if (!issue) {
        setNovelIndexIssue(null);
        addSystemMsg("novel.txt index is already up to date.");
        return;
      }

      const novel = await loadNovelFromProject();
      if (!novel) {
        addFailureMsg("Rebuilding novel index failed.", "Could not read novel.txt.");
        return;
      }

      const saved = await saveNovelToProject(novel);
      if (!saved) {
        addFailureMsg("Rebuilding novel index failed.", "Could not write novel.txt.");
        return;
      }

      await onNovelRefresh(novel);
      setNovelIndexIssue(null);
      setWorkspaceRefreshToken((value) => value + 1);
      setRegistrationRefreshToken((value) => value + 1);
      addSystemMsg(
        issue.missing.length === 1 && issue.stale.length === 0 && !issue.orderMismatch
          ? `Rebuilt novel.txt index and registered ${formatRegistrationLabel(issue.missing[0])}.`
          : "Rebuilt the novel.txt index from the chapter markers already in the file.",
      );
    } catch (error) {
      addFailureMsg(
        "Rebuilding novel index failed.",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRepairingNovelIndex(false);
    }
  }, [repairingNovelIndex, desktop, project?.path, refreshNovelIndexIssue, addSystemMsg, addFailureMsg, onNovelRefresh]);

  const getResumeSessionId = useCallback(() => claudeSessionId ?? undefined, [claudeSessionId]);

  const setClaudeRuntimeActive = useCallback((sessionId?: string, operation?: string) => {
    setClaude((prev) => {
      if (!prev) {
        return {
          installed: true,
          path: null,
          active: true,
          activeSessionId: sessionId ?? null,
          activeOperation: operation ?? null,
          activeCwd: project?.path ?? null,
        };
      }
      return {
        ...prev,
        active: true,
        activeSessionId: sessionId ?? prev.activeSessionId ?? null,
        activeOperation: operation ?? prev.activeOperation ?? null,
        activeCwd: project?.path ?? prev.activeCwd ?? null,
      };
    });
  }, [project?.path]);

  const clearClaudeRuntimeActive = useCallback(() => {
    setClaude((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        active: false,
        activeSessionId: null,
        activeOperation: null,
        activeCwd: null,
      };
    });
  }, []);

  const finishStreaming = useCallback((errorText?: string) => {
    const assistantId = streamMsgId.current;
    const thinkingId = thinkingMsgId.current;

    setMessages((prev) => {
      let next = prev.map((message) => {
        if (message.id === assistantId) {
          return {
            ...message,
            content: errorText ? `${message.content}${message.content ? "\n" : ""}${errorText}` : message.content,
            streaming: false,
          };
        }
        if (message.id === thinkingId) return { ...message, streaming: false };
        return message;
      });

      next = next.filter((message) => {
        if (message.id === thinkingId) return message.content.trim().length > 0;
        if (message.id === assistantId) return message.content.trim().length > 0;
        return true;
      });

      if (!assistantId && errorText) {
        next = [...next, { id: uid(), role: "system", content: errorText, timestamp: Date.now() }];
      }

      return next;
    });

    streamMsgId.current = null;
    thinkingMsgId.current = null;
    setStreaming(false);
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!desktop) return;
    const fetchProject = () => getCurrentProject().then((p) => { if (p) setProject(p); });
    fetchProject();
    getClaudeStatus().then(setClaude);
    window.addEventListener("project-ready", fetchProject);
    return () => window.removeEventListener("project-ready", fetchProject);
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !project) setWorkspaceOpen(false);
  }, [desktop, project]);

  // ── Tool registry loading ──────────────────────────────────────────────
  useEffect(() => {
    if (!desktop || !project?.path || !_prefs.customToolsEnabled) {
      setToolRegistry(EMPTY_REGISTRY);
      return;
    }
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    const reader = {
      listTree: () => api.projectListTree().then((t: unknown) => (t as Array<{ name: string; path: string; type: string; children?: unknown[] }>) ?? []),
      readFile: (relPath: string) => api.projectReadFile(relPath),
    };
    buildToolRegistry(reader).then(({ registry, errors }) => {
      if (cancelled) return;
      setToolRegistry(registry);
      if (errors.length > 0) {
        console.warn("[tool-registry]", errors);
      }
    });
    return () => { cancelled = true; };
  }, [desktop, project?.path, _prefs.customToolsEnabled, toolRefreshToken]);

  useEffect(() => {
    if (!desktop || !project?.path) {
      setMissingCanonRegistrations([]);
      return;
    }

    let cancelled = false;
    void refreshMissingCanonRegistrations()
      .then((pending) => {
        if (!cancelled) setMissingCanonRegistrations(pending);
      })
      .catch(() => {
        if (!cancelled) setMissingCanonRegistrations([]);
      });

    return () => {
      cancelled = true;
    };
  }, [desktop, project?.path, registrationRefreshToken, refreshMissingCanonRegistrations]);

  useEffect(() => {
    if (!desktop || !project?.path) {
      setNovelIndexIssue(null);
      return;
    }

    let cancelled = false;
    void refreshNovelIndexIssue()
      .then((issue) => {
        if (!cancelled) setNovelIndexIssue(issue);
      })
      .catch(() => {
        if (!cancelled) setNovelIndexIssue(null);
      });

    return () => {
      cancelled = true;
    };
  }, [desktop, project?.path, registrationRefreshToken, refreshNovelIndexIssue]);

  useEffect(() => {
    if (!desktop) return;
    if (!project?.path) {
      hydratedProjectPathRef.current = null;
      setChatHydrating(false);
      resetChatState();
      return;
    }

    let cancelled = false;
    const projectPath = project.path;
    hydratedProjectPathRef.current = null;
    setChatHydrating(true);

    void loadProjectState<PersistedRendererChatState>(RENDERER_CHAT_STATE_KEY)
      .then((persisted) => {
        if (cancelled) return;

        if (persisted?.version === 1) {
          setMessages(withoutStreaming(persisted.messages ?? []));
          setModel(persisted.model || DEFAULT_MODEL);
          setEffort(EFFORT_LEVELS.includes(persisted.effort) ? persisted.effort : DEFAULT_EFFORT);
          setClaudeSessionId(persisted.claudeSessionId ?? null);
          setStreaming(false);
          streamMsgId.current = null;
          thinkingMsgId.current = null;
        } else {
          resetChatState();
        }

        const pendingNotice = pendingProjectNoticeRef.current;
        if (pendingNotice) {
          pendingProjectNoticeRef.current = null;
          setMessages((prev) => [...prev, { id: uid(), role: "system", content: pendingNotice, timestamp: Date.now() }]);
        }

        hydratedProjectPathRef.current = projectPath;
        setChatHydrating(false);
      })
      .catch(() => {
        if (cancelled) return;
        resetChatState();
        hydratedProjectPathRef.current = projectPath;
        setChatHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desktop, project?.path, resetChatState]);

  useEffect(() => {
    if (persistTimerRef.current !== null && (streaming || awaitingFirstChunk)) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!desktop || !project?.path || chatHydrating || hydratedProjectPathRef.current !== project.path || streaming || awaitingFirstChunk) return;

    const snapshot: PersistedRendererChatState = {
      version: 1,
      messages: withoutStreaming(messages),
      model,
      effort,
      claudeSessionId,
    };

    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void saveProjectState(RENDERER_CHAT_STATE_KEY, snapshot);
    }, 180);

    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [desktop, project?.path, messages, model, effort, claudeSessionId, chatHydrating, streaming, awaitingFirstChunk]);

  useEffect(() => {
    if (!desktop || chatHydrating || streaming || !claude?.active) return;
    if (claude.activeCwd && project?.path && claude.activeCwd !== project.path) return;

    const restored = markActiveStreamMessages(messages);
    setMessages(restored.messages);
    setStreaming(true);
    setAwaitingFirstChunk(!restored.hasStreamableTurn);
    if (claude.activeSessionId) setClaudeSessionId(claude.activeSessionId);
  }, [desktop, chatHydrating, streaming, claude?.active, claude?.activeCwd, claude?.activeSessionId, project?.path, messages]);

  useEffect(() => {
    if (!desktop) return;
    const unsub = subscribeStream({
      onStart: (data: StreamEvent) => {
        setStreaming(true);
        setAwaitingFirstChunk(true);
        if (data.sessionId) setClaudeSessionId(data.sessionId);
        setClaudeRuntimeActive(data.sessionId, data.operation);
        streamMsgId.current = null;
        thinkingMsgId.current = null;
      },
      onData: (data: StreamEvent) => {
        setStreaming(true);
        setClaudeRuntimeActive(data.sessionId);
        if (data.sessionId) setClaudeSessionId(data.sessionId);
        const text = data.text || "";
        if (!text) return;
        setAwaitingFirstChunk(false);
        if (data.lane === "system") {
          addSystemMsg(text);
          return;
        }
        if (data.lane === "tool") {
          setMessages((prev) => [...prev, { id: uid(), role: "tool", content: text, timestamp: Date.now() }]);
          return;
        }
        if (data.lane === "thinking") {
          appendStreamChunk("thinking", thinkingMsgId, text);
          return;
        }
        appendStreamChunk("assistant", streamMsgId, text);
      },
      onEnd: () => {
        setAwaitingFirstChunk(false);
        finishStreaming();
        clearClaudeRuntimeActive();
        getCurrentProject().then((p) => { if (p) setProject(p); });
      },
      onError: (data: StreamEvent) => {
        setAwaitingFirstChunk(false);
        finishStreaming();
        clearClaudeRuntimeActive();
        addFailureMsg("Claude session ended with an error.", data.error);
      },
      onStderr: (data: StreamEvent) => {
        setStreaming(true);
        setClaudeRuntimeActive(data.sessionId);
        if (data.sessionId) setClaudeSessionId(data.sessionId);
        if (data.text) {
          setAwaitingFirstChunk(false);
          appendStreamChunk("thinking", thinkingMsgId, data.text);
        }
      },
      onFileChanged: ({ filePath }) => {
        const registrationRelevant = !!filePath && isNovelRegistrationPath(filePath);
        const toolRelevant = !!filePath && (filePath.replace(/\\/g, "/").startsWith("tools/") || filePath.replace(/\\/g, "/").includes("/tools/"));
        if (fileRefreshTimerRef.current !== null) window.clearTimeout(fileRefreshTimerRef.current);
        fileRefreshTimerRef.current = window.setTimeout(() => {
          fileRefreshTimerRef.current = null;
          setWorkspaceRefreshToken((value) => value + 1);
          if (registrationRelevant) setRegistrationRefreshToken((value) => value + 1);
          if (toolRelevant) setToolRefreshToken((value) => value + 1);
          getCurrentProject().then((p) => { if (p) setProject(p); });
          loadNovelFromProject().then((novel) => { if (novel) onNovelRefresh(novel); });
        }, 600);
      },
    });
    return unsub;
  }, [desktop, addFailureMsg, addSystemMsg, appendStreamChunk, finishStreaming, onNovelRefresh, setClaudeRuntimeActive, clearClaudeRuntimeActive]);

  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const userHasSentRef = useRef(false);

  const scrollChatToEnd = useCallback((behavior: ScrollBehavior) => {
    const activeRef = workspaceOpen ? fullscreenMessagesEndRef : panelMessagesEndRef;
    activeRef.current?.scrollIntoView({ behavior, block: "end" });
  }, [workspaceOpen]);

  useEffect(() => {
    const useSmooth = userHasSentRef.current && !streamingRef.current;
    const frameId = requestAnimationFrame(() => {
      scrollChatToEnd(useSmooth ? "smooth" : "instant");
    });
    return () => cancelAnimationFrame(frameId);
  }, [messages, awaitingFirstChunk, scrollChatToEnd]);

  useEffect(() => {
    if (!workspaceOpen) return;
    let id1 = requestAnimationFrame(() => {
      id1 = requestAnimationFrame(() => {
        scrollChatToEnd("instant");
      });
    });
    return () => cancelAnimationFrame(id1);
  }, [workspaceOpen, scrollChatToEnd]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const text = (pendingToolCommandRef.current ?? input).trim();
    pendingToolCommandRef.current = null;
    if (!text || streaming) return;
    if (!desktop) {
      addSystemMsg(DESKTOP_REQUIRED_MESSAGE);
      return;
    }
    setInput("");
    if (inputRef.current) { inputRef.current.style.height = "auto"; }
    userHasSentRef.current = true;

    setMessages(prev => [...prev, { id: uid(), role: "user", content: text, timestamp: Date.now() }]);

    const noProjectMessage = needsProjectSaveWarning ? TEMPORARY_DRAFT_WARNING : PROJECT_SESSION_WARNING;

    if (text === "/clear") {
      clearConversation();
      return;
    }

    if (text === "/help") {
      addSystemMsg(
        "Pipeline: /init | /context <chapter> | /draft <chapter> | /review <chapter> | /lore <chapter> | /assemble <chapter> | /update <chapter>\n" +
        "Claude: /model <name> /models /effort <level>\n" +
        "Scan: /scan (local + Claude when available) /clear /help"
      );
      return;
    }

    // /model <name> — local state, passed as CLI flag
    if (text.startsWith("/model")) {
      const arg = text.slice(6).trim().toLowerCase();
      if (!arg || arg === "s" || arg === "show") {
        addSystemMsg(`Model: ${model}`);
        return;
      }
      const resolved = MODEL_ALIASES[arg] || arg;
      setModel(resolved);
      addSystemMsg(`Model set to: ${resolved}`);
      return;
    }

    if (text === "/models") {
      addSystemMsg("Available aliases:\n  opus → claude-opus-4-20250514\n  sonnet → claude-sonnet-4-20250514\n  haiku → claude-haiku-4-5-20251001\n\nOr use any model ID directly: /model <id>");
      return;
    }

    // /effort <level> — local state
    if (text.startsWith("/effort")) {
      const arg = text.slice(7).trim().toLowerCase();
      if (!arg) {
        addSystemMsg(`Effort: ${effort}`);
        return;
      }
      if (EFFORT_LEVELS.includes(arg)) {
        setEffort(arg);
        addSystemMsg(`Effort set to: ${arg}`);
      } else {
        addSystemMsg(`Invalid effort. Use: low, medium, high`);
      }
      return;
    }

    if (text === "/scan") {
      if (!chapterId || !chapterContent?.trim()) { addSystemMsg("No chapter content."); return; }
      addSystemMsg("Running local scan...");
      try {
        const result = await runLocalReview(chapterId, chapterContent);
        onReviewComplete(result);
        addSystemMsg(formatLocalScanSummary(result));

        if (!project) {
          addSystemMsg("Claude deep scan skipped — open a project to chain the chapter into renderer chat.");
          return;
        }
        if (!claude?.installed) {
          addSystemMsg("Claude deep scan skipped — Claude Code is not installed.");
          return;
        }

        const api = window.electronAPI;
        if (!api) {
          addSystemMsg("Claude deep scan skipped — desktop bridge unavailable.");
          return;
        }

        // ── Build context enrichments ────────────────────────────────────
        // 1. Chapter DNA brief (structural context header)
        let chapterDNA: string | undefined;
        if (chapterAnalysis) {
          const voices = chapterSpeechResults && worldData
            ? profileCharacterVoices(
                chapterContent.split(/\n{2,}/),
                chapterSpeechResults,
                worldData,
              )
            : undefined;
          const tagVariety = computeTagVariety(chapterContent);
          // compact=true for scan: ~100 tokens vs ~350 for writing commands
          const dna = buildChapterDNA(chapterAnalysis, voices, tagVariety, chapterTitle, true);
          chapterDNA = dna.brief;
        }

        // 2. Diff block (for iterative reviews)
        const snapshot = scanSnapshots[chapterId];
        let diffBlock: string | undefined;
        if (snapshot) {
          const diff = diffChapter(snapshot.hash !== hashChapter(chapterContent) ? snapshot.hash : chapterContent, chapterContent);
          diffBlock = formatDiffForPrompt(diff, snapshot.summary) || undefined;
        }

        // 3. Risk-based excerpt (scan/review only — reduces tokens by 60-70%)
        let excerptArg: { paragraphs: string[]; truncated: boolean } | undefined;
        if (chapterContent.length > CLAUDE_SCAN_MAX_CHARS) {
          const paras = chapterContent.split(/\n{2,}/).filter(p => p.trim().length >= 15);
          const paraResults = chapterSpeechResults?.slice(0, paras.length) ?? [];
          const scores = scoreParagraphs(paras, paraResults, result.flags);
          const riskExcerpt = selectRiskExcerpt(paras, scores, CLAUDE_SCAN_MAX_CHARS);
          excerptArg = { paragraphs: riskExcerpt.paragraphs, truncated: riskExcerpt.truncated };
        }

        addSystemMsg("Local scan finished. Asking Claude to deepen the review...");
        const projectPath = await api.projectGetPath();
        const streamResult = await api.claudeStream({
          prompt: buildClaudeScanPrompt(chapterTitle, chapterContent, result, chapterDNA, diffBlock, excerptArg),
          cwd: projectPath || undefined,
          sessionId: getResumeSessionId(),
          model,
          effort,
          name: project?.meta?.name,
        });
        if (streamResult.sessionId) setClaudeSessionId(streamResult.sessionId);
        if (!streamResult.ok) addFailureMsg("Claude deep scan failed to start.", streamResult.error);
        else {
          // Store snapshot for next scan's diff
          setScanSnapshots(prev => ({
            ...prev,
            [chapterId]: { hash: hashChapter(chapterContent), summary: formatLocalScanSummary(result), timestamp: Date.now() },
          }));
        }
      } catch (e) { addFailureMsg("Scan failed.", (e as Error).message); }
      return;
    }

    const pipelineKey = text.split(/\s+/)[0];
    const pipelineCmd = PIPELINE_COMMANDS[pipelineKey];
    if (pipelineCmd) {
      if (desktop && !project) {
        addSystemMsg(noProjectMessage);
        return;
      }
      if (!claude?.installed) { addSystemMsg("Claude Code not found."); return; }
      const pipelineChapterNum = pipelineCmd.requiresChapter
        ? parseCommandChapterNumber(text, pipelineKey)
        : undefined;
      if (pipelineCmd.requiresChapter && !pipelineChapterNum) {
        addSystemMsg(`${pipelineCmd.label} requires a chapter number.\nUse ${pipelineKey} <chapter>, for example ${pipelineKey} 12.`);
        return;
      }
      const nextSessionId = getResumeSessionId();

      // Build extra context for writing/serious eval commands (add context, don't reduce).
      // These get the full chapter DNA + voice fingerprints + neighborhood + continuity.
      let extraContext: string | undefined;
      const isWritingCmd = ["/draft", "/lore", "/review", "/update", "/assemble"].includes(pipelineKey);
      if (isWritingCmd && chapterAnalysis && chapterId) {
        const contextParts: string[] = [];

        // Chapter DNA — structural brief
        const voices = chapterSpeechResults && worldData
          ? profileCharacterVoices(
              (chapterContent ?? "").split(/\n{2,}/),
              chapterSpeechResults,
              worldData,
            )
          : undefined;
        const tagVariety = chapterContent ? computeTagVariety(chapterContent) : undefined;
        const dna = buildChapterDNA(chapterAnalysis, voices, tagVariety, chapterTitle);
        contextParts.push(dna.brief);

        // Cross-chapter neighborhood (prev/next boundary context)
        if (allChapters && chapterIndex !== undefined) {
          const prevChapter = chapterIndex > 0 ? allChapters[chapterIndex - 1] : undefined;
          const nextChapter = chapterIndex < allChapters.length - 1 ? allChapters[chapterIndex + 1] : undefined;
          // 400-char per side for writing commands (full context preferred)
          const prevTail = prevChapter?.content.slice(-400);
          const nextHead = nextChapter?.content.slice(0, 400);
          const neighborhood = buildNeighborhoodContext(prevTail, nextHead, prevChapter?.title, nextChapter?.title, 400);
          if (neighborhood) contextParts.push("", neighborhood);
        }

        // Continuity signals (for lore/review)
        if (["/lore", "/review"].includes(pipelineKey) && allChapters && chapterIndex !== undefined) {
          const cont = summarizeContinuity(allChapters, worldData, chapterIndex);
          if (cont.hasAnything) {
            const brief = buildContinuityBrief(cont.outOfOrder, cont.chekhov, cont.handoff);
            if (brief) contextParts.push("", brief);
          }
        }

        extraContext = contextParts.join("\n");
      }

      const result = await runPipeline(
        pipelineCmd.op,
        pipelineChapterNum,
        extraContext,
        {
          sessionId: nextSessionId,
          model,
          effort,
          name: project?.meta?.name,
        },
      );
      if (result.sessionId) setClaudeSessionId(result.sessionId);
      if (!result.ok && !result.sessionId) addFailureMsg(`${pipelineCmd.label} failed.`, result.error);
      return;
    }

    // ── Custom tool command ────────────────────────────────────────────────
    const registeredTool = toolRegistry.commands.get(pipelineKey);
    if (registeredTool) {
      if (desktop && !project) { addSystemMsg(noProjectMessage); return; }
      const api = window.electronAPI;
      if (!api) return;

      const toolLabel = registeredTool.manifest.display;
      let logicResult: ToolLogicResult | null = null;

      // ── Phase A: execute logic module if available ────────────────────
      if (registeredTool.hasLogic) {
        let previousState: unknown = null;
        const reportDir = registeredTool.manifest.outputs.report;
        if (reportDir) {
          const dir = reportDir.endsWith("/") ? reportDir : reportDir + "/";
          const saved = await api.projectReadFile(`${dir}state.json`);
          if (saved.ok && saved.content) {
            try { previousState = JSON.parse(saved.content); } catch {}
          }
        }

        const logicCtx: ToolLogicContext = {
          chapterContent: chapterContent ?? "",
          chapterTitle: chapterTitle ?? "",
          chapterIndex: chapterIndex ?? 0,
          allChapters: (allChapters ?? []).map(c => ({ title: c.title, content: c.content, number: c.number })),
          analysis: chapterAnalysis ?? null,
          worldData: worldData ?? null,
          files: {},
          previousState,
        };
        // Read manifest input files into logicCtx.files
        if (registeredTool.manifest.inputs.files.length > 0) {
          const fileEntries = await Promise.all(
            registeredTool.manifest.inputs.files.map(async (pattern) => {
              const result = await api.projectReadFile(pattern);
              return result.ok && result.content ? [pattern, result.content] as const : null;
            }),
          );
          for (const entry of fileEntries) {
            if (entry) logicCtx.files[entry[0]] = entry[1];
          }
        }

        const compiler = { compile: api.toolCompile };
        const reader = { readFile: (relPath: string) => api.projectReadFile(relPath) };
        const logicRun = await executeToolLogic(registeredTool, logicCtx, compiler, reader);
        if (!logicRun.ok) {
          addFailureMsg(`${toolLabel} logic failed.`, logicRun.error);
          return;
        }
        logicResult = logicRun.result!;

        if (logicResult.summary) {
          addSystemMsg(logicResult.summary);
        }
        if (logicResult.highlights?.length) {
          onToolHighlights?.(logicResult.highlights);
        }
        if (logicResult.widgetData !== undefined) {
          onToolWidgetData?.(registeredTool.manifest.name, logicResult.widgetData);
        }

        if (reportDir) {
          const writeDir = reportDir.endsWith("/") ? reportDir : reportDir + "/";
          if (logicResult.report) {
            api.projectWriteFile(`${writeDir}report.json`, logicResult.report);
          }
          if (logicResult.state !== undefined) {
            api.projectWriteFile(`${writeDir}state.json`, JSON.stringify(logicResult.state, null, 2));
          }
        }

        if (!logicResult.chainClaude) return;
      }

      // ── Phase B: chain to Claude (prompt-only or logic → Claude) ─────
      if (!registeredTool.promptTemplate) {
        if (registeredTool.hasLogic) return;
        addSystemMsg(`Tool "${toolLabel}" has no logic.ts or prompt.md.`);
        return;
      }
      if (!claude?.installed) { addSystemMsg("Claude Code not found."); return; }

      const reader = {
        listTree: () => api.projectListTree().then((t: unknown) => (t as Array<{ name: string; path: string; type: string; children?: unknown[] }>) ?? []),
        readFile: (relPath: string) => api.projectReadFile(relPath),
      };
      const ctx = await buildToolContext(
        registeredTool,
        chapterContent ?? "",
        chapterTitle ?? "",
        chapterId ? parseInt(chapterId.replace(/\D/g, ""), 10) || 1 : 1,
        reader,
      );
      const run = prepareToolRun(registeredTool, ctx, logicResult?.claudeContext);
      if (!run.ok || !run.prompt) {
        addFailureMsg(`${toolLabel} failed.`, run.error);
        return;
      }
      const projectPath = await api.projectGetPath();
      const streamResult = await api.claudeStream({
        prompt: run.prompt,
        cwd: projectPath || undefined,
        sessionId: getResumeSessionId(),
        model,
        effort,
        name: project?.meta?.name,
      });
      if (streamResult.sessionId) setClaudeSessionId(streamResult.sessionId);
      if (!streamResult.ok) addFailureMsg(`${toolLabel} failed.`, streamResult.error);
      return;
    }

    // Free-form message → Claude Code stream
    if (desktop && !project) {
      addSystemMsg(noProjectMessage);
      return;
    }
    if (!claude?.installed) { addSystemMsg("Claude Code not found.\nInstall: npm i -g @anthropic-ai/claude-code"); return; }
    const api = window.electronAPI;
    if (!api) return;
    const projectPath = await api.projectGetPath();
    const streamResult = await api.claudeStream({
      prompt: text,
      cwd: projectPath || undefined,
      sessionId: getResumeSessionId(),
      model,
      effort,
      name: project?.meta?.name,
    });
    if (streamResult.sessionId) setClaudeSessionId(streamResult.sessionId);
    if (!streamResult.ok) addFailureMsg("Claude session failed to start.", streamResult.error);
  }, [input, streaming, project, claude, chapterId, chapterContent, chapterTitle, desktop, addSystemMsg, addFailureMsg, clearConversation, needsProjectSaveWarning, onReviewComplete, model, effort, getResumeSessionId, toolRegistry, chapterAnalysis, worldData, allChapters, chapterIndex, onToolHighlights, onToolWidgetData]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  useEffect(() => {
    const onToolCommand = (e: Event) => {
      const cmd = (e as CustomEvent<{ command: string }>).detail?.command;
      if (cmd) {
        pendingToolCommandRef.current = cmd;
        handleSendRef.current();
      }
    };
    window.addEventListener("tool-run-command", onToolCommand);
    return () => window.removeEventListener("tool-run-command", onToolCommand);
  }, []);

  const handleCancel = useCallback(() => { cancelPipeline(); }, []);

  const handleOpenProject = useCallback(async () => {
    const p = await openProject();
    if (!p) return;
    pendingProjectNoticeRef.current = p.meta?.name || p.path;
    setProject(p);
    setWorkspaceRefreshToken((value) => value + 1);
    setRegistrationRefreshToken((value) => value + 1);
    clearProjectLocalStorage();
    const novel = await loadNovelFromProject();
    pendingProjectNoticeRef.current = novel
      ? `Opened: ${p.meta?.name || p.path} (${novel.chapters.length} chapters)`
      : `Opened: ${p.meta?.name || p.path} (empty project)`;
    await onProjectLoaded(novel);
  }, [addSystemMsg, onProjectLoaded]);

  const handleCreateProject = useCallback(async () => {
    const p = await createProject("MyNovel");
    if (!p) return;
    pendingProjectNoticeRef.current = `Created: ${p.meta?.name || p.path}`;
    setProject(p);
    setWorkspaceRefreshToken((value) => value + 1);
    setRegistrationRefreshToken((value) => value + 1);
    clearProjectLocalStorage();
    await onProjectLoaded(null);
  }, [onProjectLoaded]);

  // ── Input height tracking ─────────────────────────────────────────────
  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    t.style.height = "auto";
    const h = Math.min(t.scrollHeight, 72);
    t.style.height = h + "px";
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  const renderChatInner = (variant: "panel" | "fullscreen") => {
    const endRef = variant === "panel" ? panelMessagesEndRef : fullscreenMessagesEndRef;

    return (
      <div className={`rp-chat-body rp-chat-body--${variant}`}>
        <div className="rp-chat-messages">
          {novelIndexIssue && (
            <div className="rp-chat-registration-card">
              <div className="rp-chat-registration-eyebrow">Novel Index Drift</div>
              <div className="rp-chat-registration-title">
                {novelIndexIssue.missing.length === 1 && novelIndexIssue.stale.length === 0 && !novelIndexIssue.orderMismatch
                  ? `${formatRegistrationLabel(novelIndexIssue.missing[0])} is missing from the novel.txt index`
                  : novelIndexIssue.missing.length > 1
                    ? `${novelIndexIssue.missing.length} chapters are missing from the novel.txt index`
                    : "The novel.txt index is out of sync with its chapter blocks"}
              </div>
              <div className="rp-chat-registration-copy">
                The chapter text is already in novel.txt. This will rebuild the raw ===INDEX=== section from the chapter markers already in the file.
              </div>
              <div className="rp-chat-registration-list">
                {novelIndexIssue.missing.slice(0, 3).map((entry) => (
                  <div key={registrationMetaKey(entry)} className="rp-chat-registration-item">
                    <span className="rp-chat-registration-label">{formatRegistrationLabel(entry)}</span>
                    <span className="rp-chat-registration-path">novel.txt</span>
                  </div>
                ))}
                {novelIndexIssue.missing.length > 3 && (
                  <div className="rp-chat-registration-more">
                    +{novelIndexIssue.missing.length - 3} more chapter{novelIndexIssue.missing.length - 3 === 1 ? "" : "s"} missing from the index
                  </div>
                )}
                {novelIndexIssue.missing.length === 0 && novelIndexIssue.stale.length > 0 && (
                  <div className="rp-chat-registration-more">
                    {novelIndexIssue.stale.length} stale index entr{novelIndexIssue.stale.length === 1 ? "y" : "ies"} will be replaced.
                  </div>
                )}
                {novelIndexIssue.orderMismatch && novelIndexIssue.missing.length === 0 && novelIndexIssue.stale.length === 0 && (
                  <div className="rp-chat-registration-more">
                    The right entries exist, but they are out of order.
                  </div>
                )}
              </div>
              <div className="rp-chat-registration-actions">
                <button
                  type="button"
                  className="rp-chat-registration-btn"
                  onClick={handleRepairNovelIndex}
                  disabled={repairingNovelIndex || streaming}
                >
                  {repairingNovelIndex ? "Rebuilding..." : "Rebuild Index"}
                </button>
              </div>
            </div>
          )}

          {missingCanonRegistrations.length > 0 && (
            <div className="rp-chat-registration-card">
              <div className="rp-chat-registration-eyebrow">Canon Not Registered</div>
              <div className="rp-chat-registration-title">
                {missingCanonRegistrations.length === 1
                  ? `${formatCanonRegistrationLabel(missingCanonRegistrations[0])} is missing from novel.txt`
                  : `${missingCanonRegistrations.length} canon chapters are missing from novel.txt`}
              </div>
              <div className="rp-chat-registration-copy">
                The chapter index comes from novel.txt, so these chapters stay invisible until they are registered.
              </div>
              <div className="rp-chat-registration-list">
                {missingCanonRegistrations.slice(0, 3).map((entry) => (
                  <div key={entry.relPath} className="rp-chat-registration-item">
                    <span className="rp-chat-registration-label">{formatCanonRegistrationLabel(entry)}</span>
                    <span className="rp-chat-registration-path">{entry.relPath}</span>
                  </div>
                ))}
                {missingCanonRegistrations.length > 3 && (
                  <div className="rp-chat-registration-more">
                    +{missingCanonRegistrations.length - 3} more canon chapter{missingCanonRegistrations.length - 3 === 1 ? "" : "s"}
                  </div>
                )}
              </div>
              <div className="rp-chat-registration-actions">
                <button
                  type="button"
                  className="rp-chat-registration-btn"
                  onClick={handleRegisterMissingCanon}
                  disabled={registeringCanon || streaming}
                >
                  {registeringCanon
                    ? "Registering..."
                    : missingCanonRegistrations.length === 1
                      ? "Register In novel.txt"
                      : `Register ${missingCanonRegistrations.length} Chapters`}
                </button>
              </div>
            </div>
          )}

          {messages.length === 0 && (
            <div className={`rp-chat-empty${browserBlocked ? " rp-chat-empty--desktop" : ""}`}>
              {browserBlocked ? (
                <>
                  <p className="rp-chat-empty-title">{DESKTOP_REQUIRED_LABEL}</p>
                  <p className="rp-chat-empty-subtle">{DESKTOP_REQUIRED_MESSAGE}</p>
                </>
              ) : (
                <RendererIntro
                  hasProject={!!project}
                  desktop={desktop}
                  onOpenProject={handleOpenProject}
                  setInput={setInput}
                />
              )}
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessageBubble key={msg.id} msg={msg} />
          ))}
          {awaitingFirstChunk && <PendingBubble />}
          <div ref={endRef} />
        </div>

        <div className="rp-chat-input-area">
          {streaming && (
            <button onClick={handleCancel} className="rp-chat-cancel-btn">Stop</button>
          )}
          <div className={`rp-chat-input-row${browserBlocked ? " rp-chat-input-row--disabled" : ""}${streaming ? " rp-chat-input-row--streaming" : ""}`}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={browserBlocked ? DESKTOP_REQUIRED_LABEL : streaming ? "Waiting..." : "Message or /command..."}
              disabled={browserBlocked || streaming}
              rows={1}
              className="rp-chat-textarea"
              onInput={handleInput}
            />
            <button
              onClick={handleSend}
              disabled={browserBlocked || !input.trim() || streaming}
              className="rp-chat-send-btn"
              data-active={!browserBlocked && input.trim() && !streaming ? "" : undefined}
              aria-label="Send message"
            >
              <ArrowUpIcon size={12} />
            </button>
          </div>

          {!browserBlocked && input.startsWith("/") && !streaming && (
            <div className="rp-chat-hints">
              {Object.entries(PIPELINE_COMMANDS)
                .filter(([cmd]) => cmd.startsWith(input.split(" ")[0]))
                .slice(0, 3)
                .map(([cmd, info]) => (
                  <button key={cmd} onClick={() => { setInput(info.requiresChapter ? `${cmd} ` : cmd); inputRef.current?.focus(); }} className="rp-chat-hint-btn">
                    <span className="rp-chat-hint-cmd">{cmd}</span>
                    <span className="rp-chat-hint-label">{info.label}</span>
                  </button>
                ))}
              {["/model", "/models", "/effort", "/scan", "/clear", "/help"]
                .filter(cmd => cmd.startsWith(input.split(" ")[0]) && !PIPELINE_COMMANDS[cmd])
                .slice(0, 2)
                .map(cmd => (
                  <button key={cmd} onClick={() => { setInput(cmd + " "); inputRef.current?.focus(); }} className="rp-chat-hint-btn">
                    <span className="rp-chat-hint-cmd">{cmd}</span>
                  </button>
                ))}
              {Array.from(toolRegistry.commands.entries())
                .filter(([cmd]) => cmd.startsWith(input.split(" ")[0]))
                .slice(0, 2)
                .map(([cmd, tool]) => (
                  <button key={cmd} onClick={() => { setInput(cmd + " "); inputRef.current?.focus(); }} className="rp-chat-hint-btn">
                    <span className="rp-chat-hint-cmd">{cmd}</span>
                    <span className="rp-chat-hint-label">{tool.manifest.display}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className={`settings-panel rp-chat-shell rp-chat-shell--panel${visible ? " liquid-glass" : ""}`} {...(visible ? { "data-liquid-glass-scroll-adaptive": "panel" } : {})} style={{ position: "relative", overflow: "hidden", flex: "1 1 0", minHeight: 0, height: "100%" }}>
        {!workspaceOpen && <RendererTextWall fontScale={1.1} height={630} opacity={0.7} />}

        <div className="rp-chat-header">
          <img src={rendererLogoUrl} alt="" className="rp-logo" />
          {desktop && project && (
            <span className="rp-chat-project-name">{project.meta?.name}</span>
          )}
          <span style={{ flex: 1 }} />

          {desktop && (
            <>
              <span className="rp-chat-chip" title={`Model: ${model}`}>
                {model.includes("-") ? model.split("-").slice(1, 3).join("-") : model}
              </span>
              <span className="rp-chat-chip" title={`Effort: ${effort}`}>
                {effort}
              </span>
            </>
          )}

          {desktop && project && (
            <button
              type="button"
              className="icon-btn rp-chat-expand-btn"
              onClick={() => setWorkspaceOpen(true)}
              aria-label="Open renderer workspace"
              title="Open renderer workspace"
            >
              <Maximize2Icon size={12} />
            </button>
          )}

          {desktop && !project && (
            <button onClick={handleOpenProject} className="rp-chat-open-btn">Open</button>
          )}
          {desktop && !project && (
            <button onClick={handleCreateProject} className="rp-chat-open-btn">New</button>
          )}
          {desktop && (
            <span className="rp-chat-status-dot" data-ok={claude?.installed ? "" : undefined} />
          )}
        </div>

        {!workspaceOpen && renderChatInner("panel")}
      </div>
      {workspaceOpen && desktop && project && createPortal(
        <RendererWorkspaceFull
          project={project}
          claude={claude}
          model={model}
          effort={effort}
          chatPane={renderChatInner("fullscreen")}
          refreshToken={workspaceRefreshToken}
          onClose={() => setWorkspaceOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
