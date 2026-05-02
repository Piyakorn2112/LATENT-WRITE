import { useMemo } from "react";

interface Props {
  content: string;
  /** Words written today, accumulated across all chapters. */
  todayWords?: number;
  /** Daily goal in words; 0 = no goal. */
  goal?: number;
}

const READING_WPM = 230;

export function WordCount({ content, todayWords, goal }: Props) {
  const stats = useMemo(() => {
    const trimmed = content.trim();
    const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
    const chars = content.length;
    const minutes = words / READING_WPM;
    let readTime: string;
    if (words === 0) readTime = "—";
    else if (minutes < 1) readTime = "<1 min";
    else readTime = `${Math.round(minutes)} min`;
    return { words, chars, readTime };
  }, [content]);

  const showGoal = goal && goal > 0 && todayWords != null;
  const goalPct = showGoal ? Math.min(100, Math.round((todayWords! / goal!) * 100)) : 0;
  const goalMet = showGoal && todayWords! >= goal!;

  return (
    <div className="word-count" aria-label="Document statistics">
      <span className="word-count-stat">
        <span className="word-count-num">{stats.words.toLocaleString()}</span>
        <span className="word-count-label">words</span>
      </span>
      <span className="word-count-divider" />
      <span className="word-count-stat">
        <span className="word-count-num">{stats.chars.toLocaleString()}</span>
        <span className="word-count-label">chars</span>
      </span>
      <span className="word-count-divider" />
      <span className="word-count-stat">
        <span className="word-count-num">{stats.readTime}</span>
        <span className="word-count-label">read</span>
      </span>
      {showGoal && (
        <>
          <span className="word-count-divider" />
          <span className={`word-count-goal ${goalMet ? "word-count-goal--met" : ""}`}>
            <span className="word-count-goal-bar" aria-hidden="true">
              <span className="word-count-goal-fill" style={{ width: `${goalPct}%` }} />
            </span>
            <span className="word-count-num">{(todayWords ?? 0).toLocaleString()}</span>
            <span className="word-count-label">/ {goal!.toLocaleString()} today</span>
          </span>
        </>
      )}
    </div>
  );
}
