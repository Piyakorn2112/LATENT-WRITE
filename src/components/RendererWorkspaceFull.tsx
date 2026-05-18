import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import { RendererTextWall } from "./RendererTextWall";
import { ChevronRight, CloseIcon, FileTextIcon, FolderIcon } from "./Icon";
import {
  listProjectTree,
  readProjectFile,
  type ClaudeStatus,
  type ProjectStatus,
  type ProjectTreeNode,
} from "../lib/project-manager";

interface Props {
  project: ProjectStatus;
  claude: ClaudeStatus | null;
  model: string;
  effort: string;
  refreshToken: number;
  chatPane: ReactNode;
  onClose: () => void;
}

const RENDERER_OVERLAY_BODY_CLASS = "renderer-workspace-freeze";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 300;
const MIN_CENTER_WIDTH = 360;
const SIDEBAR_WIDTH = 248;

function isPreviewableFile(relativePath: string | null): boolean {
  if (!relativePath) return false;
  const normalized = relativePath.toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".txt");
}

function fileKindLabel(relativePath: string | null): string {
  if (!relativePath) return "No file selected";
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith(".md")) return "Markdown";
  if (normalized.endsWith(".txt")) return "Plain text";
  return "Preview unavailable";
}

function collectPreviewableFiles(nodes: ProjectTreeNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === "file") return node.supported ? [node.path] : [];
    return collectPreviewableFiles(node.children ?? []);
  });
}

function findPreferredFile(nodes: ProjectTreeNode[]): string | null {
  const files = collectPreviewableFiles(nodes);
  if (files.length === 0) return null;

  const priorities = [
    (path: string) => path.toLowerCase() === "novel.txt",
    (path: string) => path.toLowerCase().endsWith("_story_primary.txt") || path.toLowerCase() === "story_primary.txt",
    (path: string) => path.toLowerCase() === "novel_configuration.md",
    (path: string) => path.toLowerCase() === "naming_reference.md",
    (path: string) => path.toLowerCase() === "claude.md",
  ];

  for (const match of priorities) {
    const preferred = files.find(match);
    if (preferred) return preferred;
  }

  return files[0] ?? null;
}

function hasNodePath(nodes: ProjectTreeNode[], targetPath: string): boolean {
  return nodes.some((node) => {
    if (node.path === targetPath) return true;
    return node.type === "directory" && hasNodePath(node.children ?? [], targetPath);
  });
}

function findAncestorPaths(nodes: ProjectTreeNode[], targetPath: string, trail: string[] = []): string[] {
  for (const node of nodes) {
    if (node.path === targetPath) return trail;
    if (node.type !== "directory") continue;
    const nextTrail = [...trail, node.path];
    const result = findAncestorPaths(node.children ?? [], targetPath, nextTrail);
    if (result.length > 0 || node.children?.some((child) => child.path === targetPath)) return result;
  }
  return [];
}

function renderTree(
  nodes: ProjectTreeNode[],
  depth: number,
  expandedPaths: Set<string>,
  selectedPath: string | null,
  onToggle: (path: string) => void,
  onSelect: (path: string) => void,
): ReactNode {
  return nodes.map((node) => {
    const expanded = node.type === "directory" && expandedPaths.has(node.path);
    const selected = selectedPath === node.path;

    return (
      <div key={node.path} className="renderer-full-tree-node">
        <button
          type="button"
          className="renderer-full-tree-row"
          data-selected={selected ? "" : undefined}
          data-kind={node.type}
          data-supported={node.supported ? "" : undefined}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => {
            if (node.type === "directory") {
              onToggle(node.path);
              return;
            }
            onSelect(node.path);
          }}
          title={node.path}
          aria-expanded={node.type === "directory" ? expanded : undefined}
        >
          {node.type === "directory" ? (
            <span className="renderer-full-tree-chevron" data-open={expanded ? "" : undefined} aria-hidden="true">
              <ChevronRight size={11} />
            </span>
          ) : (
            <span className="renderer-full-tree-chevron renderer-full-tree-chevron--file" aria-hidden="true" />
          )}
          <span className="renderer-full-tree-icon" aria-hidden="true">
            {node.type === "directory" ? <FolderIcon size={12} /> : <FileTextIcon size={12} />}
          </span>
          <span className="renderer-full-tree-label">{node.name}</span>
        </button>

        {node.type === "directory" && expanded && (node.children?.length ?? 0) > 0 && (
          <div className="renderer-full-tree-children">
            {renderTree(node.children ?? [], depth + 1, expandedPaths, selectedPath, onToggle, onSelect)}
          </div>
        )}
      </div>
    );
  });
}

