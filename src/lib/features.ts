import type { Tier } from "./license";

export type FeatureKey =
  | "intel-auto"
  | "intel-manual"
  | "intel-off"
  | "renderer-workspace"
  | "custom-tools"
  | "story-nlp-control"
  | "split-view";

const FEATURE_TIERS: Record<FeatureKey, Tier> = {
  "intel-auto":         "free",
  "intel-manual":       "pro",
  "intel-off":          "free",
  "renderer-workspace": "pro",
  "custom-tools":       "pro",
  "story-nlp-control":  "pro",
  "split-view":         "free",
};

export function hasAccess(key: FeatureKey, tier: Tier): boolean {
  const required = FEATURE_TIERS[key];
  if (required === "free") return true;
  return tier === "pro";
}
