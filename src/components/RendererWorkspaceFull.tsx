import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rendererLogoUrl from "../assets/renderer-logo.svg";
import { ChevronRight, CloseIcon, ExternalLinkIcon, FileTextIcon, FolderIcon } from "./Icon";
import {
  listProjectTree,
  readProjectFile,
  writeProjectFile,
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
  // "overlay" (default): scrim + centred box inside the main window.
  // "window": full-bleed, fills a standalone OS window.
  variant?: "overlay" | "window";
  // Spawn the standalone workspace window (overlay variant only).
  onPopOut?: () => void;
}

const RENDERER_OVERLAY_BODY_CLASS = "renderer-workspace-freeze";
const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 300;
const MIN_CENTER_WIDTH = 360;
const SIDEBAR_WIDTH = 248;

function isPreviewableFile(relativePath: string | null): boolean {
  if (!relativePath) return false;
  const normalized = relativePath.toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".txt") || normalized.endsWith(".json");
}

// Every previewable file is also editable (md / txt / json).
function isEditableFile(relativePath: string | null): boolean {
  return isPreviewableFile(relativePath);
}

function isJsonFile(relativePath: string | null): boolean {
  return !!relativePath && relativePath.toLowerCase().endsWith(".json");
}

function fileKindLabel(relativePath: string | null): string {
  if (!relativePath) return "No file selected";
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith(".md")) return "Markdown";
  if (normalized.endsWith(".txt")) return "Plain text";
  if (normalized.endsWith(".json")) return "JSON";
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

interface SectionHeading {
  lineIndex: number;
  label: string;
}

interface SectionAnchor {
  sectionIdx: number;
  top: number;
}

interface ChunkSlice {
  startLine: number;
  endLine: number;
  sectionIdx: number | null;
}

interface TextPreviewChunk {
  key: string;
  sectionIdx: number | null;
  lines: string[];
  estimatedHeight: number;
}

interface MarkdownPreviewChunk {
  key: string;
  sectionIdx: number | null;
  content: string;
  estimatedHeight: number;
}

const SECTION_LABEL_MAX = 24;
const SECTION_H2_RE = /^##\s+(.+)/;
const SECTION_HR_RE = /^(?:---|===)\s*$/;
const SECTION_ACTIVE_TOP_OFFSET = 8;
const SECTION_BOTTOM_EPSILON = 12;
const VIEWER_CHUNK_OVERSCAN_PX = 960;
const TEXT_CHUNK_LINE_COUNT = 72;
const TEXT_CHUNK_ESTIMATED_LINE_HEIGHT = 22;
const MARKDOWN_CHUNK_ESTIMATED_LINE_HEIGHT = 28;
const MARKDOWN_CHUNK_MIN_HEIGHT = 160;
const TEXT_VIRTUALIZE_CHAR_THRESHOLD = 4000;
const MARKDOWN_VIRTUALIZE_CHAR_THRESHOLD = 5000;

