import { useCallback, useState } from "react";
import type { ReviewResult } from "../types";
import type { Preferences } from "../lib/preferences";
import { runRendererReview, REVIEW_MODELS, FLAG_COLORS } from "../lib/renderer-review";
import { runLocalReview, LOCAL_REVIEW_MODEL } from "../lib/local-review";
import { EyeIcon, EyeOffIcon, ExternalLinkIcon } from "./Icon";
import { RendererTextWall } from "./RendererTextWall";
import rendererLogoUrl from "../assets/renderer-logo.svg";

interface Props {
  chapterId: string | null;
  chapterContent: string | undefined;
  chapterTitle: string | undefined;
  reviewResult: ReviewResult | null;
  onReviewComplete: (result: ReviewResult) => void;
  prefs: Preferences;
  onSetPrefs: (next: Preferences) => void;
}

const FLAG_TYPE_LABELS: Record<string, string> = {
  "over-explanation":      "Over-explain",
  "ai-register":           "AI register",
  "acquisition-backstory": "Backstory",
  "belief-elaboration":    "Belief label",
  "crowd-quantification":  "Crowd count",
  "emotion-label":         "Emotion label",
  "annotation":            "Annotation",
  "nia":                   "NIA",
};

const ALL_MODELS = [LOCAL_REVIEW_MODEL, ...REVIEW_MODELS];

export function RendererPanel({
  chapterId, chapterContent, chapterTitle,
  reviewResult, onReviewComplete,
  prefs, onSetPrefs,
}: Props) {
  const [running, setRunning]   = useState(false);
  const [error,   setError]     = useState<string | null>(null);
  const [showKey, setShowKey]   = useState(false);

  const apiKey      = prefs.apiKey ?? "";
  const model       = prefs.reviewModel ?? LOCAL_REVIEW_MODEL.id;
  const isLocalMode = model === LOCAL_REVIEW_MODEL.id;
  const isElectron  = !!(window as Window & { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

  const handleRun = useCallback(async () => {
    if (!chapterId || !chapterContent?.trim() || running) return;
    if (!isLocalMode && !apiKey) return;
    setRunning(true);
    setError(null);
    try {
      let result: ReviewResult;
      if (isLocalMode) {
        result = await runLocalReview(chapterId, chapterContent);
      } else {
        result = await runRendererReview(chapterId, chapterContent, apiKey, model);
      }
      onReviewComplete(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [chapterId, chapterContent, apiKey, model, isLocalMode, running, onReviewComplete]);

  function openExternal(url: string) {
    const api = (window as Window & { electronAPI?: { shell?: { openExternal?: (u: string) => void } } }).electronAPI;
    if (api?.shell?.openExternal) api.shell.openExternal(url);
    else window.open(url, "_blank", "noopener");
  }

  const chapterMatchesResult = reviewResult?.chapterId === chapterId;
  const flags    = chapterMatchesResult ? reviewResult!.flags : [];
  const hasResult = chapterMatchesResult && reviewResult != null;
  const resultModelLabel = ALL_MODELS.find(m => m.id === reviewResult?.model)?.label ?? reviewResult?.model ?? "";
  const canRun = !!chapterId && !!chapterContent?.trim() && !running
    && (isLocalMode || (!!apiKey && isElectron));

  return (
    <div
      className="settings-panel liquid-glass"
      style={{ position: "relative", overflow: "hidden" }}
    >
        {/* Artistic text wall — full opacity, CSS mask fades it top-to-bottom */}
        <RendererTextWall />
      {/* Scrollable content — z-index above the canvas */}
      <div className="settings-panel-scroll" style={{ position: "relative", zIndex: 2 }}>

        {/* Real Renderer logo — dark mode handled via CSS filter */}
        <div className="rp-logo-wrap">
          <img src={rendererLogoUrl} alt="Renderer" className="rp-logo" />
        </div>

        {/* Model selection — Local NLM first, then API models */}
        <p className="settings-section-label">Mode</p>
        <div className="rp-model-pills">
          {ALL_MODELS.map(m => (
            <button
              key={m.id}
              className={`settings-pill${model === m.id ? " settings-pill--active" : ""}`}
              onClick={() => onSetPrefs({ ...prefs, reviewModel: m.id })}
              title={m.note}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="settings-hint" style={{ marginTop: 3 }}>
          {ALL_MODELS.find(m => m.id === model)?.note ?? ""}
        </p>

        {/* API key section — hidden in local mode */}
        {!isLocalMode && (
          <>
            {!isElectron && (
              <div className="rp-error" style={{ marginBottom: 4 }}>
                API mode requires the desktop app (Latent Write).
              </div>
            )}

            <p className="settings-section-label" style={{ marginTop: 8 }}>API Key</p>
            <div style={{ position: "relative" }}>
              <input
                className="rp-key-input"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={e => onSetPrefs({ ...prefs, apiKey: e.target.value })}
                placeholder="sk-ant-api03-…"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                onClick={() => setShowKey(v => !v)}
                style={{
                  position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--panel-text-3)", padding: 0, display: "flex", alignItems: "center",
                }}
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
              </button>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 5 }}>
              <button className="rp-link" onClick={() => openExternal("https://console.anthropic.com/settings/keys")}>
                <ExternalLinkIcon size={10} />
                Get API key
              </button>
              <span style={{ color: "var(--panel-text-4)", fontSize: 9 }}>·</span>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 9, color: "var(--panel-text-4)", lineHeight: 1.4 }}>
                Billed separately from Claude.ai
              </span>
            </div>
          </>
        )}

        {/* Run */}
        <button
          className={`rp-run-btn${running ? " rp-run-btn--running" : ""}`}
          onClick={handleRun}
          disabled={!canRun}
          style={{ marginTop: 10 }}
        >
          {running
            ? (isLocalMode ? "Scanning locally…" : "Reviewing…")
            : `Review${chapterTitle ? ` "${chapterTitle}"` : " chapter"}`}
        </button>

        {error && <div className="rp-error">{error}</div>}

        {/* Results */}
        {hasResult && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, marginBottom: 6 }}>
              <p className="settings-section-label" style={{ margin: 0 }}>
                {flags.length === 0 ? "Result" : `${flags.length} flag${flags.length !== 1 ? "s" : ""}`}
              </p>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 9, color: "var(--panel-text-4)", fontVariantNumeric: "tabular-nums" }}>
                {new Date(reviewResult!.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {" · "}{resultModelLabel}
              </span>
            </div>

            {flags.length === 0 ? (
              <div className="rp-clean">
                <span className="rp-clean-icon" style={{ color: "#10b981" }}>✓</span>
                <span className="rp-clean-text">No failure patterns found.</span>
              </div>
            ) : (
              <div className="rp-flags">
                {flags.map((flag, i) => {
                  const colors = FLAG_COLORS[flag.type] ?? { bg: "rgba(156,163,175,0.1)", text: "var(--panel-text-3)" };
                  const label  = FLAG_TYPE_LABELS[flag.type] ?? flag.type;
                  return (
                    <div key={i} className="rp-flag">
                      <span className="rp-flag-badge" style={{ background: colors.bg, color: colors.text }}>
                        {label}
                      </span>
                      {flag.quote && <p className="rp-flag-quote">"{flag.quote}"</p>}
                      <p className="rp-flag-fix">{flag.fix}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        <p className="settings-hint" style={{ marginTop: 14 }}>
          {isLocalMode
            ? "Checks 6 Renderer failure patterns locally using heuristics + semantic embedding."
            : "Checks over-explanation, AI register, backstory dumps, emotion labels, and more via Claude."}
        </p>

      </div>
    </div>
  );
}
