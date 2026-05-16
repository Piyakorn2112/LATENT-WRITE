type PerfMeta = Record<string, unknown>;

function perfEnabled(): boolean {
  return (globalThis as { __GLASS_EDITOR_PERF__?: boolean }).__GLASS_EDITOR_PERF__ === true;
}

function formatMeta(meta?: PerfMeta): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

export function logPerfEvent(name: string, durationMs: number, thresholdMs = 4, meta?: PerfMeta): void {
  if (!perfEnabled() || durationMs < thresholdMs) return;
  console.debug(`[glass-perf] ${name} ${durationMs.toFixed(1)}ms${formatMeta(meta)}`);
}

export function measurePerfSync<T>(name: string, fn: () => T, thresholdMs = 4, meta?: PerfMeta): T {
  if (!perfEnabled() || typeof performance === "undefined") return fn();
  const startedAt = performance.now();
  const result = fn();
  logPerfEvent(name, performance.now() - startedAt, thresholdMs, meta);
  return result;
}