# Glass Editor — Pricing & License System Implementation Plan

> Status: PLAN ONLY — no code written yet.  
> Scope: Free / Pro tiers, local license codes, feature gating, Pro badge UI, Settings section, Onboarding integration.  
> Constraint: Offline-first, no backend, minimal touchpoints in existing files, isolated module design.

---

## 1. Product Summary

| Tier | Price | Key capabilities |
|------|-------|-----------------|
| **Free** | $0 | Editor · Auto intelligence mode · Basic analysis widgets · Timeline/graph (read-only) · PDF/MD/DOCX export |
| **Pro** | One-time | Everything in Free + Manual mode selection (Fast/Default/High/Off) · Renderer/Claude workspace · Custom tool plugins |

**Design rules:**
- Locked features are **visible** but dimmed; never hidden.
- Clicking a locked control shows a **small inline hint row** — no modal, no popover.
- Free feels **complete**, not crippled.
- The system must work **entirely offline** with no server round-trip.

---

## 2. Architecture Overview

```
src/lib/license.ts          ← NEW — isolated, zero React dependency
src/lib/features.ts         ← NEW — feature-key → tier access map
src/components/ProBadge.tsx ← NEW — reusable lock badge + inline hint

Existing files touched (minimal):
  src/components/AnalysisPanel.tsx  → SettingsPanel: intel grid gate + License section
  src/components/RendererPanel.tsx  → renderer gate when tier = free
  src/components/Onboarding.tsx     → "Activate Pro" entry on page 6 settings area
  src/App.tsx                       → load license on mount, pass tier prop downstream
```

Only `App.tsx` is the single source of tier truth. Everything else reads the tier via props.

---

## 3. New File: `src/lib/license.ts`

### 3.1 Types

```typescript
export type Tier = "free" | "pro";

export interface LicenseState {
  tier: Tier;
  code: string | null;           // raw code as entered
  activatedAt: number | null;    // Unix timestamp ms
  // Future fields (not used in v1, but reserved):
  // expiresAt?: number | null;
  // planId?: string;
}
```

### 3.2 Storage Key

```typescript
const LICENSE_KEY = "glass-editor:license-v1";
```

Stored in `localStorage` (same pattern as `preferences.ts` and `storage.ts`).
In Electron, `localStorage` persists per app origin — no Electron-specific file needed.

### 3.3 Code Format (v1)

```
LATENT-XXXXX-XXXXX-XXXXX
```

Where `X` is uppercase alphanumeric (A–Z, 0–9). Case-insensitive on input.

**Validation strategy (v1 — hash prefix):**
- Normalise the code: uppercase, strip non-alphanumeric except `-`.
- Compute `SHA-256(code + PRO_SALT)` where `PRO_SALT` is a 32-char hex constant embedded in the app source (not secret from determined users, but prevents trivial guessing).
- A valid Pro code produces a digest whose first 6 hex characters equal the fixed Pro prefix embedded in the file.
- **No network call.** Valid codes are pre-generated offline using the same formula (a small internal script).
- Result: `{ valid: boolean }`.

**Why this approach:**
- No RSA key ceremony needed for v1.
- The upgrade path to signed JWT / RSA is a one-line swap inside `validateCode(code)`.
- The SALT + prefix approach gives ~16-million-to-one false-positive rate before a determined attacker can enumerate.
- All checks are synchronous — no async validation spinner.

### 3.4 Exported Functions

```typescript
// Read current state. Falls back to free tier on any error.
export function loadLicense(): LicenseState

// Persist state to localStorage.
export function saveLicense(state: LicenseState): void

// Validate and activate a code. Returns { ok, error? }.
export function activateCode(code: string): { ok: boolean; error?: string }

// Remove Pro status, revert to free.
export function clearLicense(): void

// Convenience helper used in App.tsx and components.
export function currentTier(): Tier
```

### 3.5 Default State

```typescript
const FREE_STATE: LicenseState = { tier: "free", code: null, activatedAt: null };
```

Missing or malformed localStorage → `FREE_STATE`. Invalid code → `FREE_STATE`.

---

## 4. New File: `src/lib/features.ts`

