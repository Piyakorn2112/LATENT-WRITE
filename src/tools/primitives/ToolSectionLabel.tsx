interface Props {
  children: string;
}

export function ToolSectionLabel({ children }: Props) {
  return <p className="settings-section-label">{children}</p>;
}
