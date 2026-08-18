/**
 * after-pack.cjs — give macOS 25 and earlier the same authored icon.
 *
 * ★ THE FIX IS FOR A REGRESSION THE .icon SWITCH INTRODUCES. When the app is
 *   packaged from the Icon Composer bundle, electron-builder ships two things:
 *   Assets.car (the layer document macOS 26+ renders, masters up to 1024) and
 *   the Icon.icns actool emits alongside it. That icns is deliberately small:
 *   measured, it carries only ic04/ic11/ic07/ic13, i.e. nothing above 256px,
 *   because on 26+ nothing reads it above that. On an older macOS, though, the
 *   icns is the ONLY icon the system has, and Finder's large icon view and Get
 *   Info ask for 512 and 1024. The previous flat build/icon.icns went all the
 *   way to 1024, so switching to the authored icon would have traded a crisp
 *   wrong icon for a blurry right one on every pre-26 machine.
 *
 *   iconutil can render the full ladder straight out of the compiled catalog
 *   (`iconutil --convert icns Assets.car Icon`), so the enriched icns is the
 *   SAME authored artwork, just carried down to the older API. One source, all
 *   platforms.
 *
 * Runs before signing, so the replacement is inside the signature rather than
 * invalidating it, and before the DMG is built, so the disk image carries it
 * too. Never fails the build: if anything here does not work, actool's icns
 * stays exactly where electron-builder put it.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** The icns size classes iconutil renders out of a compiled icon catalog. */
const FULL_LADDER = ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"];

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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(appPath, "Contents", "Resources");
  const car = path.join(resources, "Assets.car");
  const icns = path.join(resources, "icon.icns");

  // No catalog means the icns fallback branch ran — there is nothing authored
  // to render from, and the flat icns already has every size.
  if (!fs.existsSync(car) || !fs.existsSync(icns)) return;

  const before = icnsChunks(icns);
  const tmp = path.join(context.appOutDir, ".icon-ladder.icns");
  const r = spawnSync("iconutil", ["--convert", "icns", "--output", tmp, car, "Icon"], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    console.log(`  • icon ladder skipped: iconutil failed (${(r.stderr ?? "").trim() || r.status})`);
    fs.rmSync(tmp, { force: true });
    return;
  }

  const after = icnsChunks(tmp);
  // Only accept a strictly better icns. A conversion that lost sizes would be
  // a downgrade dressed as a fix.
  const gained = FULL_LADDER.filter((t) => after?.[t] && !before?.[t]);
  const lost = Object.keys(before ?? {}).filter((t) => FULL_LADDER.includes(t) && !after?.[t]);
  if (!after || lost.length > 0 || !after.ic10) {
    console.log(`  • icon ladder skipped: conversion was not an improvement (lost ${lost.join(", ") || "none"}, 1024 ${after?.ic10 ? "present" : "missing"})`);
    fs.rmSync(tmp, { force: true });
    return;
  }

  fs.rmSync(icns, { force: true });
  fs.renameSync(tmp, icns);
  console.log(
    `  • icon ladder extended from the compiled catalog  gained=${gained.join(",")} ` +
      `sizes=${Object.keys(after).sort().join(",")}`,
  );
};