### 4.1 Feature Keys

```typescript
export type FeatureKey =
  | "intel-auto"            // always available
  | "intel-manual"          // Pro — Fast / Default / High / Off
  | "intel-off"             // Pro (Off = disable analysis)
  | "renderer-workspace"    // Pro
  | "custom-tools"          // Pro
  | "story-nlp-control"     // Pro (toggle story NLP on/off)
  | "split-view";           // Pro (optional — can be free, decision left open)
```

### 4.2 Access Map

```typescript
const FEATURE_TIERS: Record<FeatureKey, Tier> = {
  "intel-auto":          "free",
  "intel-manual":        "pro",
  "intel-off":           "pro",
  "renderer-workspace":  "pro",
  "custom-tools":        "pro",
  "story-nlp-control":   "pro",
  "split-view":          "free",   // free for now; change here if needed
};

export function hasAccess(key: FeatureKey, tier: Tier): boolean {
  const required = FEATURE_TIERS[key];
  if (required === "free") return true;
  return tier === "pro";
}
```

Pure function — no React, no side effects. Easy to unit-test.

---

## 5. New File: `src/components/ProBadge.tsx`

### 5.1 The `<ProBadge />` Component

A small inline badge displayed next to locked control labels.

```
╔══════╗
║ PRO  ║   ← pill shape, ~30×16px
╚══════╝
```

**Visual spec (matching glass design language):**
- Background: `color-mix(in srgb, var(--panel-text) 10%, transparent)` — light white in dark mode, faint grey in light mode
- Border: `1px solid color-mix(in srgb, var(--panel-text) 16%, transparent)`
- Border-radius: `4px`
- Text: `"PRO"`, uppercase, 9px, letter-spacing: 0.06em, `color: color-mix(in srgb, var(--panel-text) 55%, transparent)`, weight 600
- Padding: `2px 5px`
- No backdrop-filter (too expensive for inline badges)
- CSS class: `.pro-badge`

**Design intent:** Deliberately quiet — uses the same `var(--panel-text)` color variable as all other glass-system secondary text. The badge reads clearly but never competes with content or feels like an advertisement. It is a label, not a CTA.

### 5.2 The `<LockedHint />` Sub-component

An inline collapsible hint row that appears directly below a locked control when clicked. One instance shown at a time (controlled by `AnalysisPanel`).

```
┌──────────────────────────────────────────────────────┐
│  ✦ Pro feature  ·  Enter your code in Settings → Account to unlock.  │
└──────────────────────────────────────────────────────┘
```

**Spec:**
- Appears with `opacity: 0 → 1` + `max-height: 0 → 32px` CSS transition
- Background: `color-mix(in srgb, var(--panel-text) 5%, transparent)` 
- Border-radius: `6px`, padding: `6px 10px`
- Font: 11px, `color: color-mix(in srgb, var(--panel-text) 60%, transparent)`
- Leading icon: a small lock SVG (inline, 10×12) from the existing `Icon.tsx` pattern
- CSS class: `.locked-hint`

### 5.3 Props Interface

```typescript
// ProBadge
interface ProBadgeProps { size?: "sm" | "xs"; }

// LockedHint
interface LockedHintProps {
  visible: boolean;
  message?: string; // default: "Enter your code in Settings → Account to unlock."
}
```

### 5.4 CSS additions (in `src/styles.css`)

Add ~30 lines before the "PDF export overlay" section:

```css
/* ── Pro badge ─────────────────────────── */
.pro-badge { ... }
.pro-badge--xs { font-size: 8px; padding: 1px 4px; }

/* ── Locked hint row ────────────────────── */
.locked-hint { ... }
.locked-hint--visible { opacity: 1; max-height: 40px; }
```

---

## 6. Existing File: `src/components/AnalysisPanel.tsx`

### 6.1 SettingsPanel Props — add `tier`

`SettingsPanel` receives a new `tier: Tier` prop (passed from the parent `AnalysisPanel`, which receives it from `App.tsx`).

