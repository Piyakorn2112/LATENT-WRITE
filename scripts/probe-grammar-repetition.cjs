/**
 * probe-grammar-repetition.cjs — where llama.cpp's grammar parser draws the
 * "sane defaults" line for bounded repetitions.
 *
 * A JSON-schema `maxLength: N` compiles to `( char ){0,N}` in GBNF, and the
 * parser rejects N above an undocumented ceiling with:
 *   "number of repetitions exceeds sane defaults"
 * The writing tool scales maxLength with the batch (3x+400 for custom), so a
 * ~785-char paragraph produced {0,2755} and every host-path batch failed at
 * grammar parse before the model ran.
 *
 * This probe binary-searches the real ceiling on the shipped binary so the
 * fix's constant is measured, not guessed.
 *
 * Run: /opt/homebrew/bin/node scripts/probe-grammar-repetition.cjs
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function main() {
  const nlc = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href
  );
  const llama = await nlc.getLlama();

  const tryN = async (n) => {
    const g = [
      'root ::= "{" "\\"text\\"" ":" [ ]? str "}"',
      'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" ["\\\\/bfnrt]',
      `str ::= "\\"" ( char ){0,${n}} "\\""`,
    ].join('\n');
    try {
      await llama.createGrammar({ grammar: g });
      return true;
    } catch {
      return false;
    }
  };

  // Sanity anchors first, then binary search the boundary.
  console.log('  420  (largest fixed schema in the app):', await tryN(420) ? 'OK' : 'REJECTED');
  console.log(' 2755  (the failing writing-tool bound):', await tryN(2755) ? 'OK' : 'REJECTED');

  let lo = 1, hi = 8192;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2) - 1;
    if (await tryN(mid)) lo = mid; else hi = mid - 1;
    if (lo === hi) break;
    if (hi - lo <= 1) { if (await tryN(hi)) lo = hi; else hi = lo; }
  }
  console.log(`CEILING: {0,${lo}} parses, {0,${lo + 1}} is rejected`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
