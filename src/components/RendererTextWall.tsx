/**
 * Scaled-down canvas text wall — off-thread via Web Worker.
 *
 * The worker (renderer-text-wall-worker.ts) owns the OffscreenCanvas,
 * runs the Perlin/fillText loop at 3 fps, and sends back a transferred
 * ImageBitmap. The main thread does one drawImage call per frame.
 *
 * CSS changes vs. the previous version:
 *   • filter: blur(1px)  removed — eliminated a GPU blur compositor pass.
 *   • mask-image         removed — vertical fade is baked into canvas alpha
 *                                  by the worker; no second compositor pass.
 *   • opacity            removed — baked into worker draw alpha via prop.
 */
import { useEffect, useRef } from "react";

interface RendererTextWallProps {
  active?: boolean;
  fontScale?: number;
  height?: number;
  topOffset?: number;
  opacity?: number;
}

export function RendererTextWall({
  active = true,
  fontScale = 1,
  height = 500,
  topOffset = -20,
  opacity = 1,
}: RendererTextWallProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  // Mount / unmount: create worker, start rendering loop.
  // Intentionally omits active/fontScale/opacity from deps — those are
  // sent as "config" messages via the second effect below.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap   = wrapRef.current!;

    let w: Worker;
    try {
      w = new Worker(
        new URL("../lib/renderer-text-wall-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      return; // Worker init failed — canvas stays blank (CSS fallback visible).
    }
    workerRef.current = w;

    // Receive transferred ImageBitmap and paint it to the canvas.
    w.onmessage = (e: MessageEvent<{ type: string; bitmap: ImageBitmap }>) => {
      if (e.data.type !== "frame") return;
      const { bitmap } = e.data;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width  = bitmap.width;
        canvas.height = bitmap.height;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    };

    w.onerror = (err) => {
      console.error("[text-wall-worker] error:", err);
    };

    // Send initial dimensions and config.
    w.postMessage({
      type: "start",
      fontScale,
      opacity,
      active,
      cssW: wrap.clientWidth,
      cssH: wrap.clientHeight,
    });

    // Notify the worker whenever the wrapper div is resized.
    const ro = new ResizeObserver(([entry]) => {
      const { width, height: h } = entry.contentRect;
      w.postMessage({ type: "resize", cssW: width, cssH: h });
    });
    ro.observe(wrap);

    // Pause rendering while the tab is hidden.
    const handleVis = () => {
      const w2 = workerRef.current;
      if (w2) w2.postMessage({ type: "config", active: document.visibilityState !== "hidden" && active });
    };
    document.addEventListener("visibilitychange", handleVis);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", handleVis);
      w.postMessage({ type: "stop" });
      w.terminate();
      workerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate prop changes to the running worker.
  useEffect(() => {
    workerRef.current?.postMessage({ type: "config", active, fontScale, opacity });
  }, [active, fontScale, opacity]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: "inherit",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
        height,
        top: `${topOffset}px`,
        contain: "layout style paint",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
        aria-hidden="true"
      />
    </div>
  );
}
