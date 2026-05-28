import { Lock } from "lucide-react";

interface ProBadgeProps {
  size?: "sm" | "xs";
}

export function ProBadge({ size }: ProBadgeProps) {
  return (
    <span className={`pro-badge${size === "xs" ? " pro-badge--xs" : ""}`}>PRO</span>
  );
}

interface LockedHintProps {
  visible: boolean;
  message?: string;
}

export function LockedHint({ visible, message }: LockedHintProps) {
  return (
    <div className={`locked-hint${visible ? " locked-hint--visible" : ""}`} aria-hidden={!visible}>
      <Lock className="locked-hint-icon" size={12} aria-hidden={true} />
      {message ?? "Enter your code in Settings → Account to unlock."}
    </div>
  );
}
