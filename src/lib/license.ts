/// <reference types="vite/client" />

export type Tier = "free" | "pro";

export interface LicenseState {
  tier: Tier;
  code: string | null;
  activatedAt: number | null;
  // expiresAt?: number | null; (reserved for v2 subscriptions)
}

const LICENSE_KEY = "glass-editor:license-v1";
const FREE_STATE: LicenseState = { tier: "free", code: null, activatedAt: null };

// Injected at build time via .env.local (VITE_PRO_SALT / VITE_PRO_PREFIX).
// The default values ensure no pre-built codes work in dev unless the env var is set.
const PRO_SALT = import.meta.env.VITE_PRO_SALT ?? "dev-mode-salt-no-codes-will-work";
const PRO_DIGEST_PREFIX = import.meta.env.VITE_PRO_PREFIX ?? "cafe";

async function validateCode(raw: string): Promise<boolean> {
  const code = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!code.startsWith("LATENT-")) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(PRO_SALT),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(code));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.startsWith(PRO_DIGEST_PREFIX);
}

export function loadLicense(): LicenseState {
  try {
    const raw = localStorage.getItem(LICENSE_KEY);
    if (!raw) return FREE_STATE;
    const parsed = JSON.parse(raw) as LicenseState;
    if (parsed.tier !== "free" && parsed.tier !== "pro") return FREE_STATE;
    return parsed;
  } catch {
    return FREE_STATE;
  }
}

export function saveLicense(state: LicenseState): void {
  try {
    localStorage.setItem(LICENSE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable in some sandboxed contexts; fail silently
  }
}

export async function activateCode(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "Enter your Pro code." };
  const valid = await validateCode(trimmed);
  if (!valid) return { ok: false, error: "Invalid code. Check and try again." };
  saveLicense({
    tier: "pro",
    code: trimmed.toUpperCase().replace(/[^A-Z0-9-]/g, ""),
    activatedAt: Date.now(),
  });
  return { ok: true };
}

export function clearLicense(): void {
  saveLicense(FREE_STATE);
}

export function currentTier(): Tier {
  return loadLicense().tier;
}
