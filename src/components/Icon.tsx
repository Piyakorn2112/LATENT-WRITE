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
export const PilcrowIcon   = wrap(_Pi);
export const AnnotateIcon  = wrap(_Hi);