**Change to `SettingsProps` interface:**
```typescript
interface SettingsProps {
  tier: Tier;  // ← ADD
  intelMode: IntelMode;
  onSetIntelMode: (m: IntelMode) => void;
  // ... rest unchanged
}
```

This is the **only** change to the interface signature. No other SettingsPanel props change.

### 6.2 Intelligence Grid Gating (lines ~123–137 of current file)

Currently the grid renders all 5 modes as active buttons. With tier gating:

- **Auto**: always enabled (no badge).
- **Fast / Default / High / Off**: rendered with a `pro-badge` in the top-right corner of the button if `tier === "free"`. The button click is intercepted: instead of calling `onSetIntelMode(value)`, it toggles a small inline `LockedHint` row below the grid.

**Visual diff for a locked intel button:**

```
┌─────────────────────────┐
│  High              [PRO]│   ← badge top-right of the button
│  Max accuracy           │
└─────────────────────────┘
  ↓ (on click, free tier):
┌─────────────────────────────────────────────────────────────────┐
│  🔒 Pro feature  ·  Enter your code in Settings → Account to unlock. │
└─────────────────────────────────────────────────────────────────┘
```

Implementation: add `lockedHintFor` state (`IntelMode | null`) in `SettingsPanel`. Each locked button sets it; clicking elsewhere clears it.

**Key rule:** do NOT remove the locked buttons. Do NOT disable them visually with `disabled` attribute. Just reduce opacity to `0.6` and overlay the badge.

### 6.3 New "Account" Section in SettingsPanel

Add a new `settings-section-label` section **at the bottom of SettingsPanel**, before the hint footer:

```
─── Account ──────────────────────────────────────

  [Pro active]  ←  shown when tier = "pro"
  Code: LATENT-XXXXX-XXXXX-XXXXX    [Remove]

  — or (when tier = "free") —

  ┌──────────────────────────────────┐  [Activate]
  │  Enter your Pro license code…    │
  └──────────────────────────────────┘
  "One-time purchase. Works offline."
```

**Component logic:**
- State: `codeInput: string`, `codeError: string | null`, `codeSuccess: boolean`.
- On submit: calls `activateCode(codeInput)` from `license.ts`, then calls a new `onTierChange(tier)` callback prop (added to `SettingsPanel`).
- On remove: calls `clearLicense()`, then `onTierChange("free")`.
- Input styling: matches existing `settings-section-label` + `settings-hint` visual pattern. Use a plain `<input type="text">` with class `settings-code-input` — same glass border treatment as other settings controls.
- The input row height is ~36px, unobtrusive.

**New `SettingsProps` callback:**
```typescript
onTierChange: (tier: Tier) => void;   // ← ADD — propagates to App.tsx
```

### 6.4 AnalysisPanel Props — add `tier` + `onTierChange`

Add to the existing `Props` interface in `AnalysisPanel.tsx`:

```typescript
tier: Tier;                      // ← ADD
onTierChange: (t: Tier) => void; // ← ADD
```

Pass both down into `SettingsPanel`.

**Lines to change:** the `Props` interface definition (~line 56–87) and the destructuring in `AnalysisPanel` (~line 503). 2–3 lines each.

---

## 7. Existing File: `src/components/RendererPanel.tsx`

### 7.1 Props — add `tier`

```typescript
tier?: Tier;  // ← ADD, default "free" for safety
```

### 7.2 Gate Location

Currently `RendererPanel` renders different content based on `browserBlocked` (line ~706: `const browserBlocked = !desktop`). The tier check sits alongside this — not replacing it, but adding a second dimension.

**Decision table:**

| `desktop` | `tier` | Result |
|-----------|--------|--------|
| false     | any    | blocked (existing) |
| true      | free   | **show Pro lock screen** |
| true      | pro    | full renderer (existing) |

### 7.3 Pro Lock Screen for Renderer

When `desktop && tier === "free"`, render a **calm informational surface** instead of the renderer. This replaces the current `browserBlocked` surface for this case.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   [renderer-logo.svg]                                            │
│                                                                  │
│   Renderer workspace                                             │
│   ──────────────────────────────                                 │
│   Write, draft, and review with Claude — from inside the editor. │
│                                                                  │
│   Available in Glass Editor Pro.                                 │
│                                                                  │
│   ┌───────────────────────────────┐                              │
│   │  Enter your Pro code          │  ← inline code entry        │
│   └───────────────────────────────┘                              │
│   [Activate]                                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

