/**
 * probe-glass-unsupported.cjs — SANDBOX. WHICH elements the painter cannot
 * express, by name, under a named surface.
 *
 * probe-glass-real-app.cjs reports the toolbar reconstructing at MAE 46.65/255
 * with 98% of pixels off by more than 32 — a whole-surface failure, not glyph
 * noise — and counts 10 masked elements underneath it. A count is not a
 * diagnosis, so this lists them: tag, classes, rect, what they paint, and which
 * construct puts them out of reach.
 *
 *   electron scripts/probe-glass-unsupported.cjs
 */
const { app, BrowserWindow } = require("electron");
const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

const SEL = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-lens";

const PROBE = `(() => {
  const glass = [...document.querySelectorAll(${JSON.stringify(SEL)})].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });
  const target = glass.find((el) => el.classList.contains("toolbar")) || glass[0];
  const tr = target.getBoundingClientRect();
  const hit = (r) => r.right > tr.left && r.left < tr.right && r.bottom > tr.top && r.top < tr.bottom;

  const out = [];
  for (const el of document.querySelectorAll("*")) {
    if (glass.includes(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !hit(r)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const reasons = [];
    if (cs.transform !== "none") reasons.push("transform");
    if (cs.filter !== "none") reasons.push("filter");
    if (cs.maskImage && cs.maskImage !== "none") reasons.push("mask");
    if (cs.webkitMaskImage && cs.webkitMaskImage !== "none" && !reasons.includes("mask")) reasons.push("mask");
    if (cs.mixBlendMode !== "normal") reasons.push("blend");
    if (cs.boxShadow !== "none") reasons.push("shadow");
    if (!reasons.length) continue;
    const paints = cs.backgroundImage !== "none"
      ? cs.backgroundImage.slice(0, 58)
      : cs.backgroundColor;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 3).join("."),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      reasons, paints, opacity: cs.opacity,
      // ★ Does it actually PAINT anything? An element with a mask and no
      //   background costs the painter nothing; one with a gradient and a mask
      //   is the whole error.
      visible: cs.backgroundImage !== "none"
        || !/rgba\\(0, 0, 0, 0\\)/.test(cs.backgroundColor),
    });
  }
  return { target: (target.className || "").toString(), rect: [tr.left, tr.top, tr.width, tr.height], out };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  await win.loadURL(URL_);
  await wait(7000);
  const res = await win.webContents.executeJavaScript(PROBE);
  console.log(`\nunder "${res.target.trim()}" at [${res.rect.map(Math.round).join(", ")}]\n`);
  console.log("element                              rect                    paints                                 why");
  for (const e of res.out) {
    console.log(
      `${(e.tag + "." + e.cls).slice(0, 36).padEnd(36)} ` +
      `${("[" + e.rect.join(",") + "]").padEnd(23)} ` +
      `${(e.visible ? e.paints : "(paints nothing)").slice(0, 38).padEnd(38)} ` +
      `${e.reasons.join("+")}`);
  }
  const painting = res.out.filter((e) => e.visible);
  console.log(`\n${res.out.length} elements the painter cannot express; ${painting.length} of them actually PAINT.`);
  console.log("Only the painting ones cost accuracy — the rest are masks on empty boxes.");
  app.exit(0);
});
