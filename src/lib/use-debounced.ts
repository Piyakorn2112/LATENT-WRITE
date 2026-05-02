import { useEffect, useState } from "react";

/**
 * Returns a value that lags `value` by `delayMs` milliseconds. Useful for
 * gating expensive downstream renders behind a typing-pause: the live value
 * keeps flowing through the editor at full fidelity, but consumers that
 * subscribe to the debounced value only update once the user stops typing.
 *
 * The first render returns the initial value immediately (no startup delay).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs, debounced]);
  return debounced;
}