This surface:
- Uses the existing `.settings-panel liquid-glass` class for consistent glass appearance.
- Shows the renderer logo (already imported as `rendererLogoUrl`).
- Contains a minimal inline code entry (same logic as Settings → Account).
- Does not say "upgrade" or "buy" — just "activate your Pro code".
- CSS class: `.renderer-pro-gate`

**Implementation note:** The inline code entry in the renderer gate calls the same `activateCode()` from `license.ts` and then calls `onTierChange` callback — meaning the gate disappears instantly when a valid code is entered.

---

## 8. Existing File: `src/components/Onboarding.tsx`

### 8.1 Location

Page 6 of the onboarding (the "Get started" / checklist page, currently the last page) already has a checklist. The license entry goes in a **collapsed expandable row** below the checklist, not on its own page.

It is an **optional** element — users who don't have a Pro code skip right past it.

```
Checklist items (existing)
────────────────────────────────────────────────────────
  [ Have a Pro code? ]  ← collapsible row (chevron)
  ↓ (expanded):
  ┌──────────────────────────────────────┐  [Activate]
  │  Enter your Pro code…                │
  └──────────────────────────────────────┘
  "Unlocks manual mode selection and the Renderer workspace."
```

This is collapsed by default so it does not distract first-time users. The chevron is a single `ChevronRight` icon from existing `Icon.tsx`.

### 8.2 Props Change

`Onboarding` already knows about `!!window.electronAPI` (existing isElectron check). The onboarding gets a new optional callback:

```typescript
onTierChange?: (tier: Tier) => void;  // ← ADD (optional, ignored if not passed)
```

Pass this from `App.tsx` where `Onboarding` is rendered (line ~1141 area, near `setPrefs hasSeenOnboarding`).

### 8.3 App.tsx Change

In `App.tsx`, the `<Onboarding>` usage gains one prop:

```tsx
<Onboarding
  ...existing props...
  onTierChange={(t) => setTier(t)}   // ← ADD
/>
```

---

## 9. Existing File: `src/App.tsx`

### 9.1 License State on Mount

```typescript
// Near line 309, after loadPrefs():
const [tier, setTier] = useState<Tier>(() => loadLicense().tier);
```

`loadLicense()` is synchronous, safe for `useState` initializer.

### 9.2 Tier Change Handler

```typescript
const handleTierChange = useCallback((t: Tier) => {
  setTier(t);
}, []);
```

### 9.3 cycleIntel Guard (line ~482)

```typescript
const cycleIntel = useCallback(() => {
  setIntelMode((m) => {
    if (tier === "free") return "auto"; // free tier: always snap back to auto
    const order = ["auto", "default", "high", "fast", "off"] as const;
    return order[(order.indexOf(m) + 1) % order.length];
  });
}, [tier]);  // add tier to dep array
```

This means the toolbar orb cycle button also respects the tier. Free users who click it stay on "auto".

### 9.4 Props Threading

