/**
 * ThinkingLabel — the playful rotating status word for reasoning phases,
 * shared by the ask and writing popovers. One whimsical gerund at a time,
 * cycling slowly (Claude Code's spinner vocabulary, tuned to a novelist's
 * desk); the random start keeps repeat runs from always opening on the
 * same word.
 *
 * CYCLE_MS is deliberately long. A think pass runs 12-30s, so ~5s a word
 * shows three to six words over a whole pass — the label reads as a settled
 * mood rather than a flicker, and each phrase gets long enough to be read.
 */
import { useEffect, useState } from "react";

const WORDS = [
  "Pondering…",
  "Mulling it over…",
  "Connecting threads…",
  "Reading between the lines…",
  "Chewing the pencil…",
  "Weighing the words…",
  "Plotting quietly…",
  "Squinting at the page…",
  "Following the thread…",
  "Turning it over…",
];

const CYCLE_MS = 5000;

export function ThinkingLabel() {
  const [i, setI] = useState(() => Math.floor(Math.random() * WORDS.length));
  useEffect(() => {
    const t = setInterval(() => setI((v) => v + 1), CYCLE_MS);
    return () => clearInterval(t);
  }, []);
  return <>{WORDS[i % WORDS.length]}</>;
}
