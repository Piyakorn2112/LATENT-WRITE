import type { ReactNode } from "react";

interface Props {
  title: string;
  onClose?: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
}

export function ToolSidePanel({ title, toolbar, children }: Props) {
  return (
    <div className="settings-panel liquid-glass" data-liquid-glass-scroll-adaptive="panel">
      <div className="tool-side-panel">
        {title && (
          <div className="tool-side-panel-header">
            <p className="settings-section-label" style={{ margin: 0 }}>{title}</p>
            {toolbar && <div className="tool-side-panel-toolbar">{toolbar}</div>}
          </div>
        )}
        <div className="tool-side-panel-content">
          {children}
        </div>
      </div>
    </div>
  );
}