function parseSections(content: string, filePath: string): SectionHeading[] {
  const lines = content.split("\n");
  const isMd = filePath.toLowerCase().endsWith(".md");
  const sections: SectionHeading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = SECTION_H2_RE.exec(line);
    if (h2) {
      let label = h2[1].replace(/\*+/g, "").trim();
      if (label.length > SECTION_LABEL_MAX) label = label.slice(0, SECTION_LABEL_MAX - 1) + "\u2026";
      sections.push({ lineIndex: i, label });
      continue;
    }
    if (!isMd && SECTION_HR_RE.test(line)) {
      const next = lines[i + 1]?.trim();
      if (next && next.length > 0 && !SECTION_HR_RE.test(next)) {
        let label = next.replace(/^[#*\-]+\s*/, "").trim();
        if (label.length > SECTION_LABEL_MAX) label = label.slice(0, SECTION_LABEL_MAX - 1) + "\u2026";
        if (label.length > 0) sections.push({ lineIndex: i + 1, label });
      }
    }
  }

  return sections;
}

function sectionContainer(scrollEl: HTMLDivElement): HTMLElement | null {
  const container = scrollEl.querySelector(".renderer-full-viewer-prose");
  return container instanceof HTMLElement ? container : null;
}

function buildSectionAnchors(scrollEl: HTMLDivElement, sections: SectionHeading[], isMd: boolean): SectionAnchor[] {
  const anchorElements = Array.from(scrollEl.querySelectorAll<HTMLElement>("[data-section-anchor-index]"));
  if (anchorElements.length > 0) {
    return anchorElements
      .map((element) => {
        const rawIndex = element.dataset.sectionAnchorIndex;
        if (rawIndex == null) return null;
        const sectionIdx = Number.parseInt(rawIndex, 10);
        if (!Number.isFinite(sectionIdx)) return null;
        return {
          sectionIdx,
          top: element.offsetTop - scrollEl.offsetTop,
        };
      })
      .filter((anchor): anchor is SectionAnchor => anchor !== null)
      .sort((left, right) => left.sectionIdx - right.sectionIdx);
  }

  const container = sectionContainer(scrollEl);
  if (!container) return [];

  if (!isMd) {
    return sections.flatMap((section, sectionIdx) => {
      const element = container.children[section.lineIndex];
      if (!(element instanceof HTMLElement)) return [];
      return [{ sectionIdx, top: element.offsetTop - scrollEl.offsetTop }];
    });
  }

  const headings = Array.from(container.querySelectorAll("h2"));
  return sections.flatMap((_, sectionIdx) => {
    const element = headings[sectionIdx];
    if (!(element instanceof HTMLElement)) return [];
    return [{ sectionIdx, top: element.offsetTop - scrollEl.offsetTop }];
  });
}

function findActiveSectionIndex(anchors: SectionAnchor[], scrollTop: number): number {
  const targetTop = scrollTop + SECTION_ACTIVE_TOP_OFFSET;
  let low = 0;
  let high = anchors.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (anchors[mid].top <= targetTop) {
      best = anchors[mid].sectionIdx;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function SectionIndex({ sections, scrollRef, isMd }: { sections: SectionHeading[]; scrollRef: React.RefObject<HTMLDivElement | null>; isMd: boolean }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const anchorsRef = useRef<SectionAnchor[]>([]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    if (sections.length === 0) {
      anchorsRef.current = [];
      setActiveIndex(-1);
      return;
    }

    let scrollRafId = 0;
    let refreshRafId = 0;

    const update = () => {
      const scrollTop = scrollEl.scrollTop;
      const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

      if (maxScrollTop - scrollTop <= SECTION_BOTTOM_EPSILON) {
        setActiveIndex((prev) => (prev === sections.length - 1 ? prev : sections.length - 1));
        return;
      }

      const next = findActiveSectionIndex(anchorsRef.current, scrollTop);
      setActiveIndex((prev) => (prev === next ? prev : next));
    };

    const scheduleUpdate = () => {
      if (scrollRafId !== 0) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        update();
      });
    };

    const refreshAnchors = () => {
      anchorsRef.current = buildSectionAnchors(scrollEl, sections, isMd);
      update();
    };

    const scheduleRefresh = () => {
      if (refreshRafId !== 0) return;
      refreshRafId = requestAnimationFrame(() => {
        refreshRafId = 0;
        refreshAnchors();
      });
    };

    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        scheduleRefresh();
      })
      : null;

    const container = sectionContainer(scrollEl);
    resizeObserver?.observe(scrollEl);
    if (container) resizeObserver?.observe(container);

    refreshAnchors();
    scheduleRefresh();
    scrollEl.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (scrollRafId !== 0) cancelAnimationFrame(scrollRafId);
      if (refreshRafId !== 0) cancelAnimationFrame(refreshRafId);
      resizeObserver?.disconnect();
      scrollEl.removeEventListener("scroll", scheduleUpdate);
    };
  }, [sections, scrollRef, isMd]);

  const jumpTo = useCallback((sectionIdx: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let anchor = anchorsRef.current.find((entry) => entry.sectionIdx === sectionIdx);
    if (!anchor) {
      anchorsRef.current = buildSectionAnchors(scrollEl, sections, isMd);
      anchor = anchorsRef.current.find((entry) => entry.sectionIdx === sectionIdx);
      if (!anchor) return;
    }

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const targetTop = Math.min(Math.max(0, anchor.top), maxScrollTop);
    setActiveIndex((prev) => (prev === sectionIdx ? prev : sectionIdx));
    scrollEl.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [scrollRef, sections, isMd]);

  if (sections.length === 0) return null;

  return (
    <div className="renderer-full-section-index">
      <div className="renderer-full-section-index-header">
        <span>Sections</span>
      </div>
      <div className="renderer-full-section-index-list">
        {sections.map((section, sectionIdx) => (
          <button
            key={section.lineIndex}
            type="button"
            className="renderer-full-section-index-btn"
            data-active={sectionIdx === activeIndex ? "" : undefined}
            onClick={() => jumpTo(sectionIdx)}
            title={section.label}
          >
            <span className="renderer-full-section-index-num">{sectionIdx}</span>
            <span className="renderer-full-section-index-label">{section.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildChunkSlices(totalLines: number, sections: SectionHeading[]): ChunkSlice[] {
  if (totalLines <= 0) return [];
  if (sections.length === 0) {
    return [{ startLine: 0, endLine: totalLines - 1, sectionIdx: null }];
  }

  const slices: ChunkSlice[] = [];
  const firstSectionLine = sections[0]?.lineIndex ?? 0;
  if (firstSectionLine > 0) {
    slices.push({ startLine: 0, endLine: firstSectionLine - 1, sectionIdx: null });
  }

  for (let index = 0; index < sections.length; index += 1) {
    const startLine = sections[index].lineIndex;
    const endLine = index + 1 < sections.length
      ? sections[index + 1].lineIndex - 1
      : totalLines - 1;
    if (startLine > endLine) continue;
    slices.push({ startLine, endLine, sectionIdx: index });
  }

  return slices;
}

function buildTextChunks(content: string, sections: SectionHeading[]): TextPreviewChunk[] {
  const lines = content.split("\n");
  if (sections.length > 0) {
    return buildChunkSlices(lines.length, sections).map((slice, index) => {
      const chunkLines = lines.slice(slice.startLine, slice.endLine + 1);
      return {
        key: `text-section-${index}`,
        sectionIdx: slice.sectionIdx,
        lines: chunkLines,
        estimatedHeight: Math.max(TEXT_CHUNK_ESTIMATED_LINE_HEIGHT, chunkLines.length * TEXT_CHUNK_ESTIMATED_LINE_HEIGHT),
      };
    });
  }

  const chunks: TextPreviewChunk[] = [];
  for (let start = 0; start < lines.length; start += TEXT_CHUNK_LINE_COUNT) {
    const end = Math.min(lines.length, start + TEXT_CHUNK_LINE_COUNT);
    const chunkLines = lines.slice(start, end);
    chunks.push({
      key: `text-${start}`,
      sectionIdx: null,
      lines: chunkLines,
      estimatedHeight: Math.max(TEXT_CHUNK_ESTIMATED_LINE_HEIGHT, chunkLines.length * TEXT_CHUNK_ESTIMATED_LINE_HEIGHT),
    });
  }
  return chunks;
}

function buildMarkdownChunks(content: string, sections: SectionHeading[]): MarkdownPreviewChunk[] {
  const lines = content.split("\n");
  const slices = buildChunkSlices(lines.length, sections);
  if (slices.length <= 1) {
    return [{
      key: "markdown-full",
      sectionIdx: sections.length > 0 ? 0 : null,
      content,
      estimatedHeight: Math.max(MARKDOWN_CHUNK_MIN_HEIGHT, lines.length * MARKDOWN_CHUNK_ESTIMATED_LINE_HEIGHT),
    }];
  }

  return slices.map((slice, index) => {
    const lineCount = slice.endLine - slice.startLine + 1;
    return {
      key: `markdown-${index}`,
      sectionIdx: slice.sectionIdx,
      content: lines.slice(slice.startLine, slice.endLine + 1).join("\n"),
      estimatedHeight: Math.max(MARKDOWN_CHUNK_MIN_HEIGHT, lineCount * MARKDOWN_CHUNK_ESTIMATED_LINE_HEIGHT),
    };
  });
}

function findFirstVisibleChunk(chunkTops: number[], chunkHeights: number[], targetTop: number): number {
  let low = 0;
  let high = chunkTops.length - 1;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const chunkBottom = chunkTops[mid] + chunkHeights[mid];
    if (chunkBottom >= targetTop) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return best;
}

function findLastVisibleChunk(chunkTops: number[], targetBottom: number): number {
  let low = 0;
  let high = chunkTops.length - 1;
  let best = chunkTops.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (chunkTops[mid] <= targetBottom) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function useVirtualChunkWindow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  resetKey: string,
  estimatedHeights: number[],
) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const [chunkHeights, setChunkHeights] = useState<number[]>(estimatedHeights);
  const cleanupRef = useRef<Map<number, () => void>>(new Map());

  const disconnectMeasuredChunks = useCallback(() => {
    for (const dispose of cleanupRef.current.values()) dispose();
    cleanupRef.current.clear();
  }, []);

  useEffect(() => {
    setChunkHeights(estimatedHeights);
    disconnectMeasuredChunks();
  }, [disconnectMeasuredChunks, estimatedHeights, resetKey]);

  useEffect(() => () => {
    disconnectMeasuredChunks();
  }, [disconnectMeasuredChunks]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let rafId = 0;
    const updateViewport = () => {
      const nextScrollTop = scrollEl.scrollTop;
      const nextHeight = scrollEl.clientHeight;
      setViewport((prev) => (
        prev.scrollTop === nextScrollTop && prev.height === nextHeight
          ? prev
          : { scrollTop: nextScrollTop, height: nextHeight }
      ));
    };

    const scheduleViewport = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateViewport();
      });
    };

    updateViewport();
    scrollEl.addEventListener("scroll", scheduleViewport, { passive: true });
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        scheduleViewport();
      })
      : null;
    resizeObserver?.observe(scrollEl);

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      scrollEl.removeEventListener("scroll", scheduleViewport);
    };
  }, [resetKey, scrollRef]);

  const chunkTops = useMemo(() => {
    const tops = new Array(chunkHeights.length);
    let offset = 0;
    for (let index = 0; index < chunkHeights.length; index += 1) {
      tops[index] = offset;
      offset += chunkHeights[index] ?? 0;
    }
    return tops;
  }, [chunkHeights]);

  const visibleRange = useMemo(() => {
    if (chunkHeights.length === 0) return { start: 0, end: -1 };
    if (viewport.height <= 0) {
      return { start: 0, end: Math.min(chunkHeights.length - 1, 1) };
    }

    const startTarget = Math.max(0, viewport.scrollTop - VIEWER_CHUNK_OVERSCAN_PX);
    const endTarget = viewport.scrollTop + viewport.height + VIEWER_CHUNK_OVERSCAN_PX;
    const start = findFirstVisibleChunk(chunkTops, chunkHeights, startTarget);
    const end = Math.max(start, findLastVisibleChunk(chunkTops, endTarget));
    return { start, end };
  }, [chunkHeights, chunkTops, viewport.height, viewport.scrollTop]);

  const registerChunk = useCallback((index: number, node: HTMLDivElement | null) => {
    cleanupRef.current.get(index)?.();
    cleanupRef.current.delete(index);
    if (!node) return;

    const measure = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setChunkHeights((prev) => {
        if (index >= prev.length) return prev;
        if (Math.abs((prev[index] ?? 0) - nextHeight) < 1) return prev;
        const next = [...prev];
        next[index] = nextHeight;
        return next;
      });
    };

    measure();
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        measure();
      });
      resizeObserver.observe(node);
      cleanupRef.current.set(index, () => resizeObserver.disconnect());
    }
  }, []);

  return { chunkHeights, visibleRange, registerChunk };
}

