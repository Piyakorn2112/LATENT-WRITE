import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReviewResult, Novel } from "../types";
import type { Preferences } from "../lib/preferences";
import { runLocalReview } from "../lib/local-review";
import { RendererTextWall } from "./RendererTextWall";
import { RendererWorkspaceFull } from "./RendererWorkspaceFull";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import { ArrowUpIcon, Maximize2Icon } from "./Icon";
import {
  type ProjectStatus,
  type ClaudeStatus,
  type PipelineOp,
  type StreamEvent,
  getCurrentProject,
  getClaudeStatus,
  loadProjectState,
  runPipeline,
  cancelPipeline,
  saveProjectState,
  subscribeStream,
  openProject,
  createProject,
  isDesktopApp,
} from "../lib/project-manager";
import { clearProjectLocalStorage, loadNovelFromProject } from "../lib/storage";

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

function parseCommandChapterNumber(text: string, command: string): number | undefined {
  const rawArgs = text.slice(command.length).trim();
  if (!rawArgs) return undefined;
  const match = rawArgs.match(/\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function PlainTextBlock({ text, tone }: { text: string; tone?: "user" | "system" | "thinking" }) {
  return <div className={`rp-chat-plain-text${tone ? ` rp-chat-plain-text--${tone}` : ""}`}>{text}</div>;
}

// ── Thinking bubble — collapsed by default, shows last 3 lines, expandable ──

const THINKING_PREVIEW_LINES = 3;

function ThinkingBubble({ msg }: { msg: ChatMessage }) {
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
}

function PendingBubble() {
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
}

function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "thinking") return <ThinkingBubble msg={msg} />;

  if (msg.role === "assistant") {
    return (
      <div className="rp-chat-bubble rp-chat-bubble--assistant">
        <div className="rp-chat-message-shell rp-chat-message-shell--assistant">
          <div className="rp-chat-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
          {msg.streaming && <span className="rp-chat-stream-cursor" aria-hidden="true" />}
        </div>
      </div>
    );
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
}

// ── Component ────────────────────────────────────────────────────────────────

export function RendererPanel({
  chapterId, chapterContent, chapterTitle: _chapterTitle,
  needsProjectSaveWarning = false,
  reviewResult: _reviewResult, onReviewComplete,
  prefs: _prefs, onSetPrefs: _onSetPrefs,
  onProjectLoaded,
}: Props) {
  void _prefs; void _onSetPrefs; void _chapterTitle; void _reviewResult;

  const [project, setProject]     = useState<ProjectStatus | null>(null);
  const [claude, setClaude]       = useState<ClaudeStatus | null>(null);
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

  const panelMessagesEndRef = useRef<HTMLDivElement>(null);
  const fullscreenMessagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamMsgId = useRef<string | null>(null);
  const thinkingMsgId = useRef<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const fileRefreshTimerRef = useRef<number | null>(null);
  const pendingProjectNoticeRef = useRef<string | null>(null);
  const hydratedProjectPathRef = useRef<string | null>(null);
  const desktop = isDesktopApp();
  const browserBlocked = !desktop;

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
    getCurrentProject().then(setProject);
    getClaudeStatus().then(setClaude);
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !project) setWorkspaceOpen(false);
  }, [desktop, project]);

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
    if (!desktop || !project?.path || chatHydrating || hydratedProjectPathRef.current !== project.path) return;

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
  }, [desktop, project?.path, messages, model, effort, claudeSessionId, chatHydrating]);

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
      onFileChanged: () => {
        if (fileRefreshTimerRef.current !== null) window.clearTimeout(fileRefreshTimerRef.current);
        fileRefreshTimerRef.current = window.setTimeout(() => {
          fileRefreshTimerRef.current = null;
          setWorkspaceRefreshToken((value) => value + 1);
          getCurrentProject().then((p) => { if (p) setProject(p); });
          loadNovelFromProject().then((novel) => { if (novel) onProjectLoaded(novel); });
        }, 600);
      },
    });
    return unsub;
  }, [desktop, addFailureMsg, addSystemMsg, appendStreamChunk, finishStreaming, onProjectLoaded, setClaudeRuntimeActive, clearClaudeRuntimeActive]);

  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const userHasSentRef = useRef(false);

  const scrollChatToEnd = useCallback((behavior: ScrollBehavior) => {
    const refs = [panelMessagesEndRef, fullscreenMessagesEndRef];
    const seen = new Set<HTMLDivElement>();

    for (const ref of refs) {
      const el = ref.current;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      el.scrollIntoView({ behavior, block: "end" });
    }
  }, []);

  useEffect(() => {
    const useSmooth = userHasSentRef.current && !streamingRef.current;
    const frameId = requestAnimationFrame(() => {
      scrollChatToEnd(useSmooth ? "smooth" : "instant");
    });
    return () => cancelAnimationFrame(frameId);
  }, [messages, awaitingFirstChunk, workspaceOpen, scrollChatToEnd]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const text = input.trim();
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
        "Local: /scan /clear /help"
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
      addSystemMsg("Scanning...");
      try {
        const result = await runLocalReview(chapterId, chapterContent);
        onReviewComplete(result);
        if (result.flags.length === 0) addSystemMsg("Clean — no patterns found.");
        else addSystemMsg(result.flags.map(f => `• ${f.type}: ${f.fix}`).join("\n"));
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
      const result = await runPipeline(
        pipelineCmd.op,
        pipelineChapterNum,
        undefined,
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
  }, [input, streaming, project, claude, chapterId, chapterContent, desktop, addSystemMsg, addFailureMsg, clearConversation, needsProjectSaveWarning, onReviewComplete, model, effort, getResumeSessionId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const handleCancel = useCallback(() => { cancelPipeline(); }, []);

  const handleOpenProject = useCallback(async () => {
    const p = await openProject();
    if (!p) return;
    pendingProjectNoticeRef.current = p.meta?.name || p.path;
    setProject(p);
    setWorkspaceRefreshToken((value) => value + 1);
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
          {messages.length === 0 && (
            <div className={`rp-chat-empty${browserBlocked ? " rp-chat-empty--desktop" : ""}`}>
              {browserBlocked ? (
                <>
                  <p className="rp-chat-empty-title">{DESKTOP_REQUIRED_LABEL}</p>
                  <p className="rp-chat-empty-subtle">{DESKTOP_REQUIRED_MESSAGE}</p>
                </>
              ) : (
                <>
                  <p>Type a message or command.</p>
                  <div className="rp-chat-quick-row">
                    {!project && desktop && <button onClick={handleOpenProject} className="rp-chat-quick-btn">Open Project</button>}
                    <button onClick={() => setInput("/help")} className="rp-chat-quick-btn">/help</button>
                    <button onClick={() => setInput("/scan")} className="rp-chat-quick-btn">/scan</button>
                    {project && <button onClick={() => setInput("/draft ")} className="rp-chat-quick-btn">/draft</button>}
                  </div>
                </>
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
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="settings-panel liquid-glass rp-chat-shell rp-chat-shell--panel" style={{ position: "relative", overflow: "hidden", flex: "1 1 0", minHeight: 0, height: "100%" }}>
        <RendererTextWall />

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

        {renderChatInner("panel")}
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
