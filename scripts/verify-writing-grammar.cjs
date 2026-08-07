/**
 * verify-writing-grammar.cjs — the shipped writing-tool request must compile
 * through the SAME compact-grammar path the host uses.
 *
 * Negative control included: the OLD schema shape (batch-scaled maxLength)
 * must FAIL on the same path, or this gate proves nothing.
 *
 * Run: /opt/homebrew/bin/node scripts/verify-writing-grammar.cjs
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function main() {
  // The real module builds the request — a 785-char custom batch, the exact
  // size that produced the failing {0,2755} bound.
  const para = ('The harbour bell rang twice before anyone moved, and by then the tide had ' +
    'already taken the smaller boats out past the breakwater. ').repeat(6).slice(0, 785);
  const req = JSON.parse(execFileSync(NODE, [TSX, '-e', `
    import { buildWritingRequest } from "./src/lib/writing-tool";
    const req = buildWritingRequest("custom", { text: ${JSON.stringify(para)}, index: 0, sep: "" }, { before: "", revisedTail: "", instruction: "make it funny" });
    console.log(JSON.stringify({ schema: req.schema, maxTokens: req.maxTokens }));
  `], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());

  const nlc = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href
  );
  const gbnfMod = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', 'node-llama-cpp', 'dist', 'utils', 'gbnfJson', 'getGbnfGrammarForGbnfJsonSchema.js')).href
  );
  const build = gbnfMod.getGbnfGrammarForGbnfJsonSchema;
  const llama = await nlc.getLlama();

  // Negative control: the pre-fix shape must still fail here.
  const oldSchema = {
    type: 'object',
    properties: { text: { type: 'string', maxLength: Math.ceil(para.length * 3) + 400 } },
    required: ['text'],
  };
  let oldFailed = false;
  try {
    await llama.createGrammar({ grammar: build(oldSchema, { allowNewLines: false }) });
  } catch { oldFailed = true; }
  console.log('negative control (old maxLength schema):', oldFailed ? 'FAILS as expected' : 'PARSED — GATE IS BLIND');

  let newOk = false;
  try {
    await llama.createGrammar({ grammar: build(req.schema, { allowNewLines: false }) });
    newOk = true;
  } catch (err) { console.error(String(err)); }
  console.log('shipped request schema:', newOk ? 'PARSES' : 'STILL FAILS');
  console.log(newOk && oldFailed ? 'ALL GATES GREEN' : 'GATE FAILURE');
  process.exit(newOk && oldFailed ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
