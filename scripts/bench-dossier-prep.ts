/**
 * bench-dossier-prep.ts — everything the dossier quality bench needs per
 * character, emitted as JSON, built by the SHIPPED module (never a copy).
 *
 * The runner (bench-dossier-quality.cjs) is an Electron process that can only
 * make model calls; all TypeScript-side work — harvest, pack assembly, the
 * extractive composition, the per-field requests, the think policy — happens
 * here, exactly the way WorldDataView.generateDossier does it, so the bench
 * measures the product and not a paraphrase of it.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs \
 *     scripts/bench-dossier-prep.ts pride:Elizabeth anne:Anne … > prep.json
 */
import {
  buildDossierPack,
  buildExtractiveCard,
  buildFieldRequest,
  buildFieldRetryRequest,
  buildFieldThinkRequest,
  composeExtractiveDescription,
  decideDossierThinking,
  fieldCandidates,
  harvestDossierEvidence,
  DOSSIER_FIELDS,
} from "../src/lib/character-dossier";
import { buildDeepPack, composeSkeleton } from "./lib-dossier-variants";
import { resolveSpeakerCandidates, buildSpeakerAliasMap } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

const CAST_LIMIT = 10;

async function castFor(book: string) {
  const novel = await loadBook(book);
  const text = novel.chapters.map((c) => c.content).join("\n");
  const names = resolveSpeakerCandidates(novel).slice(0, CAST_LIMIT * 2);
  const aliasMap = buildSpeakerAliasMap(names, text);
  const byCanonical = new Map<string, Set<string>>();
  for (const n of names) {
    const canonical = aliasMap.get(n.toLowerCase().trim()) ?? n;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Set());
    byCanonical.get(canonical)!.add(n);
  }
  const cast = [...byCanonical.entries()].map(([name, forms]) => ({
    name,
    aliases: [...forms].filter((f) => f !== name),
  }));
  return { novel, cast };
}

async function main() {
  const specs = process.argv.slice(2).filter((a) => a.includes(":"));
  const byBook = new Map<string, string[]>();
  for (const spec of specs) {
    const [book, name] = spec.split(":");
    if (!byBook.has(book)) byBook.set(book, []);
    byBook.get(book)!.push(name);
  }

  const out: unknown[] = [];
  for (const [book, wanted] of byBook) {
    const { novel, cast } = await castFor(book);
    const evidence = await harvestDossierEvidence(novel, cast, { yieldEvery: 8 });
    const ranked = [...evidence.characters].sort((a, b) => b.counts.mentions - a.counts.mentions);

    for (const name of wanted) {
      const ev = ranked.find(
        (e) => e.name.toLowerCase() === name.toLowerCase()
          || e.forms.some((f) => f.toLowerCase() === name.toLowerCase()),
      );
      if (!ev) {
        console.error(`  ! ${book}:${name} not in cast (${ranked.slice(0, 10).map((e) => e.name).join(", ")})`);
        continue;
      }
      const rank = ranked.indexOf(ev);
      const pack = buildDossierPack(ev);
      const card = buildExtractiveCard(ev, rank, "character");
      const sameKind = ranked.map((e) => e.name).filter((n) => n !== ev.name);
      const extractive = composeExtractiveDescription(ev, sameKind);
      const extractiveChapters = [...new Set(pack.spans.map((s) => s.chapter))].slice(0, 6);

      const fields = Object.fromEntries(DOSSIER_FIELDS.map((field) => {
        const policy = decideDossierThinking(field, fieldCandidates(pack, field).length);
        return [field, {
          ask: buildFieldRequest(pack, field, "character"),
          retry: buildFieldRetryRequest(pack, field, "character"),
          think: policy.think ? buildFieldThinkRequest(pack, field, "character") : null,
          thinkBudget: policy.budget,
        }];
      }));

      // ── variant artifacts. After the 2026-08-13 graduation the shipped
      //    builders ARE the deep shape; the deep pack is the max-tier
      //    evidence budget (MAX_PACK_OPTS).
      const skeleton = composeSkeleton(ev, sameKind);
      const deepPack = buildDeepPack(ev);
      const deepFields = Object.fromEntries(DOSSIER_FIELDS.map((field) => [field, {
        ask: buildFieldRequest(deepPack, field, "character"),
        retry: buildFieldRetryRequest(deepPack, field, "character"),
        // The think-on-rich experiment: the runner fires this for
        // personality when the trait pool is rich and DOSSIER_THINK=rich.
        ...(field === "personality"
          ? { think: buildFieldThinkRequest(deepPack, field, "character") }
          : {}),
      }]));

      out.push({
        spec: `${book}:${name}`,
        book,
        name: ev.name,
        forms: ev.forms,
        pronounClass: ev.pronounClass,
        counts: ev.counts,
        pack,
        role: card.role,
        factLine: card.factLine,
        extractive,
        extractiveChapters,
        fields,
        skeleton,
        deepPack,
        deepFields,
      });
    }
  }
  console.log(JSON.stringify(out));
}

main();
