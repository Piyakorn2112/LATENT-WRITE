// Thin wrappers around lucide-react — keeps existing imports working
// while using real lucide icons throughout.
import type { LucideProps } from "lucide-react";
import {
  ChevronLeft as _CL,
  ChevronRight as _CR,
  List as _Li,
  Plus as _Pl,
  Download as _Dl,
  Upload as _Ul,
  Trash2 as _Tr,
  X as _X,
  BookOpen as _BO,
  Brain as _Br,
  Settings as _St,
  Sparkles as _Sp,
  Users as _Us,
  MapPin as _Mp,
  Flag as _Fl,
  User as _Un,
  FileText as _Ft,
  Minus as _Mn,
  Image as _Im,
  Type as _Ty,
  Frame as _Fr,
  Pilcrow as _Pi,
  Highlighter as _Hi,
  Layers as _Ly,
  Wand2 as _W2,
  ExternalLink as _El,
  Maximize2 as _Mx,
  Eye as _Ey,
  EyeOff as _Eo,
  FolderOpen as _Fo,
  ArrowUp as _Au,
  Target as _Tg,
  Search as _Se,
  Clock as _Ck,
  AlertTriangle as _AT,
  Hash as _Ha,
  Tag as _Ta,
  Zap as _Zp,
  BarChart2 as _BC,
  Globe as _Gl,
  Heart as _Ht,
  Star as _Sr,
  Filter as _Fi,
  Link as _Lk,
  Puzzle as _Pz,
} from "lucide-react";

type P = Omit<LucideProps, "size"> & { size?: number };
const wrap = (Icon: React.FC<LucideProps>) =>
  ({ size = 18, ...p }: P) => <Icon size={size} strokeWidth={1.8} {...p} />;

export const ChevronLeft   = wrap(_CL);
export const ChevronRight  = wrap(_CR);
export const ListIcon      = wrap(_Li);
export const PlusIcon      = wrap(_Pl);
export const DownloadIcon  = wrap(_Dl);
export const UploadIcon    = wrap(_Ul);
export const TrashIcon     = wrap(_Tr);
export const CloseIcon     = wrap(_X);
export const BookOpenIcon  = wrap(_BO);
export const BrainIcon     = wrap(_Br);
export const SettingsIcon  = wrap(_St);
export const SparklesIcon  = wrap(_Sp);
export const UsersIcon     = wrap(_Us);
export const MapPinIcon    = wrap(_Mp);
export const FlagIcon      = wrap(_Fl);
export const UserIcon      = wrap(_Un);
export const FileTextIcon  = wrap(_Ft);
export const MinusIcon     = wrap(_Mn);
export const ImageIcon     = wrap(_Im);
export const TypeIcon      = wrap(_Ty);
export const FrameIcon     = wrap(_Fr);
export const PilcrowIcon       = wrap(_Pi);
export const AnnotateIcon      = wrap(_Hi);
export const LayersIcon        = wrap(_Ly);
export const Wand2Icon         = wrap(_W2);
export const ExternalLinkIcon  = wrap(_El);
export const Maximize2Icon     = wrap(_Mx);
export const EyeIcon           = wrap(_Ey);
export const EyeOffIcon        = wrap(_Eo);
export const FolderIcon        = wrap(_Fo);
export const ArrowUpIcon       = wrap(_Au);
export const TargetIcon        = wrap(_Tg);
export const SearchIcon        = wrap(_Se);
export const ClockIcon         = wrap(_Ck);
export const AlertTriangleIcon = wrap(_AT);
export const HashIcon          = wrap(_Ha);
export const TagIcon           = wrap(_Ta);
export const ZapIcon           = wrap(_Zp);
export const BarChart2Icon     = wrap(_BC);
export const GlobeIcon         = wrap(_Gl);
export const HeartIcon         = wrap(_Ht);
export const StarIcon          = wrap(_Sr);
export const FilterIcon        = wrap(_Fi);
export const LinkIcon          = wrap(_Lk);
export const PuzzleIcon        = wrap(_Pz);

const TOOL_ICON_MAP: Record<string, React.FC<P>> = {
  Target: TargetIcon, Search: SearchIcon, BookOpen: BookOpenIcon,
  Brain: BrainIcon, Clock: ClockIcon, AlertTriangle: AlertTriangleIcon,
  Hash: HashIcon, Tag: TagIcon, Zap: ZapIcon, BarChart2: BarChart2Icon,
  Globe: GlobeIcon, Heart: HeartIcon, Star: StarIcon, Filter: FilterIcon,
  Link: LinkIcon, Flag: FlagIcon, Eye: EyeIcon, Users: UsersIcon,
  MapPin: MapPinIcon, Sparkles: SparklesIcon, FileText: FileTextIcon,
  Layers: LayersIcon, Wand2: Wand2Icon, Settings: SettingsIcon,
  User: UserIcon, Image: ImageIcon, List: ListIcon,
};

export function resolveToolIcon(name: string): React.FC<P> {
  return TOOL_ICON_MAP[name] ?? PuzzleIcon;
}
