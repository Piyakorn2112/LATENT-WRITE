/**
 * electron-build.cjs — the packaging entry that never breaks on the icon.
 *
 * The Icon Composer bundle ("Latent Write Logo.icon") is the INTENDED app
 * icon: electron-builder 26.8 hands it to Xcode's actool, which compiles the
 * authored layer stack into Contents/Resources/Assets.car and stamps
 * CFBundleIconName, so macOS 26+ renders the real liquid-glass icon from the
 * layer description rather than from a flat bitmap. actool also emits the
 * companion Icon.icns for older macOS, derived from the same document.
 *
 * actool ships with Xcode, NOT with Command Line Tools — and a hard-configured
 * .icon therefore fails the whole build on a machine without it. So the icon is
 * DECIDED HERE, at build time, by probing the toolchain:
 *   - actool 26+ reachable  → the .icon bundle (the real glass icon)
 *   - otherwise             → build/icon.icns (same orb mark, rendered to a
 *                             flat icns with system tools)
 *
 * ★ FINDING THE TOOL IS PART OF THE PROBE. Installing Xcode is not enough:
 *   `xcode-select -p` keeps pointing at /Library/Developer/CommandLineTools
 *   until someone runs `sudo xcode-select -s`, and the /usr/bin/actool on PATH
 *   is only a shim that forwards to whatever that setting names. It exits
 *   non-zero with Xcode sitting right there in /Applications. So this script
 *   resolves a developer directory that actually CONTAINS actool, and hands it
 *   to electron-builder on both DEVELOPER_DIR and PATH. No sudo, and a beta
 *   Xcode counts.
 *
 * Set LW_DEVELOPER_DIR to force a specific toolchain, or LW_XCODE_SEARCH_ROOTS
 * to replace the directories scanned for an Xcode.app.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** Every developer directory worth probing, best candidate first. */
function candidateDeveloperDirs() {
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir) && fs.existsSync(path.join(dir, "usr", "bin", "actool"))) {
      dirs.push(dir);
    }
  };

  add(process.env.LW_DEVELOPER_DIR);
  add(process.env.DEVELOPER_DIR);

  const selected = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  if (selected.status === 0) add(selected.stdout.trim());

  // Release Xcode before a beta, newest before oldest, so a machine with both
  // ships from the stable toolchain. LW_XCODE_SEARCH_ROOTS replaces the search
  // path so the no-Xcode branch stays testable ON a machine that has Xcode.
  const roots = (process.env.LW_XCODE_SEARCH_ROOTS ?? `/Applications:${path.join(os.homedir(), "Applications")}`)
    .split(":")
    .filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // ~/Applications often does not exist
    }
    const apps = entries
      .filter((name) => /^Xcode.*\.app$/i.test(name))
      .sort((a, b) => Number(/beta/i.test(a)) - Number(/beta/i.test(b)) || b.localeCompare(a));
    for (const app of apps) add(path.join(root, app, "Contents", "Developer"));
  }

  return dirs;
}

/** actool's own reported version, or null if this dir cannot run it. */
function probeActool(developerDir) {
  const env = { ...process.env };
  if (developerDir) {
    env.DEVELOPER_DIR = developerDir;
    env.PATH = `${path.join(developerDir, "usr", "bin")}:${env.PATH ?? ""}`;
  }
  const probe = spawnSync("actool", ["--version"], { encoding: "utf8", env });
  const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (probe.status !== 0 || !/short-bundle-version/.test(out)) return null;
  const version = (out.match(/<string>([\d.]+)<\/string>/g) ?? [])
    .map((m) => m.replace(/<\/?string>/g, ""))
    .find((v) => /\./.test(v));
  const major = Number((version ?? "0").split(".")[0]);
  // electron-builder's own floor: semver.gte(coerce(version), 26.0.0).
  return major >= 26 ? { version, major, developerDir } : null;
}

/**
 * The toolchain this build will use, or null for the icns fallback.
 * Exported so the packaged-artifact verifier compiles the SAME source bundle
 * with the SAME actool and can compare bytes rather than take the build's word.
 */
function resolveActool() {
  // Bare PATH first: on a correctly `xcode-select`-ed machine nothing needs
  // overriding, and a test can put a fake actool in front of everything.
  return probeActool(null) ?? candidateDeveloperDirs().map(probeActool).find(Boolean) ?? null;
}

module.exports = { resolveActool };

if (require.main !== module) return;

const found = resolveActool();

console.log(
  found
    ? `actool ${found.version} found${found.developerDir ? ` in ${found.developerDir}` : " on PATH"}: ` +
      "compiling the Icon Composer bundle (liquid-glass icon)"
    : "actool unavailable (needs Xcode 26+): packaging with build/icon.icns fallback",
);

// --probe prints the decision and exits — lets the branch that needs Xcode
// be exercised on a machine without it (fake actool on PATH in the test).
if (process.argv.includes("--probe")) {
  process.exit(found ? 10 : 20);
}

const env = { ...process.env };
if (found?.developerDir) {
  // BOTH, deliberately: electron-builder spawns a bare `actool`, which PATH
  // answers directly, while anything reaching for it through xcrun reads
  // DEVELOPER_DIR. Setting only one leaves the other resolving to the
  // Command Line Tools shim that started this whole problem.
  env.DEVELOPER_DIR = found.developerDir;
  env.PATH = `${path.join(found.developerDir, "usr", "bin")}:${env.PATH ?? ""}`;
}

const args = ["--mac", "--config", "electron-builder.yml"];
if (found) {
  args.push("-c.mac.icon=Latent Write Logo.icon", "-c.mas.icon=Latent Write Logo.icon");
}

const bin = path.join(__dirname, "..", "node_modules", ".bin", "electron-builder");
const r = spawnSync(bin, args, { stdio: "inherit", env });
process.exit(r.status ?? 1);
