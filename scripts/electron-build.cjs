/**
 * electron-build.cjs — the packaging entry that never breaks on the icon.
 *
 * The Icon Composer bundle ("Latent Write Logo.icon") is the INTENDED app
 * icon: electron-builder 26.8 compiles it into the native asset catalog
 * (Assets.car) so macOS renders the authored liquid-glass icon. That
 * compilation is done by Xcode's actool (26+), which does not exist in
 * Command Line Tools — and a hard-configured .icon therefore fails the
 * whole build on a machine without Xcode.
 *
 * So the icon is DECIDED HERE, at build time, by probing the toolchain:
 *   - actool 26+ present  → the .icon bundle (the real glass icon)
 *   - otherwise           → build/icon.icns (same orb mark, generated from
 *                           the bundle's own recipe with system tools)
 *
 * Install Xcode from the App Store and the very next `npm run
 * electron:build` ships the bundle icon with zero config changes.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const probe = spawnSync("actool", ["--version"], { encoding: "utf8" });
const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
const version = (out.match(/<string>([\d.]+)<\/string>/) ?? [])[1];
const major = Number((version ?? "0").split(".")[0]);
const useBundle = probe.status === 0 && /short-bundle-version/.test(out) && major >= 26;

console.log(
  useBundle
    ? `actool ${version} found: compiling the Icon Composer bundle (liquid-glass icon)`
    : "actool unavailable (needs Xcode 26+): packaging with build/icon.icns fallback",
);

// --probe prints the decision and exits — lets the branch that needs Xcode
// be exercised on a machine without it (fake actool on PATH in the test).
if (process.argv.includes("--probe")) {
  process.exit(useBundle ? 10 : 20);
}

const args = ["--mac", "--config", "electron-builder.yml"];
if (useBundle) {
  args.push("-c.mac.icon=Latent Write Logo.icon", "-c.mas.icon=Latent Write Logo.icon");
}

const bin = path.join(__dirname, "..", "node_modules", ".bin", "electron-builder");
const r = spawnSync(bin, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
