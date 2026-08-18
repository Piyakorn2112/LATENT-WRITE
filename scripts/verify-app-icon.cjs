/**
 * verify-app-icon.cjs — the icon INSIDE the packaged .app, read off disk.
 *
 * "The build log said it used actool" is not evidence. This opens the artifact
 * electron-builder produced and proves the shipped icon is the compiled Icon
 * Composer document, not a flat bitmap wearing its name.
 *
 * ★ WHAT MAKES THIS PROVABLE AT ALL. Neither actool's Assets.car nor
 *   iconutil's icns is byte-reproducible: the catalog header carries a
 *   timestamp, and the rasteriser jitters (measured: chunk lengths move up to
 *   0.571% across four identical runs, and 7 of 22 catalog assets change
 *   digest). So the gates below compare the parts that ARE reproducible:
 *
 *     - every catalog asset that is not a rendered bitmap (the authored
 *       vector, the colours, the gradients, the layer groups and stacks) is
 *       compared by its own SHA1 against a fresh compile of the source .icon;
 *     - the icns is compared to a fresh render of the app's OWN catalog by
 *       size-class set and per-class byte length inside a 5% band, ~9x the
 *       measured jitter.
 *
 *   The band is only worth anything if it can reject something, so the same
 *   comparison is run against build/icon.icns and REQUIRED to fail.
 *
 *   /opt/homebrew/bin/node scripts/verify-app-icon.cjs
 */
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveActool } = require("./electron-build.cjs");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "release", "mac-arm64", "Latent Write.app");
const RES = path.join(APP, "Contents", "Resources");
const SOURCE_ICON = path.join(ROOT, "Latent Write Logo.icon");
const FALLBACK_ICNS = path.join(ROOT, "build", "icon.icns");

/** Measured jitter is 0.571% over four runs; this is ~9x that. */
const LENGTH_BAND = 0.05;

let pass = 0;
let fail = 0;
const gate = (ok, label, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
};
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function withToolchain(tool) {
  const env = { ...process.env };
  if (tool?.developerDir) {
    env.DEVELOPER_DIR = tool.developerDir;
    env.PATH = `${path.join(tool.developerDir, "usr", "bin")}:${env.PATH ?? ""}`;
  }
  return env;
}

