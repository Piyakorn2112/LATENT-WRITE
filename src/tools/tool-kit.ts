// Tool SDK barrel — the single import surface for custom tool widgets.
// Tools import as: import { ToolCard, ToolButton, ... } from "glass-editor/tool-kit";

// Command dispatch — lets widget buttons trigger slash commands in the renderer chat.
export function runCommand(command: string): void {
  window.dispatchEvent(new CustomEvent("tool-run-command", { detail: { command } }));
}

// Layout
export { ToolCard } from "./primitives/ToolCard";
export { ToolOverlay } from "./primitives/ToolOverlay";
export { ToolSidePanel } from "./primitives/ToolSidePanel";

// Controls
export { ToolButton } from "./primitives/ToolButton";
export { ToolToggle } from "./primitives/ToolToggle";
export { ToolRange } from "./primitives/ToolRange";
export { ToolPillGroup } from "./primitives/ToolPillGroup";
export { ToolTabBar } from "./primitives/ToolTabBar";
export { ToolSectionLabel } from "./primitives/ToolSectionLabel";

// Data display
export { ToolBadge } from "./primitives/ToolBadge";
export { ToolDataRow } from "./primitives/ToolDataRow";
export { ToolDataTable } from "./primitives/ToolDataTable";

// Charts
export { ToolSparkline } from "./primitives/ToolSparkline";
export { ToolProgressRing } from "./primitives/ToolProgressRing";
export { ToolDialRing } from "./primitives/ToolDialRing";
export { ToolArcRing } from "./primitives/ToolArcRing";
export { ToolHeatmap } from "./primitives/ToolHeatmap";

// Icons (curated subset of lucide-react)
export {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  BarChart2, BookOpen, Brain, Check, ChevronDown, ChevronLeft,
  ChevronRight, ChevronUp, Clock, Copy, Download, Edit3,
  ExternalLink, Eye, EyeOff, FileText, Filter, Flag, FolderOpen,
  Globe, Hash, Heart, HelpCircle, Image, Info, Layers, Link,
  List, MapPin, Maximize2, MessageSquare, Minus, MoreHorizontal,
  PenTool, Plus, RefreshCw, Search, Settings, Shuffle, Sparkles,
  Star, Tag, Target, Trash2, TrendingDown, TrendingUp, Type,
  Upload, User, Users, Wand2, X, Zap,
} from "./primitives/ToolIcons";
