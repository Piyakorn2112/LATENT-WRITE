import type { LucideProps } from "lucide-react";
import {
  AlertTriangle as _AlertTriangle,
  ArrowDown as _ArrowDown,
  ArrowLeft as _ArrowLeft,
  ArrowRight as _ArrowRight,
  ArrowUp as _ArrowUp,
  BarChart2 as _BarChart2,
  BookOpen as _BookOpen,
  Brain as _Brain,
  Check as _Check,
  ChevronDown as _ChevronDown,
  ChevronLeft as _ChevronLeft,
  ChevronRight as _ChevronRight,
  ChevronUp as _ChevronUp,
  Clock as _Clock,
  Copy as _Copy,
  Download as _Download,
  Edit3 as _Edit3,
  ExternalLink as _ExternalLink,
  Eye as _Eye,
  EyeOff as _EyeOff,
  FileText as _FileText,
  Filter as _Filter,
  Flag as _Flag,
  FolderOpen as _FolderOpen,
  Globe as _Globe,
  Hash as _Hash,
  Heart as _Heart,
  HelpCircle as _HelpCircle,
  Image as _Image,
  Info as _Info,
  Layers as _Layers,
  Link as _Link,
  List as _List,
  MapPin as _MapPin,
  Maximize2 as _Maximize2,
  MessageSquare as _MessageSquare,
  Minus as _Minus,
  MoreHorizontal as _MoreHorizontal,
  PenTool as _PenTool,
  Plus as _Plus,
  RefreshCw as _RefreshCw,
  Search as _Search,
  Settings as _Settings,
  Shuffle as _Shuffle,
  Sparkles as _Sparkles,
  Star as _Star,
  Tag as _Tag,
  Target as _Target,
  Trash2 as _Trash2,
  TrendingDown as _TrendingDown,
  TrendingUp as _TrendingUp,
  Type as _Type,
  Upload as _Upload,
  User as _User,
  Users as _Users,
  Wand2 as _Wand2,
  X as _X,
  Zap as _Zap,
} from "lucide-react";

type P = Omit<LucideProps, "size"> & { size?: number };
const wrap = (Icon: React.FC<LucideProps>) =>
  ({ size = 18, ...p }: P) => <Icon size={size} strokeWidth={1.8} {...p} />;

export const AlertTriangle = wrap(_AlertTriangle);
export const ArrowDown = wrap(_ArrowDown);
export const ArrowLeft = wrap(_ArrowLeft);
export const ArrowRight = wrap(_ArrowRight);
export const ArrowUp = wrap(_ArrowUp);
export const BarChart2 = wrap(_BarChart2);
export const BookOpen = wrap(_BookOpen);
export const Brain = wrap(_Brain);
export const Check = wrap(_Check);
export const ChevronDown = wrap(_ChevronDown);
export const ChevronLeft = wrap(_ChevronLeft);
export const ChevronRight = wrap(_ChevronRight);
export const ChevronUp = wrap(_ChevronUp);
export const Clock = wrap(_Clock);
export const Copy = wrap(_Copy);
export const Download = wrap(_Download);
export const Edit3 = wrap(_Edit3);
export const ExternalLink = wrap(_ExternalLink);
export const Eye = wrap(_Eye);
export const EyeOff = wrap(_EyeOff);
export const FileText = wrap(_FileText);
export const Filter = wrap(_Filter);
export const Flag = wrap(_Flag);
export const FolderOpen = wrap(_FolderOpen);
export const Globe = wrap(_Globe);
export const Hash = wrap(_Hash);
export const Heart = wrap(_Heart);
export const HelpCircle = wrap(_HelpCircle);
export const Image = wrap(_Image);
export const Info = wrap(_Info);
export const Layers = wrap(_Layers);
export const Link = wrap(_Link);
export const List = wrap(_List);
export const MapPin = wrap(_MapPin);
export const Maximize2 = wrap(_Maximize2);
export const MessageSquare = wrap(_MessageSquare);
export const Minus = wrap(_Minus);
export const MoreHorizontal = wrap(_MoreHorizontal);
export const PenTool = wrap(_PenTool);
export const Plus = wrap(_Plus);
export const RefreshCw = wrap(_RefreshCw);
export const Search = wrap(_Search);
export const Settings = wrap(_Settings);
export const Shuffle = wrap(_Shuffle);
export const Sparkles = wrap(_Sparkles);
export const Star = wrap(_Star);
export const Tag = wrap(_Tag);
export const Target = wrap(_Target);
export const Trash2 = wrap(_Trash2);
export const TrendingDown = wrap(_TrendingDown);
export const TrendingUp = wrap(_TrendingUp);
export const Type = wrap(_Type);
export const Upload = wrap(_Upload);
export const User = wrap(_User);
export const Users = wrap(_Users);
export const Wand2 = wrap(_Wand2);
export const X = wrap(_X);
export const Zap = wrap(_Zap);
