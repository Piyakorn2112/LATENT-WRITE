import { GlassToggle } from "../../components/GlassToggle";

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}

export function ToolToggle({ checked, onChange, label, description }: Props) {
  return (
    <div className="settings-toggle-row">
      <div className="settings-toggle-row-text">
        <span className="settings-toggle-row-title">{label}</span>
        {description && (
          <span className="settings-toggle-row-desc">{description}</span>
        )}
      </div>
      <GlassToggle checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}
