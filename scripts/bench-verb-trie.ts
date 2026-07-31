/**
 * bench-verb-trie.ts — prove the trie alternation accepts exactly the same
 * language as the flat one, then measure what it bought.
 *
 * A faster regex that quietly matches a different set of strings would be a
 * silent accuracy regression, and the shape of it — one word in 130 dropping
 * out — is exactly the kind that no fixture would catch. So equivalence is
 * VERIFIED on real text rather than argued: both forms are run with the `g` flag
 * over every paragraph of every book in the corpus and their match sequences are
 * compared position by position, not merely counted.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";

const SPEECH_VERBS = [
  'said','says','say','asked','ask','replied','reply','answered','answer',
  'whispered','whisper','called','call','continued','continue','added','add',
  'began','begin','insisted','insist','murmured','murmur','told','tell',
  'shouted','shout','noted','note','observed','observe','thought','think',
  'wondered','wonder','admitted','admit','agreed','agree','announced','announce',
  'demanded','demand','exclaimed','exclaim','explained','explain','gasped','gasp',
  'laughed','laugh','muttered','mutter','offered','offer','ordered','order',
  'promised','promise','repeated','repeat','sighed','sigh','snapped','snap',
  'spoke','speak','stated','state','suggested','suggest','urged','urge',
  'warned','warn','breathed','breathe','hissed','hiss','cried','cry',
  'interrupted','interrupt','responded','respond','called','yelled','yell',
  'growled','growl','scoffed','scoff','pleaded','plead','conceded','concede',
  'declared','declare','groaned','groan','whimpered','whimper','stammered','stammer',
  'stuttered','stutter','bellowed','bellow','chanted','chant','recited','recite',
  'remarked','remark','quipped','quip','taunted','taunt','teased','tease',
  'countered','counter','interjected','interject','protested','protest',
  'mumbled','mumble','rasped','rasp','croaked','croak','blurted','blurt',
];

function buildTriePattern(words: readonly string[]): string {
  interface Node { children: Map<string, Node>; terminal: boolean }
  const root: Node = { children: new Map(), terminal: false };
  for (const w of words) {
    let node = root;
    for (const ch of w) {
      let next = node.children.get(ch);
      if (!next) { next = { children: new Map(), terminal: false }; node.children.set(ch, next); }
      node = next;
    }
    node.terminal = true;
  }
  const escChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  function render(node: Node): string {
    if (node.children.size === 0) return '';
    const branches: string[] = [];
    const leafChars: string[] = [];
    for (const [ch, child] of node.children) {
      if (child.children.size === 0 && child.terminal) leafChars.push(ch);
      else branches.push(escChar(ch) + render(child));
    }
    if (leafChars.length === 1) branches.push(escChar(leafChars[0]));
    else if (leafChars.length > 1) branches.push(`[${leafChars.map(escChar).join('')}]`);
    const body = branches.length === 1 ? branches[0] : `(?:${branches.join('|')})`;
    return node.terminal ? `(?:${body})?` : body;
  }
  return `(?:${render(root)})`;
}

const FLAT = `(?:${SPEECH_VERBS.join('|')})`;
const TRIE = buildTriePattern(SPEECH_VERBS);

async function main() {
  console.log(`\nflat pattern: ${FLAT.length} chars`);
  console.log(`trie pattern: ${TRIE.length} chars\n`);

  // ── 1. Every verb must still be accepted, and near-misses still rejected ──
  const flatOne = new RegExp(`^${FLAT}$`, 'i');
  const trieOne = new RegExp(`^${TRIE}$`, 'i');
  let unit = 0;
  for (const v of SPEECH_VERBS) {
    if (!trieOne.test(v)) { console.log(`  ✗ trie REJECTS a verb: ${v}`); unit++; }
  }
  for (const bad of ['sai', 'saidx', 'as', 'askedd', '', 'speaks', 'tolds', 'xsaid']) {
    if (flatOne.test(bad) !== trieOne.test(bad)) { console.log(`  ✗ disagree on "${bad}"`); unit++; }
  }
  console.log(`  unit checks: ${unit === 0 ? "all pass" : `${unit} FAILURES`}`);

  // ── 2. Identical match SEQUENCES over the whole corpus ───────────────────
  const flatG = new RegExp(`\\b${FLAT}\\b`, 'gi');
  const trieG = new RegExp(`\\b${TRIE}\\b`, 'gi');
  let paras = 0, matches = 0, mismatches = 0;
  let flatMs = 0, trieMs = 0;

  for (const key of [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)]) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    for (const chapter of novel.chapters) {
      for (const p of splitParagraphs(chapter.content)) {
        paras++;
        flatG.lastIndex = 0; trieG.lastIndex = 0;
        const a: Array<[number, string]> = [];
        const b: Array<[number, string]> = [];
        let m: RegExpExecArray | null;
        const t0 = performance.now();
        while ((m = flatG.exec(p))) a.push([m.index, m[0]]);
        flatMs += performance.now() - t0;
        const t1 = performance.now();
        while ((m = trieG.exec(p))) b.push([m.index, m[0]]);
        trieMs += performance.now() - t1;
        matches += a.length;
        if (a.length !== b.length || a.some((x, i) => x[0] !== b[i][0] || x[1] !== b[i][1])) {
          if (mismatches < 5) console.log(`  ✗ MISMATCH in ${key}: ${p.slice(0, 90)}`);
          mismatches++;
        }
      }
    }
  }

  console.log(`\n  corpus: ${paras} paragraphs, ${matches} verb matches`);
  console.log(`  sequence mismatches: ${mismatches}`);
  console.log(`\n  scan time  flat ${flatMs.toFixed(0)}ms   trie ${trieMs.toFixed(0)}ms   ` +
    `(${(flatMs / Math.max(trieMs, 0.001)).toFixed(2)}x)`);
  console.log(mismatches === 0 && unit === 0
    ? `\n  ✓ EQUIVALENT — same language, verified on real text.\n`
    : `\n  ✗ NOT EQUIVALENT — do not ship.\n`);
  if (mismatches || unit) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
