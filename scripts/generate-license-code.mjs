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
  --prefix P      Required digest prefix (default: "cafe", overrides LW_PRO_PREFIX)
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
    if (argv[i] === '--count'  && argv[i + 1]) { args.count  = parseInt(argv[++i], 10); }
    if (argv[i] === '--salt'   && argv[i + 1]) { args.salt   = argv[++i]; }
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
const prefix = args.prefix ?? process.env.LW_PRO_PREFIX ?? 'cafe';

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
