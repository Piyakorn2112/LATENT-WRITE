/**
 * glass-gl.ts — SANDBOX. Not imported by the app.
 *
 * The knob painter's optics, moved to a fragment shader.
 *
 * ─── WHY THE GPU IS NOT OPTIONAL HERE ────────────────────────────────────────
 *
 * `scripts/probe-refraction-cost.cjs` times the shipping 2D painter on the app's
 * real surface sizes. It sustains ~26,000 device px/ms, which is fine for a
 * 32x24 knob (0.20 ms) and is not fine for anything else: the toolbar alone is
 * 4.83 ms/frame, a settings panel 40 ms, the timeline overlay 174 ms. Per-pixel
 * float refraction is the right method and JS is the wrong place for it.
 *
 * The arithmetic is identical to knob-glass-paint.ts — the same squircle height
 * profile through the same Snell displacement, the same fold that makes the rim
 * read as thick glass, the same inward sample with the channels split. Three
 * differences, all of them consequences of being on the GPU:
 *
 *   · the profile is evaluated analytically instead of read from a 512-entry
 *     LUT (a `pow` is free here and a dependent texture fetch is not);
 *   · bilinear sampling is the hardware's, not four weighted array reads;
 *   · the shape is a general rounded RECT, not a pill, because that is what
 *     every surface bigger than a knob actually is.
 */

/** Air → glass, as everywhere else in this codebase. */
const ETA = 1 / 1.5;

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;      // the reconstructed backdrop
uniform vec2  u_size;         // surface size, device px
uniform float u_radius;       // corner radius, device px
uniform float u_bezel;        // bevel width, device px
uniform float u_peak;         // peak pull, device px
uniform float u_chroma;       // channel separation, fraction of the pull
uniform float u_sat;          // saturation of the refracted backdrop
uniform vec4  u_fill;         // the surface's own tint, straight alpha
uniform float u_edgeHi;       // specular on the up/down-facing rim
uniform float u_edgeDark;     // darkening on the side-facing rim
uniform float u_rim;          // rim-shading hairline width, device px
uniform float u_gradK;        // smooth-max width, device px — see sdRoundRect

const float ETA = ${ETA};

/** Squircle height profile h(t) = (1 - (1-t)^4)^(1/4), and its slope. */
float hSlope(float t) {
  float u = 1.0 - t;
  float f = 1.0 - u * u * u * u;
  // dh/dt = u^3 / (1 - u^4)^(3/4). Singular at the rim, so clamp exactly where
  // the CPU painter clamps: slope 5.
  return min(u * u * u / pow(max(f, 1e-6), 0.75), 5.0);
}

/** Snell's-law lateral displacement for a surface of the given slope. */
float snellDisp(float slope) {
  if (slope < 1e-3) return 0.0;
  float nLen = sqrt(slope * slope + 1.0);
  float nZ = 1.0 / nLen;
  float sinSq = ETA * ETA * (1.0 - nZ * nZ);
  if (sinSq >= 1.0) return 0.0;
  return (sqrt(1.0 - sinSq) - ETA * nZ) * (slope / nLen);
}

/**
 * ★ SMOOTH MAX, AND IT IS NOT COSMETIC.
 *
 * The exact rounded-rect SDF is length(max(q,0)) + min(max(q.x,q.y),0) - r,
 * and its GRADIENT is genuinely discontinuous along the medial axis — the 45°
 * line running inward from each corner, where the nearest edge switches from
 * horizontal to vertical. A pill has no such line (one of its q components is
 * always zero), which is why knob-glass-paint.ts can take the normal in closed
 * form and this cannot.
 *
 * The first version of this shader used the exact normal and drew a visible
 * diagonal seam out of all four corners of a 420x120 popover. That is the same
 * artifact liquid-glass-worker.ts carries its GRAD_K = 40 smooth-max variant
 * to hide, so the machinery in the shipping engine is not overhead this path
 * gets to skip — it is load-bearing, and it had to be ported.
 *
 * ★ AND NOTE WHERE THIS COMMENT LIVES: inside the GLSL template literal. The
 * first draft quoted that SDF expression in backticks, which closed the JS
 * template string and broke the module — silently, as far as the harness was
 * concerned, because it only ever reported "__labReady never became true".
 * No backticks below this line.
 *
 * Log-sum-exp is a C-infinity max, so the field it produces has no seam at all,
 * and the normal comes from central differences on it.
 */
