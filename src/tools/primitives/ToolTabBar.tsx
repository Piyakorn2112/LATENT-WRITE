interface TabDef<T extends string> {
  value: T;
  label: string;
  count?: number;
  status?: "ready" | "working" | "error";
}

interface Props<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
}

const STATUS_DOT_COLORS: Record<string, string> = {
  ready: "#34c759",
  working: "#5ab8e0",
  error: "#f43f5e",
};

export function ToolTabBar<T extends string>({ tabs, value, onChange }: Props<T>) {
  return (
    <div className="world-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={`world-tab ${value === tab.value ? "world-tab--active" : ""}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.status && (
            <span
              className="tool-tab-status-dot"
              style={{ background: STATUS_DOT_COLORS[tab.status] }}
              aria-hidden="true"
            />
          )}
          {tab.label}
          {tab.count != null && (
            <span className="world-tab-count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