function PlainTextPreview({
  content,
  scrollRef,
  sections,
}: {
  content: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sections: SectionHeading[];
}) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const chunks = useMemo(() => buildTextChunks(content, sections), [content, sections]);
  const shouldVirtualize = content.length >= TEXT_VIRTUALIZE_CHAR_THRESHOLD && chunks.length > 1;
  const virtualizationKey = useMemo(() => chunks.map((chunk) => chunk.key).join("\u001e"), [chunks]);
  const estimatedHeights = useMemo(() => chunks.map((chunk) => chunk.estimatedHeight), [chunks]);
  const { chunkHeights, visibleRange, registerChunk } = useVirtualChunkWindow(
    scrollRef,
    shouldVirtualize ? virtualizationKey : "",
    shouldVirtualize ? estimatedHeights : [],
  );

  if (!shouldVirtualize) {
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

  return (
    <div className="renderer-full-viewer-prose renderer-full-viewer-prose--text">
      {chunks.map((chunk, index) => {
        const isVisible = index >= visibleRange.start && index <= visibleRange.end;
        const chunkHeight = chunkHeights[index] ?? chunk.estimatedHeight;
        return (
          <div
            key={chunk.key}
            className={`renderer-full-viewer-chunk renderer-full-viewer-text-chunk${isVisible ? "" : " renderer-full-viewer-chunk--placeholder"}`}
            data-section-anchor-index={chunk.sectionIdx != null ? String(chunk.sectionIdx) : undefined}
            ref={isVisible ? (node) => registerChunk(index, node) : undefined}
            style={isVisible ? undefined : { height: `${chunkHeight}px` }}
            aria-hidden={!isVisible ? true : undefined}
          >
            {isVisible && chunk.lines.map((line, lineIndex) => (
              <div key={`${chunk.key}-${lineIndex}`} className="renderer-full-viewer-text-line">
                {line.length > 0 ? line : "\u00A0"}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownPreview({
  content,
  scrollRef,
  sections,
}: {
  content: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sections: SectionHeading[];
}) {
  const chunks = useMemo(() => buildMarkdownChunks(content, sections), [content, sections]);
  const shouldVirtualize = content.length >= MARKDOWN_VIRTUALIZE_CHAR_THRESHOLD && chunks.length > 1;
  const virtualizationKey = useMemo(() => chunks.map((chunk) => chunk.key).join("\u001e"), [chunks]);
  const estimatedHeights = useMemo(() => chunks.map((chunk) => chunk.estimatedHeight), [chunks]);
  const { chunkHeights, visibleRange, registerChunk } = useVirtualChunkWindow(
    scrollRef,
    shouldVirtualize ? virtualizationKey : "",
    shouldVirtualize ? estimatedHeights : [],
  );

  if (!shouldVirtualize) {
    return (
      <div className="renderer-full-viewer-prose renderer-full-viewer-prose--markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="renderer-full-viewer-prose renderer-full-viewer-prose--markdown">
      {chunks.map((chunk, index) => {
        const isVisible = index >= visibleRange.start && index <= visibleRange.end;
        const chunkHeight = chunkHeights[index] ?? chunk.estimatedHeight;
        return (
          <div
            key={chunk.key}
            className={`renderer-full-viewer-chunk renderer-full-viewer-markdown-chunk${isVisible ? "" : " renderer-full-viewer-chunk--placeholder"}`}
            data-section-anchor-index={chunk.sectionIdx != null ? String(chunk.sectionIdx) : undefined}
            ref={isVisible ? (node) => registerChunk(index, node) : undefined}
            style={isVisible ? undefined : { height: `${chunkHeight}px` }}
            aria-hidden={!isVisible ? true : undefined}
          >
            {isVisible ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RendererWorkspaceFullImpl({ project, claude, model, effort, refreshToken, chatPane, onClose, variant = "overlay", onPopOut }: Props) {
  const isWindow = variant === "window";
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewerScrollRef = useRef<HTMLDivElement | null>(null);
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

  // ── File editing ──
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = editMode && draft !== fileContent;

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
    // In the standalone window, Esc must not close the OS window (it would
    // discard unsaved edits); the window chrome / Cmd+W owns that.
    if (isWindow) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, isWindow]);

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

  // Leave edit mode whenever the selected file changes. `draft` is kept
  // independent of `fileContent`, so background reloads (e.g. Claude editing a
  // file) refresh the on-disk baseline without discarding in-progress edits.
  useEffect(() => {
    setEditMode(false);
    setDraft("");
    setSaveError(null);
  }, [selectedPath]);

  const enterEditMode = useCallback(() => {
    setDraft(fileContent);
    setSaveError(null);
    setEditMode(true);
  }, [fileContent]);

  const exitEditMode = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setEditMode(false);
    setSaveError(null);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const ok = await writeProjectFile(selectedPath, draft);
      if (ok) setFileContent(draft);
      else setSaveError("Could not save this file.");
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "Could not save this file.");
    } finally {
      setSaving(false);
    }
  }, [selectedPath, draft, saving]);

  const jsonStatus = useMemo<{ ok: boolean; message: string } | null>(() => {
    if (!editMode || !isJsonFile(selectedPath)) return null;
    try {
      JSON.parse(draft);
      return { ok: true, message: "Valid JSON" };
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : "Invalid JSON" };
    }
  }, [editMode, selectedPath, draft]);

  // Warn before the OS closes the standalone window with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

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

  const sections = useMemo(() => {
    if (!selectedPath || !isPreviewableFile(selectedPath) || fileLoading || fileError || !fileContent) return [];
    return parseSections(fileContent, selectedPath);
  }, [selectedPath, fileContent, fileLoading, fileError]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectPath = useCallback((path: string) => {
    if (path === selectedPathRef.current) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setSelectedPath(path);
    const ancestors = findAncestorPaths(tree, path);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const entry of ancestors) next.add(entry);
      return next;
    });
  }, [tree, dirty]);

  return (
    <div
      className={`renderer-full-overlay${isWindow ? " renderer-full-overlay--window" : ""}`}
      onClick={(event) => { if (!isWindow && event.target === event.currentTarget) onClose(); }}
    >
      <div className={`renderer-full-panel${isWindow ? " renderer-full-panel--window" : ""}`} ref={panelRef}>
        <div className={`renderer-full-header${isWindow ? " renderer-full-header--drag" : ""}`}>
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
          <div className="renderer-full-header-controls">
            {!isWindow && onPopOut && (
              <button
                className="icon-btn renderer-full-popout"
                type="button"
                onClick={onPopOut}
                aria-label="Open in separate window"
                title="Open in separate window"
              >
                <ExternalLinkIcon size={13} />
              </button>
            )}
            <button className="icon-btn renderer-full-close" type="button" onClick={onClose} aria-label="Close" title={isWindow ? "Close window" : "Close (Esc)"}>
              <CloseIcon />
            </button>
          </div>
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

          {sections.length > 0 && !editMode && (
            <SectionIndex sections={sections} scrollRef={viewerScrollRef} isMd={!!selectedPath && selectedPath.toLowerCase().endsWith(".md")} />
          )}

          <section className="renderer-full-viewer">
            <div className="renderer-full-section-header renderer-full-section-header--viewer">
              <div className="renderer-full-section-main">
                <span className="renderer-full-section-title">{selectedPath ? selectedPath.split("/").pop() : "Preview"}</span>
                {selectedPath && <span className="renderer-full-section-subtle">{selectedPath}</span>}
              </div>
              <div className="renderer-full-viewer-actions">
                {editMode && jsonStatus && (
                  <span
                    className="renderer-full-json-status"
                    data-ok={jsonStatus.ok ? "" : undefined}
                    title={jsonStatus.message}
                  >
                    {jsonStatus.ok ? "Valid JSON" : "Invalid JSON"}
                  </span>
                )}
                {editMode && dirty && <span className="renderer-full-dirty-dot" title="Unsaved changes" aria-hidden="true" />}
                {selectedPath && isEditableFile(selectedPath) && !fileLoading && !fileError && (
                  <button
                    type="button"
                    className="renderer-full-action-btn"
                    onClick={editMode ? exitEditMode : enterEditMode}
                  >
                    {editMode ? "Preview" : "Edit"}
                  </button>
                )}
                {editMode && (
                  <button
                    type="button"
                    className="renderer-full-action-btn renderer-full-action-btn--primary"
                    onClick={() => void handleSave()}
                    disabled={!dirty || saving}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
                <span className="renderer-full-viewer-kind">{fileKindLabel(selectedPath)}</span>
              </div>
            </div>
            <div className="renderer-full-viewer-scroll" ref={viewerScrollRef}>
              {!selectedPath && <div className="renderer-full-placeholder">Select a file to preview it here.</div>}
              {selectedPath && !isPreviewableFile(selectedPath) && (
                <div className="renderer-full-placeholder">This workspace supports .md, .txt, and .json files.</div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && fileLoading && (
                <div className="renderer-full-placeholder">Loading {selectedPath.split("/").pop()}…</div>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && fileError && (
                <div className="renderer-full-placeholder">{fileError}</div>
              )}
              {selectedPath && isEditableFile(selectedPath) && !fileLoading && !fileError && editMode && (
                <>
                  <textarea
                    className="renderer-full-editor"
                    value={draft}
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                    aria-label={`Edit ${selectedPath.split("/").pop()}`}
                  />
                  {saveError && <div className="renderer-full-save-error">{saveError}</div>}
                </>
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && !fileError && !editMode && selectedPath.toLowerCase().endsWith(".md") && (
                <MarkdownPreview content={fileContent} scrollRef={viewerScrollRef} sections={sections} />
              )}
              {selectedPath && isPreviewableFile(selectedPath) && !fileLoading && !fileError && !editMode && !selectedPath.toLowerCase().endsWith(".md") && (
                <PlainTextPreview content={fileContent} scrollRef={viewerScrollRef} sections={sections} />
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