float smoothMax(float a, float b, float k) {
  float m = max(a, b);
  return m + k * log(exp((a - m) / k) + exp((b - m) / k));
}

float sdfSharp(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - (half_ - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdfSmooth(vec2 p, vec2 half_, float r, float k) {
  vec2 q = abs(p) - (half_ - r);
  return length(max(q, 0.0)) + min(smoothMax(q.x, q.y, k), 0.0) - r;
}

/**
 * ★ SHARP FOR THE DISTANCE, SMOOTH FOR THE NORMAL ONLY. This is the whole
 *   trick and the first attempt got it wrong in a way worth recording: using
 *   the smooth SDF for BOTH replaced the corner seam with four bright wedges,
 *   because a smooth max with k = 20 device px does not merely round the
 *   gradient — over that band it changes the DISTANCE, so the bezel itself
 *   bulges. The distance decides where the bevel is and must stay exact; only
 *   the direction the bevel pushes needs to be continuous.
 *
 *   That is exactly how liquid-glass-worker.ts uses its GRAD_K, and reading
 *   the shipping engine's intent rather than its constant is what fixed this.
 */
float sdRoundRect(vec2 p, vec2 half_, float r, float k, out vec2 n) {
  const float e = 0.75;
  float gx = sdfSmooth(p + vec2(e, 0.0), half_, r, k) - sdfSmooth(p - vec2(e, 0.0), half_, r, k);
  float gy = sdfSmooth(p + vec2(0.0, e), half_, r, k) - sdfSmooth(p - vec2(0.0, e), half_, r, k);
  vec2 g = vec2(gx, gy);
  float len = length(g);
  // At the dead centre of a circle the gradient vanishes; fall back to
  // something finite rather than emitting a NaN that paints as a black pixel.
  n = len > 1e-5 ? g / len : vec2(0.0, 1.0);
  return sdfSharp(p, half_, r);
}

void main() {
  vec2 px = v_uv * u_size;
  vec2 p = px - u_size * 0.5;
  vec2 nrm;
  float sd = sdRoundRect(p, u_size * 0.5, u_radius, u_gradK, nrm);

  // One device pixel of coverage at the silhouette.
  float cov = clamp(-sd, 0.0, 1.0);
  if (cov <= 0.0) { outColor = vec4(0.0); return; }

  float dist = -sd;
  float t = clamp(dist / u_bezel, 0.0, 1.0);

  // ★ THE SAME PROFILE, NORMALISED THE SAME WAY. Peak pull is expressed in
  //   device px and divided by the rim magnitude, so u_peak means what it says
  //   regardless of the bevel's width.
  float rimDisp = snellDisp(5.0);
  float disp = t >= 1.0 ? 0.0 : snellDisp(hSlope(t)) * (u_peak / rimDisp);

  vec3 c;
  if (disp < 0.05) {
    c = texture(u_src, v_uv).rgb;
  } else {
    // Sample INWARD along the outward normal, channels split for dispersion.
    float sep = disp * u_chroma;
    vec2 inv = 1.0 / u_size;
    c.r = texture(u_src, (px - nrm * (disp - sep)) * inv).r;
    c.g = texture(u_src, (px - nrm *  disp       ) * inv).g;
    c.b = texture(u_src, (px - nrm * (disp + sep)) * inv).b;
  }

  // Saturate the refracted backdrop, then the surface's own tint over it.
  float lum = dot(c, vec3(0.213, 0.715, 0.072));
  c = clamp(lum + (c - lum) * u_sat, 0.0, 1.0);
  c = mix(c, u_fill.rgb, u_fill.a);

  // Rim shading: a hairline at the very edge — white where it faces up/down,
  // dark where it faces the sides.
  if (dist < u_rim) {
    float ring = 1.0 - dist / u_rim;
    float sharp = ring * ring * ring;
    float vFrac = nrm.y * nrm.y;
    float hi = sharp * vFrac * u_edgeHi;
    float dk = sharp * (1.0 - vFrac) * u_edgeDark;
    c = (c + (1.0 - c) * hi) * (1.0 - dk);
  }

  outColor = vec4(c, cov);
}`;

export interface GlassGLScene {
  /** Surface size in CSS px, and the density to render at. */
  w: number;
  h: number;
  dpr: number;
  /** Corner radius in CSS px. */
  radius: number;
  /** Bevel width in CSS px. */
  bezel: number;
  /** Peak pull in CSS px. */
  peak: number;
  chroma?: number;
  saturate?: number;
  /** Surface tint, as [r, g, b, a] with rgb in 0..1. */
  fill: [number, number, number, number];
  edgeHi?: number;
  edgeDark?: number;
  rimPx?: number;
  /** Smooth-max width in CSS px; the shipping worker's GRAD_K equivalent. */
  gradK?: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  }
  return s;
}

/**
 * A reusable GL surface. One per glass element; `draw` uploads the current
 * backdrop and renders. Kept as a class because the program, the VAO and the
 * texture must outlive a frame — recreating them per frame is what makes naive
 * WebGL slower than the 2D path it replaces.
 */
export class GlassGL {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  /** Set when the last upload could reuse the texture's storage. */
  lastUploadWasSubImage = false;
  private texW = 0;
  private texH = 0;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true, premultipliedAlpha: false, antialias: false,
      desynchronized: true, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("no webgl2");
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    }
    this.prog = prog;
    gl.useProgram(prog);
    for (const n of ["u_src", "u_size", "u_radius", "u_bezel", "u_peak",
      "u_chroma", "u_sat", "u_fill", "u_edgeHi", "u_edgeDark", "u_rim", "u_gradK"]) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // CLAMP + LINEAR: the pull only ever samples inward, so clamping is a
    // safety net rather than a visible behaviour.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  }

  /** Upload a backdrop. Separate from `render` so the harness can time both. */
  upload(src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const w = (src as HTMLCanvasElement).width ?? 0;
    const h = (src as HTMLCanvasElement).height ?? 0;
    // ★ REALLOCATING THE TEXTURE EVERY FRAME IS THE USUAL WAY THIS GOES SLOW.
    //   Same dimensions → texSubImage2D, which keeps the driver's allocation.
    if (w === this.texW && h === this.texH && w > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.lastUploadWasSubImage = true;
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.texW = w; this.texH = h;
      this.lastUploadWasSubImage = false;
    }
  }

  render(scene: GlassGLScene): void {
    const gl = this.gl;
    const dpr = scene.dpr;
    const W = Math.max(1, Math.round(scene.w * dpr));
    const H = Math.max(1, Math.round(scene.h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.u_src, 0);
    gl.uniform2f(this.u.u_size, W, H);
    gl.uniform1f(this.u.u_radius, scene.radius * dpr);
    gl.uniform1f(this.u.u_bezel, Math.max(1, scene.bezel * dpr));
    gl.uniform1f(this.u.u_peak, scene.peak * dpr);
    gl.uniform1f(this.u.u_chroma, scene.chroma ?? 0.04);
    gl.uniform1f(this.u.u_sat, scene.saturate ?? 1.45);
    gl.uniform4f(this.u.u_fill, ...scene.fill);
    gl.uniform1f(this.u.u_edgeHi, scene.edgeHi ?? 0.5);
    gl.uniform1f(this.u.u_edgeDark, scene.edgeDark ?? 0.16);
    gl.uniform1f(this.u.u_rim, Math.max(1, (scene.rimPx ?? 1.2) * dpr));
    // The shipping worker uses GRAD_K = 40 element px for the same job. Scaled
    // to device px here, and floored so a tiny surface still gets a smooth
    // field rather than a hard switch across two pixels.
    gl.uniform1f(this.u.u_gradK, Math.max(2, (scene.gradK ?? 40) * dpr * 0.25));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Force the GPU to finish, so a timing measures work rather than queueing. */
  finish(): void {
    this.gl.finish();
  }
}
