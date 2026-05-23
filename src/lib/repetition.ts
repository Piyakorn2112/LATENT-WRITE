/**
 * repetition.ts
 *
 * Extracted n-gram echo detection from RepetitionWidget.tsx.
 * Surfaces phrasal tics (3-grams and 4-grams that repeat verbatim)
 * while filtering grammatical noise via a stopword guard.
 *
 * Powers RepetitionWidget — extracted here so it can be unit-tested
 * and reused without React dependency.
 */

export const REPETITION_STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","by","for",
  "with","from","into","onto","as","is","was","were","are","be","been",
  "being","have","has","had","do","does","did","that","this","these",
  "those","i","he","she","it","we","you","they","him","her","them",
  "his","hers","its","their","my","your","our","what","which","who",
  "whom","when","where","why","how","not","no","so","if","then","than",
  "there","here","up","down","out","over","under","off","just","very",
  "yet","still","also","said","like","one","two",
]);

export interface Echo {
  phrase: string;
  count: number;
  /** n-gram size: 3 or 4 */
  k: number;
  /** 1-based paragraph index where phrase first appears (−1 = unresolved) */
  firstParaIndex: number;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z][a-z'-]*\b/g) ?? []);
}

function ngramKey(tokens: string[], i: number, k: number): string {
  let s = tokens[i];
  for (let j = 1; j < k; j++) s += " " + tokens[i + j];
  return s;
}

function isStopHeavy(key: string, k: number): boolean {
  let stops = 0;
  for (const t of key.split(" ")) {
    if (REPETITION_STOPWORDS.has(t)) stops++;
  }
  return stops >= Math.ceil(k / 2);
}

function paragraphsOf(content: string): string[] {
  return content.split(/\n{2,}|\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * Find repeating 3-grams and 4-grams in the chapter text.
 * Returns top echoes sorted by count (descending), longest n first.
 *
 * @param content     - full chapter text
 * @param topN        - maximum number of echoes to return (default 5)
 * @param min4Gram    - minimum count for 4-grams (default 2)
 * @param min3Gram    - minimum count for 3-grams (default 3)
 */
export function findEchoes(
  content: string,
  topN = 5,
  min4Gram = 2,
  min3Gram = 3,
): Echo[] {
  if (!content || content.length < 200) return [];
  const tokens = tokenize(content);
  if (tokens.length < 12) return [];

  const fourGrams = new Map<string, number>();
  const threeGrams = new Map<string, number>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    const k3 = ngramKey(tokens, i, 3);
    if (!isStopHeavy(k3, 3)) threeGrams.set(k3, (threeGrams.get(k3) ?? 0) + 1);
    if (i <= tokens.length - 4) {
      const k4 = ngramKey(tokens, i, 4);
      if (!isStopHeavy(k4, 4)) fourGrams.set(k4, (fourGrams.get(k4) ?? 0) + 1);
    }
  }

  // Covered 3-grams: sub-sequences of repeating 4-grams suppress double-reporting
  const covered = new Set<string>();
  for (const [k4, n] of fourGrams) {
    if (n < min4Gram) continue;
    const parts = k4.split(" ");
    covered.add(parts.slice(0, 3).join(" "));
    covered.add(parts.slice(1, 4).join(" "));
  }

  const collected: Echo[] = [];
  for (const [k4, n] of fourGrams) {
    if (n >= min4Gram) collected.push({ phrase: k4, count: n, k: 4, firstParaIndex: -1 });
  }
  for (const [k3, n] of threeGrams) {
    if (n >= min3Gram && !covered.has(k3)) {
      collected.push({ phrase: k3, count: n, k: 3, firstParaIndex: -1 });
    }
  }

  if (collected.length === 0) return [];

  // First-paragraph attribution
  const paras = paragraphsOf(content);
  const phraseRe = collected.map(e => ({
    phrase: e.phrase,
    re: new RegExp(`\\b${e.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));
  for (let pi = 0; pi < paras.length; pi++) {
    const p = paras[pi];
    for (const { phrase, re } of phraseRe) {
      const echo = collected.find(e => e.phrase === phrase);
      if (echo && echo.firstParaIndex === -1 && re.test(p)) {
        echo.firstParaIndex = pi + 1;
      }
    }
  }

  // Sort: longer n first, then by count, then alpha
  collected.sort((a, b) =>
    b.k - a.k || b.count - a.count || a.phrase.localeCompare(b.phrase)
  );

  return collected.slice(0, topN);
}
