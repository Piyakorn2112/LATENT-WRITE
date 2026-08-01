/**
 * diagnose-knob-live.cjs — fold analysis on the map the GPU ACTUALLY READS.
 *
 * Two earlier attempts at this measured the wrong buffer: buildKnobMapPixels
 * returns the PRE-downscale render buffer, and the shipped map is the
 * SSAA-averaged PNG. Rather than emulate canvas downscaling in Node, this
 * reads the real <feImage> out of the live filter, draws it, and walks the
 * sampling function feDisplacementMap will evaluate.
 *
 *   VITE_URL=http://localhost:5178 electron scripts/diagnose-knob-live.cjs
 */
const { app, BrowserWindow } = require("electron");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL(`${BASE}/toggle-verify.html`);
  await wait(1800);
  await win.webContents.executeJavaScript("window.__press(true)");
  await wait(400);

  const out = await win.webContents.executeJavaScript(`(async () => {
    const DISP = 40;
    const knob = document.querySelector('.glass-toggle-knob');
    const m = /url\\("?#([^")]+)"?\\)/.exec(getComputedStyle(knob).backdropFilter || "");
    if (!m) return { error: "no filter on the knob" };
    const fe = document.getElementById(m[1]).querySelector('feImage');
    const href = fe.getAttribute('href') || fe.getAttribute('xlink:href');
    const feW = parseFloat(fe.getAttribute('width'));
    const feH = parseFloat(fe.getAttribute('height'));
    const img = new Image();
    img.src = href;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;

    const density = c.width / feW;               // texels per ELEMENT px
    const cx = (c.width / 2) | 0;
    const cy = (c.height / 2) | 0;
    // ★ THE ELEMENT'S OWN TEXEL SPAN, and its EXACT mirror.
    // Row r's partner is (top + bottom) − r. Mirroring about c.height/2
    // instead pairs the first element row with the row one PAST the last —
    // a margin row reading 128 — and reports a fake 30-byte asymmetry. That
    // is an instrument bug, and it cost a wrong diagnosis once already.
    const elemRows = Math.round(knob.offsetHeight * density);
    const top0 = Math.round((c.height - elemRows) / 2);
    const bot0 = top0 + elemRows - 1;
    const mirror = (r) => top0 + bot0 - r;

    // Vertical: walk the centre column, in ELEMENT units.
    let vFolds = 0, worstV = 0, firstV = -1;
    let prev = -Infinity;
    for (let y = 0; y < c.height; y++) {
      const g = px[(y * c.width + cx) * 4 + 1];
      const s = y / density + DISP * (g / 255 - 0.5);
      if (prev !== -Infinity && s - prev <= 0) {
        vFolds++; worstV = Math.min(worstV, s - prev);
        if (firstV < 0) firstV = y;
      }
      prev = s;
    }
    // Horizontal: same, along the centre row.
    let hFolds = 0, worstH = 0;
    prev = -Infinity;
    for (let x = 0; x < c.width; x++) {
      const r = px[(cy * c.width + x) * 4];
      const s = x / density + DISP * (r / 255 - 0.5);
      if (prev !== -Infinity && s - prev <= 0) { hFolds++; worstH = Math.min(worstH, s - prev); }
      prev = s;
    }
    // ★ LOCAL COMPRESSION — the measurement that actually explains the comb.
    // A map can be perfectly fold-free and still TEAR: what matters is not
    // just the SIGN of d(sample)/d(texel) but its SIZE. Where the sampling
    // barely advances, a hard backdrop edge is squeezed into a sliver and
    // consecutive output pixels alternate between two backdrop rows — stripes.
    // The 8-bit displacement channel sets the floor: one LSB is dispPx/255
    // element px, so at density d a single-LSB step leaves 1/d − dispPx/255.
    let minAdv = Infinity, minAdvAt = -1;
    // ★ THE DISTRIBUTION, not just the minimum. Two densities can share a
    // worst case and behave completely differently: what makes a COMB is
    // texels ALTERNATING between full advance and a stall.
    const hist = { stalled: 0, slow: 0, normal: 0, total: 0 };
    const advSeq = [];
    {
      let prev = null;
      for (let y = top0; y <= bot0; y++) {
        const g = px[(y * c.width + cx) * 4 + 1];
        const s = y / density + DISP * (g / 255 - 0.5);
        if (prev !== null) {
          const adv = (s - prev) * density;   // as a fraction of normal advance
          if (adv < minAdv) { minAdv = adv; minAdvAt = y - top0; }
          // Only inside the refraction band, where the field is moving.
          if (g !== 128) {
            hist.total++;
            if (adv < 0.15) hist.stalled++;
            else if (adv < 0.75) hist.slow++;
            else hist.normal++;
            if (advSeq.length < 24) advSeq.push(Number(adv.toFixed(2)));
          }
        }
        prev = s;
      }
    }

    // ★ THE 2-D FOLD TEST. Per-axis walks can only see folds along their own
    // axis; the reported stripes sit on the ROUNDED CAP and the BOTTOM, where
    // the displacement is diagonal. A gather map tears wherever its Jacobian
    // determinant stops being positive — that is the complete statement.
    const sampleX = (x, y) => x / density + DISP * (px[(y * c.width + x) * 4] / 255 - 0.5);
    const sampleY = (x, y) => y / density + DISP * (px[(y * c.width + x) * 4 + 1] / 255 - 0.5);
    let jFolds = 0, worstDet = Infinity;
    const region = { top: 0, bottom: 0, left: 0, right: 0 };
    const left0 = Math.round((c.width - Math.round(knob.offsetWidth * density)) / 2);
    const right0 = c.width - left0 - 1;
    for (let y = top0 + 1; y < bot0; y++) {
      for (let x = left0 + 1; x < right0; x++) {
        const dxdx = sampleX(x + 1, y) - sampleX(x - 1, y);
        const dxdy = sampleX(x, y + 1) - sampleX(x, y - 1);
        const dydx = sampleY(x + 1, y) - sampleY(x - 1, y);
        const dydy = sampleY(x, y + 1) - sampleY(x, y - 1);
        const det = dxdx * dydy - dxdy * dydx;
        if (det <= 0) {
          jFolds++;
          worstDet = Math.min(worstDet, det);
          const midX = (left0 + right0) / 2, midY = (top0 + bot0) / 2;
          if (y < midY) region.top++; else region.bottom++;
          if (x < midX) region.left++; else region.right++;
        }
      }
    }

    // Top/bottom asymmetry of the G field about the element centre.
    let asym = 0, asymAt = -1;
    for (let r = top0; r <= bot0; r++) {
      const a = px[(r * c.width + cx) * 4 + 1] - 128;
      const b = px[(mirror(r) * c.width + cx) * 4 + 1] - 128;
      if (Math.abs(a + b) > asym) { asym = Math.abs(a + b); asymAt = r - top0; }
    }
    // The two rims, side by side, so the asymmetry is visible not just scored.
    const dump = [];
    for (let k = 0; k < 16; k++) {
      dump.push({
        k,
        top: px[((top0 + k) * c.width + cx) * 4 + 1],
        bot: px[(mirror(top0 + k) * c.width + cx) * 4 + 1],
      });
    }
    return {
      id: m[1], mapW: c.width, mapH: c.height, feW, feH, density,
      vFolds, worstV, firstV, hFolds, worstH, asymBytes: asym, asymAt, dump,
      elemRows, top0, bot0,
      jFolds, worstDet: worstDet === Infinity ? null : worstDet, region,
      minAdv, minAdvAt, hist, advSeq,
      interior: (bot0 - top0 - 1) * (right0 - left0 - 1),
      byteStep: DISP / 255, advance: 1 / density,
    };
  })()`);

  if (out.error) { console.error(out.error); app.exit(2); return; }
  console.log(`\nSHIPPED map for ${out.id}`);
  console.log(`  ${out.mapW}x${out.mapH} over ${out.feW} element px = ${out.density.toFixed(2)} texels/element px`);
  console.log(`  one texel advances ${out.advance.toFixed(4)} element px; one byte step displaces ${out.byteStep.toFixed(4)}`);
  console.log(`  fold-free margin ......... ${(out.advance / out.byteStep).toFixed(2)}x  (needs > 1)`);
  console.log(`  vertical folds ........... ${out.vFolds}${out.vFolds ? ` (first at texel ${out.firstV}, worst ${out.worstV.toFixed(3)})` : ""}`);
  console.log(`  horizontal folds ......... ${out.hFolds}${out.hFolds ? ` (worst ${out.worstH.toFixed(3)})` : ""}`);
  console.log(`  element occupies rows ${out.top0}..${out.bot0} (${out.elemRows} texels)`);
  console.log(`  min local advance ........ ${out.minAdv.toFixed(3)}x normal`
    + ` (${out.minAdv > 0 ? `${(1 / Math.max(out.minAdv, 1e-6)).toFixed(1)}:1 compression` : "FOLD"})`
    + ` at ${out.minAdvAt} texels in`);
  const h = out.hist;
  console.log(`  advance distribution ..... stalled(<0.15x) ${h.stalled}  slow ${h.slow}  normal ${h.normal}`
    + `  of ${h.total} band texels  → ${((h.stalled / Math.max(1, h.total)) * 100).toFixed(0)}% stalled`);
  console.log(`  first advances in the band: ${out.advSeq.join(" ")}`);
  console.log(`  2-D FOLDS (det J <= 0) ... ${out.jFolds} of ${out.interior} interior texels`
    + `${out.jFolds ? ` — worst det ${out.worstDet.toExponential(2)}, top ${out.region.top} / bottom ${out.region.bottom}, left ${out.region.left} / right ${out.region.right}` : ""}`);
  console.log(`  top/bottom asymmetry ..... ${out.asymBytes} byte(s), worst ${out.asymAt} texels in from the rim`);
  console.log(`\n  rim profiles, walking INWARD from each edge (G channel):`);
  console.log(`    step   top    bottom   (odd-symmetric ⇒ top-128 = -(bottom-128))`);
  for (const d of out.dump) {
    console.log(`    ${String(d.k).padStart(4)}  ${String(d.top).padStart(5)}  ${String(d.bot).padStart(7)}    ${(d.top - 128) + (d.bot - 128) === 0 ? "" : `sum ${(d.top - 128) + (d.bot - 128)}`}`);
  }
  app.exit(0);
});