Add `tier` and `onTierChange` to:
- `<AnalysisPanel tier={tier} onTierChange={handleTierChange} ...>` (~line 1572 area)
- `<RendererPanel tier={tier} onTierChange={handleTierChange} ...>` (inside AnalysisPanel's render — RendererPanel is nested inside AnalysisPanel, ~line 924 area)
- `<Onboarding onTierChange={handleTierChange} ...>` (~line 1141 area)

**Net new lines in App.tsx: ~6 lines.**

---

## 10. Pro Badge Visual Specification (Detailed)

### Badge Sizes

| Size | CSS class | Font | Padding | Use case |
|------|-----------|------|---------|----------|
| Default | `.pro-badge` | 9px | 2px 5px | Intel grid buttons |
| XS | `.pro-badge--xs` | 8px | 1px 4px | Inline settings rows |

### Colors

The badge uses `var(--panel-text)` (the existing glass design-system variable) so it automatically adapts to dark and light mode without any `@media` query.

- **Dark mode:** `--panel-text` resolves to near-white → badge reads as a subtle frosted-white capsule
- **Light mode:** `--panel-text` resolves to near-black → badge reads as a quiet grey capsule

```css
.pro-badge {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--panel-text) 55%, transparent);
  background: color-mix(in srgb, var(--panel-text) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--panel-text) 16%, transparent);
  border-radius: 4px;
  padding: 2px 5px;
  line-height: 1;
  user-select: none;
  pointer-events: none; /* badge itself is non-clickable; parent handles click */
}
```

### Intel Button Lock State

```css
/* Applied when tier === "free" and mode !== "auto" */
.settings-intel-btn--locked {
  opacity: 0.62;
  cursor: default;
  position: relative;
}

.settings-intel-btn--locked .pro-badge {
  position: absolute;
  top: 5px;
  right: 5px;
}
```

### Renderer Pro Gate

```css
.renderer-pro-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 24px;
  text-align: center;
  height: 100%;
}

.renderer-pro-gate-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--panel-text);
}

.renderer-pro-gate-desc {
  font-size: 12px;
  color: color-mix(in srgb, var(--panel-text) 60%, transparent);
  line-height: 1.5;
  max-width: 220px;
}
```

---

## 11. License Validation — Implementation Detail

### Code Generation (offline CLI — not shipped in the app)

**File:** `scripts/generate-license-code.mjs`  
**Run:** `node scripts/generate-license-code.mjs [--count N] [--salt YOUR_SALT]`  
**Requires:** Node.js 18+ (built-in `crypto` only — zero npm dependencies)

```javascript
#!/usr/bin/env node
/**
 * Latent Write — Pro license code generator
 *
 * Usage:
 *   node scripts/generate-license-code.mjs
 *   node scripts/generate-license-code.mjs --count 10
 *   node scripts/generate-license-code.mjs --count 5 --salt <your-salt>
 *   node scripts/generate-license-code.mjs --help
 *
 * The salt MUST match VITE_PRO_SALT in your .env.local (and therefore in the
 * built app). Keep it secret; do not commit it.
 *
 * Output: one valid LATENT-XXXXX-XXXXX-XXXXX code per line, written to stdout.
 * Pipe to a file:  node scripts/generate-license-code.mjs --count 50 > codes.txt
 */

import { createHmac, randomBytes } from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: node scripts/generate-license-code.mjs [options]

Options:
  --count  N      Number of codes to generate (default: 1)
  --salt   S      HMAC salt (overrides LW_PRO_SALT env var)
  --prefix P      Required digest prefix (default: "pro1", overrides LW_PRO_PREFIX)
  --help          Print this message

Environment variables (fallbacks when flags are omitted):
  LW_PRO_SALT     Required — must match VITE_PRO_SALT in the app build
  LW_PRO_PREFIX   Optional — default "pro1"

Example:
  LW_PRO_SALT=abc123 node scripts/generate-license-code.mjs --count 20
`);
}

function parseArgs(argv) {
  const args = { count: 1, salt: null, prefix: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { printHelp(); process.exit(0); }
    if (argv[i] === '--count' && argv[i + 1]) { args.count = parseInt(argv[++i], 10); }
    if (argv[i] === '--salt'  && argv[i + 1]) { args.salt  = argv[++i]; }
    if (argv[i] === '--prefix' && argv[i + 1]) { args.prefix = argv[++i]; }
  }
  return args;
}

/** Generate a random uppercase alphanumeric string of `len` characters. */
function randomSegment(len) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const buf = randomBytes(len * 2); // generous buffer; we'll slice to len
  let result = '';
  for (let i = 0; i < buf.length && result.length < len; i++) {
    const idx = buf[i] % CHARS.length;
    result += CHARS[idx];
  }
  return result;
}

/** Build a LATENT-XXXXX-XXXXX-XXXXX candidate code. */
function buildCandidate() {
  return `LATENT-${randomSegment(5)}-${randomSegment(5)}-${randomSegment(5)}`;
}

