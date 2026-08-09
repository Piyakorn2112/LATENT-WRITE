/// <reference types="node" />

/**
 * test-bucket-corpus.ts — does the bucketer generalise off the book it was
 * fixed on?
 *
 * ★ THIS IS THE POINT OF IT. Every threshold in the classifier was set while
 *   reading The Root Crown, so a 96% there proves the fixes FIT that book and
 *   nothing else. These thirteen are published novels nobody tuned against,
 *   and the names are ones no reader would argue about: Elizabeth is a person
 *   and Netherfield is a place in any reading of Pride and Prejudice.
 *
 * ★★ AND IT FOUND THE LARGEST ERROR CLASS IN THE SYSTEM. At four books this
 *    harness read 93%, which looked like a rounding difference from the dev
 *    book. At thirteen it read 83.8%, and EVERY ONE of the 40 wrong buckets
 *    was a place filed as a character, with no error of any other kind
 *    anywhere. A uniform failure that size is invisible until the sample is
 *    wide enough to stop looking like noise.
 *
 * ★ ONLY UNCONTROVERSIAL NAMES. A large hand-labelled cast for thirteen books
 *   would be a second tuning target, which is the thing this exists to guard
 *   against. Every entry below is a protagonist, a named town or a named
 *   country — the cases where a wrong bucket is not a judgement call but a
 *   failure.
 *
 * Run:  ./node_modules/.bin/tsx scripts/test-bucket-corpus.ts
 */

import { scanAndClassify } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

type Bucket = "character" | "place" | "faction";

const EXPECTED: Record<string, Record<string, Bucket>> = {
  pride: {
    Elizabeth: "character", Darcy: "character", Bingley: "character",
    Jane: "character", Wickham: "character", Collins: "character",
    Charlotte: "character", Lydia: "character", Gardiner: "character",
    Netherfield: "place", Longbourn: "place", Pemberley: "place",
    Meryton: "place", Rosings: "place", Derbyshire: "place",
    Hertfordshire: "place", Brighton: "place", Scotland: "place",
  },
  dracula: {
    Harker: "character", Lucy: "character", Mina: "character",
    Helsing: "character", Renfield: "character", Seward: "character",
    Morris: "character", Hawkins: "character", Swales: "character",
    Transylvania: "place", Whitby: "place", London: "place", Carfax: "place",
    Exeter: "place", Piccadilly: "place", Amsterdam: "place",
    Bistritz: "place", Bukovina: "place", Purfleet: "place",
    Galatz: "place", Varna: "place", England: "place", Scotland: "place",
  },
  treasure: {
    Silver: "character", Livesey: "character", Trelawney: "character",
    Hawkins: "character", Flint: "character", Redruth: "character",
    Morgan: "character", Hands: "character", Merry: "character",
    Bristol: "place", England: "place", London: "place", Savannah: "place",
  },
  frankenstein: {
    Elizabeth: "character", Clerval: "character", Justine: "character",
    Walton: "character", Felix: "character", Safie: "character",
    Ernest: "character", Waldman: "character", Krempe: "character",
    Geneva: "place", Ingolstadt: "place", Edinburgh: "place",
    Strasburgh: "place", Chamounix: "place", Lucerne: "place",
    Switzerland: "place", Scotland: "place", Ireland: "place",
    London: "place", Oxford: "place", France: "place", Italy: "place",
    Leghorn: "place", Perth: "place",
  },
  anne: {
    Marilla: "character", Matthew: "character", Diana: "character",
    Gilbert: "character", Rachel: "character", Anne: "character",
    Avonlea: "place", Charlottetown: "place", Newbridge: "place",
    Carmody: "place", Bolingbroke: "place", Marysville: "place",
    Spencervale: "place",
  },
  antonia: {
    // ★ THE TITLE CHARACTER. 287 sightings, and the scan returned her zero
    //   times until the name boundaries stopped being ASCII-only.
    "Ántonia": "character",
    Shimerda: "character", Ambrosch: "character", Yulka: "character",
    Pavel: "character", Cuzak: "character", Krajiek: "character",
    Jelinek: "character", Harling: "character", Cleric: "character",
    Nebraska: "place", Lincoln: "place", Chicago: "place", Bohemia: "place",
    Virginia: "place", Wyoming: "place", Denver: "place", Omaha: "place",
    Vienna: "place", Boston: "place", London: "place", Colorado: "place",
    Austria: "place", America: "place", Russia: "place", Norway: "place",
    Klondike: "place", Seattle: "place", Florida: "place",
  },
  awakening: {
    // Every one of these was lost or truncated to a fragment ("Alc") before
    // the boundaries were made unicode-safe.
    "Léonce": "character", "Adèle": "character", "Désirée": "character",
    "Alcée Arobin": "character",
    Pontellier: "character", Arobin: "character", Mariequita: "character",
    Celestine: "character", Beaudelet: "character", Edna: "character",
    Robert: "character", Victor: "character",
    Mexico: "place", Paris: "place", Iberville: "place",
    Louisiana: "place", Kentucky: "place", Mississippi: "place",
  },
  carol: {
    Scrooge: "character", Marley: "character", Cratchit: "character",
    Fezziwig: "character", Fred: "character", Dilber: "character",
    London: "place",
  },
  expectations: {
    Pip: "character", Estella: "character", Jaggers: "character",
    Wemmick: "character", Magwitch: "character", Biddy: "character",
    Orlick: "character", Drummle: "character", Wopsle: "character",
    Compeyson: "character", Startop: "character", Herbert: "character",
    Hammersmith: "place", Richmond: "place", Walworth: "place",
    Newgate: "place", Camberwell: "place", London: "place",
    Portsmouth: "place", Rotterdam: "place", Hamburg: "place",
    Gravesend: "place", Cheapside: "place", Smithfield: "place",
    England: "place", France: "place",
  },
  gatsby: {
    Gatsby: "character", Daisy: "character", Wilson: "character",
    Jordan: "character", Myrtle: "character", Wolfshiem: "character",
    Michaelis: "character", Klipspringer: "character", Catherine: "character",
    Chicago: "place", Southampton: "place", France: "place",
    England: "place", Oxford: "place", Louisville: "place",
    Montenegro: "place", Europe: "place", Broadway: "place",
  },
  sherlock: {
    Holmes: "character", Watson: "character", Lestrade: "character",
    Rucastle: "character", Windibank: "character", Openshaw: "character",
    Peterson: "character", Ryder: "character", Breckinridge: "character",
    Bradstreet: "character", Roylott: "character", Toller: "character",
    London: "place", Winchester: "place", Paddington: "place",
    Streatham: "place", Australia: "place", America: "place",
    England: "place", France: "place", India: "place", Bristol: "place",
    Southampton: "place", Philadelphia: "place", Horsham: "place",
    Holborn: "place", Kilburn: "place", Dundee: "place", Harrow: "place",
  },
  worlds: {
    Ogilvy: "character", Henderson: "character", Stent: "character",
    Woking: "place", Thames: "place", Horsell: "place", Chobham: "place",
    Weybridge: "place", Shepperton: "place", Byfleet: "place",
    Leatherhead: "place", Chertsey: "place", Staines: "place",
    Richmond: "place", Kingston: "place", Wimbledon: "place",
    Waterloo: "place", Barnet: "place", Hounslow: "place",
    Mortlake: "place", Kilburn: "place", England: "place",
    Highgate: "place", Stanmore: "place", Halliford: "place",
    Edgware: "place", Pyrford: "place", Sunbury: "place",
  },
  webnovel: {
    Jonah: "character", Talon: "character", Mira: "character",
    Iris: "character", Seraphine: "character", Rosalind: "character",
    Kessler: "character",
  },
};