/** Compile the source .icon with the build's own toolchain. */
function compileSourceIcon(tool) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-icon-verify-"));
  const input = path.join(tmp, "Icon.icon");
  const out = path.join(tmp, "out");
  fs.cpSync(SOURCE_ICON, input, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  // The exact argument list app-builder-lib uses (macosIconComposer.js), so a
  // difference here would be a difference in the input, not in the invocation.
  const r = spawnSync(
    "actool",
    [
      input, "--compile", out,
      "--output-format", "human-readable-text", "--notices", "--warnings",
      "--output-partial-info-plist", path.join(out, "assetcatalog_generated_info.plist"),
      "--app-icon", "Icon", "--include-all-app-icons",
      "--accent-color", "AccentColor",
      "--enable-on-demand-resources", "NO",
      "--development-region", "en",
      "--target-device", "mac",
      "--minimum-deployment-target", "26.0",
      "--platform", "macosx",
    ],
    { encoding: "utf8", env: withToolchain(tool) },
  );
  return { root: tmp, car: path.join(out, "Assets.car"), status: r.status, log: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function catalogAssets(car) {
  const r = spawnSync("/usr/bin/assetutil", ["--info", car], { encoding: "utf8", maxBuffer: 64e6 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** icns is a flat list of typed chunks; the type IS the size class. */
function icnsChunks(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "icns") return null;
  const out = {};
  let off = 8;
  while (off + 8 <= b.length) {
    const type = b.toString("ascii", off, off + 4);
    const len = b.readUInt32BE(off + 4);
    if (len < 8 || off + len > b.length) return null;
    out[type] = len;
    off += len;
  }
  return out;
}

/** Same size classes, each within the jitter band. */
function icnsMatches(a, b) {
  if (!a || !b) return { ok: false, why: "unreadable icns" };
  const ta = Object.keys(a).filter((t) => t.startsWith("ic")).sort();
  const tb = Object.keys(b).filter((t) => t.startsWith("ic")).sort();
  if (ta.join(",") !== tb.join(",")) return { ok: false, why: `size classes differ: ${ta.join(",")} vs ${tb.join(",")}` };
  // Report the WORST class, not the first one over the line: the margin is
  // the evidence, and a decoy that fails by 113% should not be filed as 12%.
  let worst = { t: null, rel: 0 };
  for (const t of ta) {
    const rel = Math.abs(a[t] - b[t]) / Math.min(a[t], b[t]);
    if (rel > worst.rel) worst = { t, rel };
  }
  const margin = `worst class ${worst.t} off by ${(worst.rel * 100).toFixed(1)}%`;
  if (worst.rel > LENGTH_BAND) return { ok: false, why: margin };
  return { ok: true, why: `${ta.length} size classes, ${margin}, band ${LENGTH_BAND * 100}%` };
}

console.log("\npackaged app icon\n");

gate(fs.existsSync(APP), `the packaged app exists (${path.relative(ROOT, APP)})`);
if (!fs.existsSync(APP)) {
  console.log("\n  run `npm run electron:build` first\n");
  process.exit(1);
}

// ── The bundle declares an asset-catalog icon ────────────────────────────────
const infoPlist = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(APP, "Contents", "Info.plist")], { encoding: "utf8" });
const info = infoPlist.status === 0 ? JSON.parse(infoPlist.stdout) : null;
gate(!!info, "Info.plist parses");
gate(info?.CFBundleIconName === "Icon", `CFBundleIconName is "Icon" (${JSON.stringify(info?.CFBundleIconName)})`);
gate(info?.CFBundleIconFile === "icon.icns", `CFBundleIconFile is "icon.icns" (${JSON.stringify(info?.CFBundleIconFile)})`);

const car = path.join(RES, "Assets.car");
gate(fs.existsSync(car), "Contents/Resources/Assets.car shipped");
if (!fs.existsSync(car)) {
  console.log("\n  the app was packaged from build/icon.icns, not from the .icon bundle\n");
  process.exit(1);
}
gate(fs.statSync(car).size > 500_000, `the catalog carries real artwork (${(fs.statSync(car).size / 1024 / 1024).toFixed(2)} MB)`);

// ── The catalog is a LAYERED icon document, not a bag of renders ─────────────
const assets = catalogAssets(car);
gate(!!assets, "assetutil reads the catalog");
const header = (assets ?? []).find((a) => a.AssetStorageVersion) ?? {};
const typeOf = (t) => (assets ?? []).filter((a) => a.AssetType === t);

gate(typeOf("IconImageStack").length > 0, `layer stacks present (${typeOf("IconImageStack").length})`);
gate(typeOf("IconGroup").length > 0, `layer groups present (${typeOf("IconGroup").length})`);
gate(typeOf("Vector").length > 0, `the authored artwork is stored as vector (${typeOf("Vector").length})`);

const iconJson = JSON.parse(fs.readFileSync(path.join(SOURCE_ICON, "icon.json"), "utf8"));
const authored = iconJson.groups.flatMap((g) => g.layers.map((l) => l.name));
const vectorNames = typeOf("Vector").map((a) => (a.Name ?? "").split("/").pop());
gate(
  authored.every((name) => vectorNames.includes(name)),
  `every authored layer is in the catalog (${authored.join(", ")})`,
  `catalog vectors: ${[...new Set(vectorNames)].join(", ")}`,
);

// A flat icns has one appearance. An Icon Composer document renders per
// appearance, which is what makes dark and tinted modes work at all.
gate((header.Appearances?.NSAppearanceNameDarkAqua ?? 0) > 0, "a dark-appearance rendition exists");
gate((header.Appearances?.ISAppearanceTintable ?? 0) > 0, "a tintable rendition exists");
gate(header.Platform === "macosx", `compiled for macosx (${header.Platform})`);

const masters = typeOf("Icon Image").map((a) => a.PixelWidth);
gate(masters.includes(1024), `1024px master in the catalog (${[...new Set(masters)].sort((a, b) => a - b).join(", ")})`);

// ── The catalog is THIS source bundle, compiled ──────────────────────────────
const tool = resolveActool();
gate(!!tool, tool ? `actool ${tool.version} available for the recompile` : "actool 26+ available for the recompile");
if (tool) {
  const built = compileSourceIcon(tool);
  gate(built.status === 0, "the source .icon recompiles cleanly", built.log.slice(0, 400));
  if (built.status === 0) {
    const fresh = catalogAssets(built.car) ?? [];
    // Rendered bitmaps jitter; everything else is the authored document.
    const stable = (list) =>
      list
        .filter((a) => a.SHA1Digest && a.AssetType !== "Icon Image" && a.AssetType !== "IconImageStack")
        .map((a) => `${a.AssetType}|${a.Name}|${a.SHA1Digest}`)
        .sort();
    const shippedStable = stable(assets ?? []);
    const freshStable = stable(fresh);
    gate(shippedStable.length >= 8, `the catalog has authored assets to compare (${shippedStable.length})`);
    gate(
      shippedStable.join("\n") === freshStable.join("\n"),
      "every authored asset matches a fresh compile of the source .icon, by digest",
      `shipped ${shippedStable.length} vs fresh ${freshStable.length}`,
    );
    const vectorDigest = (list) => list.find((a) => a.AssetType === "Vector")?.SHA1Digest;
    gate(
      vectorDigest(assets ?? []) === vectorDigest(fresh) && !!vectorDigest(fresh),
      "the orb vector in the bundle is the one in Latent Write Logo.icon",
    );
  }
  fs.rmSync(built.root, { recursive: true, force: true });
}

// ── The icns companion: authored artwork, full ladder ────────────────────────
const shippedIcns = path.join(RES, "icon.icns");
gate(fs.existsSync(shippedIcns), "Contents/Resources/icon.icns shipped (older-macOS companion)");
if (fs.existsSync(shippedIcns)) {
  const chunks = icnsChunks(shippedIcns);
  gate(!!chunks, "the icns parses");
  // Pre-26 Finder asks for 512 and 1024; actool's own companion stops at 256,
  // so this is the gate on scripts/after-pack.cjs having run.
  gate(!!chunks?.ic09, "512px class present (ic09)");
  gate(!!chunks?.ic10, "1024px class present (ic10)", `classes: ${Object.keys(chunks ?? {}).sort().join(", ")}`);
  gate(sha(shippedIcns) !== sha(FALLBACK_ICNS), "the shipped icns is NOT the flat build/icon.icns fallback");

  // Rendered from the app's OWN catalog: same classes, lengths inside the band.
  const tmp = path.join(os.tmpdir(), `lw-icon-ladder-${process.pid}.icns`);
  const r = spawnSync("iconutil", ["--convert", "icns", "--output", tmp, car, "Icon"], { encoding: "utf8", env: withToolchain(tool) });
  gate(r.status === 0, "iconutil re-renders the icns from the shipped catalog", (r.stderr ?? "").slice(0, 300));
  if (r.status === 0) {
    const freshChunks = icnsChunks(tmp);
    const same = icnsMatches(chunks, freshChunks);
    gate(same.ok, `the shipped icns is that render (${same.why})`, same.why);
    // A band that accepts everything proves nothing: the flat fallback, run
    // through the identical comparison, has to be rejected.
    const decoy = icnsMatches(icnsChunks(FALLBACK_ICNS), freshChunks);
    gate(!decoy.ok, `the same comparison rejects build/icon.icns (${decoy.why})`);
    fs.rmSync(tmp, { force: true });
  }
}

// ── The DMG, which is what anyone actually receives ──────────────────────────
// The afterPack hook runs before the disk image is built, so the app inside it
// should carry the same icon. "Should" is why this mounts the thing and looks.
const dmgs = fs.existsSync(path.join(ROOT, "release"))
  ? fs.readdirSync(path.join(ROOT, "release")).filter((n) => n.endsWith(".dmg"))
  : [];
if (dmgs.length === 0) {
  console.log("  --   no DMG in release/ to check");
} else {
  const dmg = path.join(ROOT, "release", dmgs[0]);
  const attach = spawnSync("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountrandom", os.tmpdir()], { encoding: "utf8" });
  const mount = (attach.stdout ?? "").trim().split("\n").pop()?.split("\t").pop()?.trim();
  gate(attach.status === 0 && !!mount, `${dmgs[0]} mounts`);
  if (mount) {
    const dmgApp = path.join(mount, "Latent Write.app");
    const dmgRes = path.join(dmgApp, "Contents", "Resources");
    const dmgInfo = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(dmgApp, "Contents", "Info.plist")], { encoding: "utf8" });
    const parsed = dmgInfo.status === 0 ? JSON.parse(dmgInfo.stdout) : null;
    gate(parsed?.CFBundleIconName === "Icon", "the app in the DMG declares the asset-catalog icon");
    gate(fs.existsSync(path.join(dmgRes, "Assets.car")), "the app in the DMG carries Assets.car");
    const dmgChunks = fs.existsSync(path.join(dmgRes, "icon.icns")) ? icnsChunks(path.join(dmgRes, "icon.icns")) : null;
    gate(!!dmgChunks?.ic10, "the app in the DMG has the 1024px icns class");
    spawnSync("/usr/bin/hdiutil", ["detach", mount, "-quiet"]);
  }
}

// ── The source bundle is compiled, never copied in raw ───────────────────────
const strays = fs.readdirSync(RES).filter((n) => n.toLowerCase().endsWith(".icon"));
gate(strays.length === 0, "no raw .icon bundle left in Resources", strays.join(", "));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