/**
 * Return true if the HMAC-SHA256 digest of `code` starts with `prefix`.
 * This is the same check performed inside the app's license.ts.
 */
function isValid(code, salt, prefix) {
  const digest = createHmac('sha256', salt).update(code).digest('hex');
  return digest.startsWith(prefix);
}

/**
 * Generate one valid Pro code by trial-and-error.
 * On average: 16^len(prefix) attempts (16^4 = 65536 for "pro1" — fast).
 */
function generateOne(salt, prefix) {
  for (let attempts = 0; attempts < 2_000_000; attempts++) {
    const code = buildCandidate();
    if (isValid(code, salt, prefix)) return code;
  }
  throw new Error('Failed to generate a valid code after 2,000,000 attempts. Check your prefix length.');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const salt   = args.salt   ?? process.env.LW_PRO_SALT   ?? '';
const prefix = args.prefix ?? process.env.LW_PRO_PREFIX ?? 'pro1';

if (!salt) {
  console.error('Error: salt is required. Pass --salt <value> or set LW_PRO_SALT env var.');
  console.error('       The salt must match VITE_PRO_SALT in your app .env.local');
  process.exit(1);
}

if (isNaN(args.count) || args.count < 1 || args.count > 10_000) {
  console.error('Error: --count must be a number between 1 and 10,000.');
  process.exit(1);
}

const generated = new Set(); // deduplicate across the batch

for (let i = 0; i < args.count; i++) {
  let code;
  let dedupeAttempts = 0;
  do {
    code = generateOne(salt, prefix);
    dedupeAttempts++;
    if (dedupeAttempts > 100) throw new Error('Deduplication loop exceeded 100 tries — very unlikely, check inputs.');
  } while (generated.has(code));
  generated.add(code);
  console.log(code);
}
```

**Usage examples:**

```bash
# Single code (salt from env var):
LW_PRO_SALT=my-secret-salt node scripts/generate-license-code.mjs

# 20 codes written to a file:
LW_PRO_SALT=my-secret-salt node scripts/generate-license-code.mjs --count 20 > new-codes.txt

# Inline salt, custom prefix:
node scripts/generate-license-code.mjs --count 5 --salt my-secret-salt --prefix pro1
```

**Verification (spot-check a code without the app):**

```bash
# Quick one-liner to verify a code manually:
node -e "
  const { createHmac } = require('node:crypto');
  const code  = process.argv[1];
  const salt  = process.env.LW_PRO_SALT;
  const prefix = process.env.LW_PRO_PREFIX ?? 'pro1';
  const digest = createHmac('sha256', salt).update(code).digest('hex');
  console.log(digest.startsWith(prefix) ? 'VALID ✓' : 'INVALID ✗', digest.slice(0, 10));
" LATENT-ABCDE-FGHIJ-KLMNO
```

This is a ~90-line offline script. The `LW_PRO_SALT` value must match `VITE_PRO_SALT` in `.env.local` exactly — same bytes, same casing. Never commit the salt to version control.

### Validation in `license.ts`

```typescript
// Embedded during build — injected via VITE_PRO_SALT env var at build time.
// Default: random long string (means no pre-built codes work; devs must set the var).
const PRO_SALT = import.meta.env.VITE_PRO_SALT ?? "dev-mode-salt-no-codes-will-work";
const PRO_DIGEST_PREFIX = import.meta.env.VITE_PRO_PREFIX ?? "pro1";

async function validateCode(raw: string): Promise<boolean> {
  const code = raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!code.startsWith('LATENT-')) return false; // fast-reject wrong format
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(PRO_SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(code));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  return hex.startsWith(PRO_DIGEST_PREFIX);
}
```

Note: `crypto.subtle` is available in both Electron renderer (Chromium) and modern browsers. This keeps `license.ts` pure TS with no `node:crypto` dependency — safe for both targets.

Because this is now async, `activateCode` becomes `async`. `App.tsx` calls it with `await` inside the `handleTierChange` flow.

---

## 12. File Change Summary

| File | Change type | Lines changed (est.) |
|------|-------------|----------------------|
| `scripts/generate-license-code.mjs` | **NEW** | ~90 |
| `src/lib/license.ts` | **NEW** | ~80 |
| `src/lib/features.ts` | **NEW** | ~30 |
| `src/components/ProBadge.tsx` | **NEW** | ~40 |
| `src/styles.css` | **ADD** ~30 lines | ~30 |
| `src/components/AnalysisPanel.tsx` | **EDIT** | ~35 |
| `src/components/RendererPanel.tsx` | **EDIT** | ~25 |
| `src/components/Onboarding.tsx` | **EDIT** | ~30 |
| `src/App.tsx` | **EDIT** | ~10 |

**Total new lines: ~280. Total changed lines: ~100.**  
No changes to: Editor, HighlightLayer, world-data, story-graph, timeline, worker, analysis pipeline, storage, pdf-export, text-export, project-manager, electron/main.cjs, electron/preload.

---

## 13. Build-time Secret Injection

Add to `vite.config.ts` (or `.env.local` which is already gitignored):

```
VITE_PRO_SALT=<32-char random hex>
VITE_PRO_PREFIX=pro1
```

- `.env.local` is gitignored by Vite by default.
- The Electron build reads `process.env` through `vite.config.ts` `define` injection.
- In dev mode without the env var, `PRO_SALT` defaults to `"dev-mode-salt-no-codes-will-work"` — meaning no real codes work in dev, which is intentional.

---

## 14. Upgrade Path (v2 — if needed later)

Swap the `validateCode()` body only:

1. Generate an RSA-2048 key pair.
2. Embed the public key PEM in `license.ts`.
3. Issue codes as base64(RSA-sign(JSON payload)) — payload includes `{ tier, issuedAt, expiresAt? }`.
4. `validateCode` verifies the signature and reads the payload.

The `LicenseState` schema already has `expiresAt` reserved. No other code changes required.

---

## 15. Implementation Order (for execution)

1. **`scripts/generate-license-code.mjs`** — CLI code generator (no dependencies, ~90 lines).
2. **`src/lib/license.ts`** — data model + storage + `activateCode`.
3. **`src/lib/features.ts`** — `hasAccess()` map.
4. **`src/components/ProBadge.tsx`** + CSS in `styles.css`.
5. **`src/App.tsx`** — `tier` state + `handleTierChange` + prop threading (~10 lines).
6. **`src/components/AnalysisPanel.tsx`** — `tier` prop + intel grid gating + Account section.
7. **`src/components/RendererPanel.tsx`** — `tier` prop + renderer gate surface.
8. **`src/components/Onboarding.tsx`** — collapsible Pro code entry on page 6.
9. **Set `.env.local`** — `VITE_PRO_SALT=<value>` (use `generate-license-code.mjs` to test round-trip).
10. **TypeScript check** — `npx tsc --noEmit`.

---

## 16. Acceptance Verification Checklist

- [ ] App boots in free mode with no license in localStorage
- [ ] Intel grid shows Auto enabled; Fast/Default/High/Off show `[PRO]` badge
- [ ] Clicking a locked intel button shows inline hint row (no modal)
- [ ] Renderer panel shows pro-gate surface when `tier === "free"` in Electron
- [ ] Entering a valid code in Settings → Account unlocks Pro immediately (no reload)
- [ ] Intel grid unlocks all 5 modes after activation
- [ ] Renderer panel unlocks after activation
- [ ] Removing the code reverts to free tier
- [ ] Entering an invalid code shows a brief error message, does not crash
- [ ] `localStorage["glass-editor:license-v1"]` persists across app restarts
- [ ] App works fully offline — no network requests from license module
- [ ] TypeScript build (`tsc --noEmit`) passes with zero errors
- [ ] No regressions to: editor, analysis, export, timeline, annotation, adaptive store

---

## 17. What This Plan Deliberately Does NOT Do

- No subscription billing or expiry enforcement in v1.
- No account system, login, or cloud sync.
- No separate free/pro app builds.
- No aggressive upgrade nags or interrupt dialogs.
- No changes to the editor, highlight layer, or analysis pipeline.
- No new Electron IPC channels (the renderer gate and settings entry work in the renderer process only).
- No backend endpoint of any kind.