function bucketOf(
  r: { characters: string[]; places: string[]; factions: string[]; entities: string[] },
  name: string,
): string | null {
  const lc = name.toLowerCase();
  const hit = (list: string[]) => list.some((n) => n.toLowerCase() === lc || n.toLowerCase() === `the ${lc}`);
  if (hit(r.characters)) return "character";
  if (hit(r.places)) return "place";
  if (hit(r.factions)) return "faction";
  if (hit(r.entities)) return "entity";
  return null;
}

// Recall is measured but not gated: these books name hundreds of things and
// the scan reports a top slice, so a missing minor name is a size decision,
// not a bucketing failure. A name that IS reported must be reported correctly.
const MIN_ACCURACY = 0.95;
const MIN_FOUND = 0.75;

async function main() {
  let found = 0;
  let total = 0;
  let correct = 0;
  const misses: string[] = [];

  for (const [book, expected] of Object.entries(EXPECTED)) {
    const novel = await loadBook(book);
    const scan = await scanAndClassify(novel.chapters.map((c) => c.content), undefined, 2);
    const seen: string[] = [];
    for (const [name, want] of Object.entries(expected)) {
      total += 1;
      const got = bucketOf(scan, name);
      if (got === null) { seen.push(`${name} —`); continue; }
      found += 1;
      if (got === want) { correct += 1; seen.push(`${name} ✓`); continue; }
      misses.push(`${book}: ${name} → ${got} (want ${want})`);
      seen.push(`${name} ✗${got}`);
    }
    console.log(`${book.padEnd(13)} ${seen.join("  ")}`);
  }

  const accuracy = found === 0 ? 0 : correct / found;
  const foundRate = total === 0 ? 0 : found / total;

  console.log("");
  if (misses.length) {
    console.log("WRONG BUCKET");
    for (const m of misses) console.log(`  ${m}`);
    console.log("");
  }

  const gates: Array<[string, boolean, string]> = [
    ["bucket accuracy on found names", accuracy >= MIN_ACCURACY,
      `${(accuracy * 100).toFixed(1)}% (${correct}/${found}), floor ${MIN_ACCURACY * 100}%`],
    ["names found at all", foundRate >= MIN_FOUND,
      `${(foundRate * 100).toFixed(1)}% (${found}/${total}), floor ${MIN_FOUND * 100}%`],
  ];
  let failed = 0;
  for (const [label, ok, detail] of gates) {
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(32)} ${detail}`);
  }
  console.log(failed === 0 ? "\nAll gates pass.\n" : `\n${failed} gate(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