function PlainTextPreview({ content }: { content: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);

  return (
    <div className="renderer-full-viewer-prose renderer-full-viewer-prose--text">
      {lines.map((line, index) => (
        <div key={index} className="renderer-full-viewer-text-line">
          {line.length > 0 ? line : "\u00A0"}
        </div>
      ))}
    </div>
  );
}

function RendererWorkspaceFullImpl({ project, claude, model, effort, refreshToken, chatPane, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [tree, setTree] = useState<ProjectTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [resizing, setResizing] = useState(false);

  selectedPathRef.current = selectedPath;

  const clampChatWidth = useCallback((nextWidth: number) => {
    const panelWidth = panelRef.current?.clientWidth ?? window.innerWidth;
    const maxWidth = Math.max(MIN_CHAT_WIDTH, panelWidth - SIDEBAR_WIDTH - MIN_CENTER_WIDTH);
    return Math.min(Math.max(nextWidth, MIN_CHAT_WIDTH), maxWidth);
  }, []);

  useEffect(() => {
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyPosition = body.style.position;
    const prevBodyTop = body.style.top;
    const prevBodyLeft = body.style.left;
    const prevBodyWidth = body.style.width;
    const prevBodyTouchAction = body.style.touchAction;

    body.classList.add(RENDERER_OVERLAY_BODY_CLASS);
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    body.style.touchAction = "none";

    return () => {
      body.classList.remove(RENDERER_OVERLAY_BODY_CLASS);
      body.style.overflow = prevBodyOverflow;
      body.style.position = prevBodyPosition;
      body.style.top = prevBodyTop;
      body.style.left = prevBodyLeft;
      body.style.width = prevBodyWidth;
      body.style.touchAction = prevBodyTouchAction;
      window.scrollTo(scrollX, scrollY);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);

    void listProjectTree()
      .then((nodes) => {
        if (cancelled) return;
        setTree(nodes);
        setTreeLoading(false);

        const preserved = selectedPathRef.current && hasNodePath(nodes, selectedPathRef.current)
          ? selectedPathRef.current
          : findPreferredFile(nodes);

        setSelectedPath(preserved);
        if (preserved) {
          const ancestors = findAncestorPaths(nodes, preserved);
          setExpandedPaths((prev) => {
            const next = new Set(prev);
            for (const entry of ancestors) next.add(entry);
            return next;
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTree([]);
        setTreeLoading(false);
        setTreeError(error instanceof Error ? error.message : "Failed to load project files.");
      });

    return () => {
      cancelled = true;
    };
  }, [project.path, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    const filePath = selectedPath;

    if (!filePath || !isPreviewableFile(filePath)) {
      setFileContent("");
      setFileError(null);
      setFileLoading(false);
      return;
    }

    setFileLoading(true);
    setFileError(null);
    void readProjectFile(filePath)
      .then((content) => {
        if (cancelled) return;
        if (content === null) {
          setFileContent("");
          setFileError("Could not read this file.");
        } else {
          setFileContent(content);
          setFileError(null);
        }
        setFileLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFileContent("");
        setFileError(error instanceof Error ? error.message : "Could not read this file.");
        setFileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPath, refreshToken]);

  useEffect(() => {
    const syncWidth = () => {
      setChatWidth((prev) => clampChatWidth(prev));
    };

    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, [clampChatWidth]);

  useEffect(() => {
    if (!resizing) return;

    const handleMove = (event: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      setChatWidth(clampChatWidth(state.startWidth - delta));
    };

    const handleUp = () => {
      resizeStateRef.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampChatWidth, resizing]);

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: chatWidth,
    };
    setResizing(true);
  }, [chatWidth]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
    const ancestors = findAncestorPaths(tree, path);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const entry of ancestors) next.add(entry);
      return next;
    });
  }, [tree]);

  return (
    <div
      className="renderer-full-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="renderer-full-panel" ref={panelRef}>
        <RendererTextWall fontScale={0.82} height={460} topOffset={-20} opacity={0.76} />

        <div className="renderer-full-header">
          <div className="renderer-full-header-main">
            <span className="renderer-full-brand">
              <img src={rendererLogoUrl} alt="" className="renderer-full-brand-logo" />
              <span className="renderer-full-brand-text">Workspace</span>
            </span>
            <span className="renderer-full-project-pill">{project.meta?.name ?? "Project"}</span>
          </div>
          <div className="renderer-full-header-meta">
            <div className="renderer-full-header-runtime">
              <span className="rp-chat-chip" title={`Model: ${model}`}>
                {model.includes("-") ? model.split("-").slice(1, 3).join("-") : model}
              </span>
              <span className="rp-chat-chip" title={`Effort: ${effort}`}>
                {effort}
              </span>
              <span className="renderer-full-status-label">Claude</span>
              <span className="rp-chat-status-dot" data-ok={claude?.installed ? "" : undefined} />
            </div>
            <span className="renderer-full-header-path">{selectedPath ?? "Project files"}</span>
            <span className="renderer-full-header-kind">{fileKindLabel(selectedPath)}</span>
          </div>
          <button className="icon-btn renderer-full-close" type="button" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <CloseIcon />
          </button>
        </div>

        <div className="renderer-full-body">
          <aside className="renderer-full-sidebar">
            <div className="renderer-full-section-header">
              <span>Files</span>
              <span className="renderer-full-section-subtle">{project.meta?.name ?? "Project"}</span>
            </div>
            <div className="renderer-full-tree-scroll" role="tree" aria-label="Project files">
              {treeLoading && <div className="renderer-full-placeholder renderer-full-placeholder--sidebar">Loading project files…</div>}
              {!treeLoading && treeError && <div className="renderer-full-placeholder renderer-full-placeholder--sidebar">{treeError}</div>}
              {!treeLoading && !treeError && tree.length === 0 && (
                <div className="renderer-full-placeholder renderer-full-placeholder--sidebar">No project files found.</div>
              )}
              {!treeLoading && !treeError && tree.length > 0 && (
                <div className="renderer-full-tree-root">
                  {renderTree(tree, 0, expandedPaths, selectedPath, toggleExpanded, selectPath)}
                </div>
              )}
            </div>
          </aside>

          <section className="renderer-full-viewer">
            <div className="renderer-full-section-header renderer-full-section-header--viewer">
              <div className="renderer-full-section-main">
                <span className="renderer-full-section-title">{selectedPath ? selectedPath.split("/").pop() : "Preview"}</span>
                {selectedPath && <span className="renderer-full-section-subtle">{selectedPath}</span>}
              </div>
              <span className="renderer-full-viewer-kind">{fileKindLabel(selectedPath)}</span>
            </div>
            <div className="renderer-full-viewer-scroll">
              {!selectedPath && <div className="renderer-full-placeholder">Select a file to preview it here.</div>}
              {selectedPath && !isPreviewableFile(selectedPath) && (
                <div className="renderer-full-placeholder">This workspace preview supports .md and .txt files.</div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && fileLoading && (
                <div className="renderer-full-placeholder">Loading {selectedPath.split("/").pop()}…</div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && fileError && (
                <div className="renderer-full-placeholder">{fileError}</div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && !fileError && selectedPath.toLowerCase().endsWith(".md") && (
                <div className="renderer-full-viewer-prose renderer-full-viewer-prose--markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
                </div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && !fileError && selectedPath.toLowerCase().endsWith(".txt") && (
                <PlainTextPreview content={fileContent} />
              )}
            </div>
          </section>

          <div
            className="renderer-full-resizer"
            onMouseDown={startResize}
            data-active={resizing ? "" : undefined}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
          />

          <aside className="renderer-full-chat" style={{ width: `${chatWidth}px` }}>
            {chatPane}
          </aside>
        </div>
      </div>
    </div>
  );
}

export const RendererWorkspaceFull = memo(RendererWorkspaceFullImpl);