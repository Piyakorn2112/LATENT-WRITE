/**
 * verify-icon-toolchain.cjs — the build-time decision that picks the app icon.
 *
 * scripts/electron-build.cjs chooses between the Icon Composer bundle (real
 * liquid-glass icon, needs actool 26+) and the flat build/icon.icns fallback.
 * Getting that choice wrong is invisible until someone looks at the Dock, so
 * the decision is gated here rather than trusted.
 *
 * Every case drives the REAL script through its --probe exit code (10 = the
 * .icon bundle, 20 = the icns fallback) with a controlled PATH and a
 * controlled search root, so the no-Xcode branch is exercised on a machine
 * that HAS Xcode.
 *
 *   /opt/homebrew/bin/node scripts/verify-icon-toolchain.cjs
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "electron-build.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lw-icon-toolchain-"));
const NODE = process.execPath;

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

/** A stand-in actool that answers --version exactly the way Apple's does. */
function fakeActool(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body =
    version === null
      ? '#!/bin/sh\necho "xcrun: error: unable to find utility \\"actool\\"" >&2\nexit 72\n'
      : `#!/bin/sh
cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>com.apple.actool.version</key>
\t<dict>
\t\t<key>bundle-version</key>
\t\t<string>25095</string>
\t\t<key>short-bundle-version</key>
\t\t<string>${version}</string>
\t</dict>
</dict>
</plist>
PLIST
`;
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** A fake Xcode.app whose actool reports `version`. Returns its Developer dir. */
function fakeXcode(root, name, version) {
  const dev = path.join(root, name, "Contents", "Developer");
  fakeActool(path.join(dev, "usr", "bin", "actool"), version);
  return dev;
}

function probe({ pathActool, roots, developerDir }) {
  const binDir = fs.mkdtempSync(path.join(TMP, "bin-"));
  fakeActool(path.join(binDir, "actool"), pathActool);
  const env = {
    ...process.env,
    // /usr/bin stays reachable: the script asks xcode-select where the
    // selected toolchain is, and that answer must be a real one.
    PATH: `${binDir}:/usr/bin:/bin`,
    LW_XCODE_SEARCH_ROOTS: roots ?? path.join(TMP, "no-such-root"),
  };
  delete env.DEVELOPER_DIR;
  delete env.LW_DEVELOPER_DIR;
  if (developerDir) env.LW_DEVELOPER_DIR = developerDir;
  const r = spawnSync(NODE, [SCRIPT, "--probe"], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

console.log("\nicon toolchain decision\n");

// ── 1. This machine, untouched ───────────────────────────────────────────────
{
  const r = spawnSync(NODE, [SCRIPT, "--probe"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const real = r.status === 10;
  gate(real, `this machine compiles the .icon bundle`, out);
  if (real) {
    gate(/actool \d+\.\d+ found/.test(out), "the decision names the actool version it found", out);
  } else {
    console.log("       (no Xcode 26+ here — the icns fallback is the correct answer)");
  }
}

// ── 2. Nothing anywhere → the fallback, never a failed build ─────────────────
{
  const r = probe({ pathActool: null });
  gate(r.code === 20, "no actool on PATH and no Xcode.app: falls back to icns", r.out);
  gate(/build\/icon\.icns fallback/.test(r.out), "the fallback says which icon it shipped", r.out);
}

// ── 3. The version floor is real ─────────────────────────────────────────────
{
  const roots = fs.mkdtempSync(path.join(TMP, "old-"));
  fakeXcode(roots, "Xcode.app", "25.3");
  const r = probe({ pathActool: "25.3", roots });
  gate(r.code === 20, "actool 25.3 is rejected on PATH and in /Applications", r.out);
}
{
  const roots = fs.mkdtempSync(path.join(TMP, "floor-"));
  fakeXcode(roots, "Xcode.app", "26.0");
  const r = probe({ pathActool: null, roots });
  gate(r.code === 10, "actool 26.0 clears the floor", r.out);
}

// ── 4. Installing Xcode is enough — no `sudo xcode-select` required ──────────
{
  const roots = fs.mkdtempSync(path.join(TMP, "found-"));
  const dev = fakeXcode(roots, "Xcode.app", "27.0");
  const r = probe({ pathActool: null, roots });
  gate(r.code === 10, "a broken PATH actool does not hide an installed Xcode", r.out);
  gate(r.out.includes(dev), "the decision names the developer dir it will hand to the build", r.out);
}

// ── 5. Release Xcode outranks a beta ─────────────────────────────────────────
{
  const roots = fs.mkdtempSync(path.join(TMP, "both-"));
  const stable = fakeXcode(roots, "Xcode.app", "27.0");
  const beta = fakeXcode(roots, "Xcode-beta.app", "28.0");
  const r = probe({ pathActool: null, roots });
  gate(r.out.includes(stable) && !r.out.includes(beta), "release Xcode is preferred over a beta", r.out);
}

// ── 6. A beta alone still ships the real icon ────────────────────────────────
{
  const roots = fs.mkdtempSync(path.join(TMP, "beta-"));
  const beta = fakeXcode(roots, "Xcode-beta.app", "27.0");
  const r = probe({ pathActool: null, roots });
  gate(r.code === 10 && r.out.includes(beta), "a beta-only machine compiles the bundle", r.out);
}

// ── 7. Explicit override wins over everything discovered ─────────────────────
{
  const roots = fs.mkdtempSync(path.join(TMP, "override-"));
  fakeXcode(roots, "Xcode.app", "27.0");
  const other = fs.mkdtempSync(path.join(TMP, "forced-"));
  const forced = fakeXcode(other, "Xcode.app", "26.4");
  const r = probe({ pathActool: null, roots, developerDir: forced });
  gate(r.out.includes(forced), "LW_DEVELOPER_DIR overrides the scan", r.out);
}

// ── 8. A correctly selected toolchain needs no override at all ───────────────
{
  const r = probe({ pathActool: "26.1" });
  gate(r.code === 10 && /on PATH/.test(r.out), "actool already on PATH is used as-is", r.out);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
