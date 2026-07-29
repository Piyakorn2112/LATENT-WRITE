/* ─────────────────────────────────────────────────────────────────────────
   orbPhysics — the intelligence orb's motion, as a pure engine.

   The orb is six flat balls arranged in a ring, never touching. This file
   decides where they are and how far the rubber has drawn out; the shader
   only draws them. No DOM, no canvas, no React — `step(dt)` advances,
   `petals` is the state, so the feel is measured in node
   (scripts/orb-physics-probe.ts) instead of being eyeballed in a browser.

   ── the motion ────────────────────────────────────────────────────────
   Three things happen at once, all spring-driven rather than keyframed,
   so the orb has weight in it:

   · a PULSE. Each petal reaches OUT and swells, then comes back in. The
     six do not do it together — each one's beat is offset from the last,
     so the swell travels around the ring like a loading indicator. The
     driver is a power-eased bump (fast out, dwelling at the extremes),
     and each petal chases it through its OWN underdamped spring, so it
     overshoots slightly on the way out and settles on the way back
     instead of easing mechanically. Playful flicks land on jittered
     beats, so the rhythm never becomes a metronome.

   · a SPIN. The whole ring turns, slowly while the orb is resting and
     faster while it is working.

   · the RUBBER. Each ball is round until it is loaded, then draws out
     radially under the centrifugal term and snaps back — see the block
     of constants below.

   Energy scales them: thinking = a big reach and a quick turn, idle = the
   same gesture, small and slow. Nothing switches mode, so there is
   nothing to cross-fade — the transition IS the amplitude easing down.
   ───────────────────────────────────────────────────────────────────── */

export const PETAL_COUNT = 6;

/* ── the state transition ───────────────────────────────────────────────
   `energy` is the single driver every amplitude reads, so HOW it moves IS
   the transition between resting and working. It used to chase its target
   exponentially (`v += (target − v) · k · dt`), and that is the whole
   reason the change did not feel seamless: an exponential chase carries
   its MAXIMUM velocity on the very first frame and decays from there — a
   steep launch followed by a long drift. A spring leaves at zero velocity,
   builds, and settles, which is the shape the house motion rules ask for.

   Asymmetric on purpose, per those rules — "energy up front, long gentle
   decay", and enter/exit tuned independently:
     · entering work: stiffer, slightly underdamped, so it arrives with life
     · leaving work: softer and critically damped, so it settles without a
       bounce that would read as a second event

   Velocity CARRIES across a target change (the spring is never restarted),
   so an interruption mid-flight continues from where it actually is. */
const ENERGY_K_UP = 30;
const ENERGY_ZETA_UP = 0.78;
const ENERGY_K_DOWN = 9;
const ENERGY_ZETA_DOWN = 1;

/* ── layout ─────────────────────────────────────────────────────────────
   Proportions come from MEASURING the OpenAI Foundation mark's own
   artwork (its six shapes, connected-component + image-moment analysis of
   the official PNG), converted into the shader's p-space where the orb's
   slot is |p| ≤ 0.926:

     ring radius            0.60 × half-width  →  0.556
     semi-major (length)    0.29 × half-width  →  0.269
     empty centre           0.30 × half-width  →  0.278

   The mark holds ONE length across all six and varies only width, out to
   a 3.42:1 sliver. Copied literally that read as the logo rather than as
   this app's own orb, so this sits deliberately BETWEEN that and a plain
   ring of balls: the shapes keep a radial long axis and a family
   resemblance, but they also differ in SIZE, and the width run stops well
   short of the mark's extreme. */
/** distance from the centre to each shape's centre */
const RING_R = 0.556;
/** The base half-LENGTH each shape is scaled from. Sized against the ring,
 *  not the canvas: six shapes on a ring sit RING_R apart, so the widest a
 *  shape may get without meeting its neighbour is RING_R/2 — and with the
 *  aspect floor near 1 the width is nearly the length, so this is close to
 *  that ceiling on purpose. Bigger ovals, same ring. */
const MAJOR = 0.255;

/* ── the pulse ──────────────────────────────────────────────────────── */
/** driver frequency (Hz) at rest and at full energy */
const WAVE_HZ_IDLE = 0.26;
const WAVE_HZ_BUSY = 0.72;
/** < 1 ⇒ fast out of the centre, long dwell at the extremes */
const WAVE_EASE = 0.62;
/** driver amplitude at rest and at full energy */
const WAVE_IDLE = 0.34;
const WAVE_BUSY = 1;
/** One full ramp per lap of the ring — the reference's smooth run of
 *  eccentricities plus its single wrap seam, exactly. */
const STAGGER = (Math.PI * 2) / PETAL_COUNT;
/** how far a petal reaches OUT at full pulse, as a fraction of the ring.
 *  Small: the mark's six centres sit at one radius (measured std. dev.
 *  0.4%), so the ring should read even, with the life coming from width. */
const REACH = 0.1;

/* ── width ──────────────────────────────────────────────────────────────
   A modest run, and it does NOT carry the working state — it is the
   family resemblance to the reference, nothing more. The floor sits above
   1.0 on purpose: a true circle is the mark's signature, and it is also
   the widest a shape can get, which is what crowds its neighbours. */
const ASPECT_MIN = 1.04;
const ASPECT_IDLE = 1.15;
const ASPECT_BUSY = 1.55;

/* ── SCALING — this is what strengthens when the orb works ──────────────
   Working does not inflate the graphic and does not thin it into slivers.
   It widens how far the six DISAGREE ABOUT THEIR SIZE: the shape the wave
   is currently on swells well past its resting size while the ones behind
   it are still small. Centred on the wave's midpoint, so the mean size
   holds steady and only the spread opens.

   At REST the six stay near enough to equal that the ring reads as one
   calm object — the disagreement is the working state's own signal, and
   spending it at idle would leave nothing for the orb to say when it
   actually starts thinking. */
const SCALE_IDLE = 0.02;
const SCALE_BUSY = 0.46;

/* How the working signals answer energy. Energy sits at 0.55 whenever
   intelligence is simply ON — the state the orb spends nearly all its life
   in — so a LINEAR ramp spends half the disagreement there and the resting
   ring never looks calm. The suppression has to live somewhere.

   It was `e⁴`, and that was wrong in a way worth recording. A power curve
   is flat at 0 but its slope at 1 is n: the amplitudes therefore changed
   FASTEST exactly where the motion should have been settling, and the
   transition spring's small overshoot in energy came out FOUR TIMES
   larger in everything you could see.

   A smootherstep (6t⁵−15t⁴+10t³, Perlin) is flat at BOTH ends — zero
   first and second derivative — so the arrival decelerates into place and
   an overshoot past the top is absorbed instead of amplified. Remapping
   the RANGE rather than raising a power is what keeps rest quiet: below
   0.5 nothing is spent at all. */
const effort = (e: number) => {
  const t = Math.min(1, Math.max(0, (e - 0.5) / 0.5));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** how strongly each shape answers the wave, so the run around the ring
 *  is never perfectly mechanical */
const BALL_GAIN = [1.0, 1.12, 0.88, 1.06, 0.94, 1.16];

/* ── off-centring: the throw ────────────────────────────────────────────
   While the orb is working, the shape being flung out drags the whole
   cluster after it. Every shape is pushed along the direction the wave's
   peak is travelling — its momentum — but the one currently swelling is
   pushed FURTHEST, so the group visibly leans off centre and recovers as
   the wave moves on. Scaled by energy, so a resting orb stays centred. */
const THROW_BASE = 0.05;
const THROW_GAIN = 0.15;
/** ★ On top of that, the shape carrying the MOST momentum — the one the
 *  wave is peaking on, the one that has swollen biggest — gets thrown
 *  further again. Raised to a power so the extra is concentrated almost
 *  entirely on that one shape: at the peak it takes all of this, but a
 *  shape only three-quarters of the way up the wave takes barely a third
 *  of it. That is what separates "the group leans" from "one of them is
 *  being flung and the rest follow". Working state only.
 *
 *  Split between the momentum direction and straight OUT along its own
 *  radius, because a purely tangential extra throw drives the flung shape
 *  into whatever is ahead of it on the ring — measured, it overlapped its
 *  neighbour by 0.088. Escaping outward buys the room instead, and reads
 *  as being flung out rather than shoved sideways. */
const THROW_PEAK_ALONG = 0.075;
const THROW_PEAK_OUT = 0.07;
/** a little angular drift so the reach is not a rigid piston */
const SWEEP = 0.1;

/** How much the whole ring grows between resting and working. This used to
 *  be a CSS `transform: scale()` on the wrapper with its own duration and
 *  its own overshoot curve — a SECOND timeline running beside the rig's,
 *  which is what made the two states feel like they changed at different
 *  moments. One driver, one timeline: it rides `energy` like everything
 *  else, so the whole orb arrives and leaves together.
 *
 *  ⚠ Unlike the CSS transform it replaced, this counts against the canvas
 *  budget: a CSS scale grew the canvas AND its margin together and so could
 *  never clip, while growing the content inside a fixed canvas can. The
 *  peak throw was trimmed to pay for it. */
const RING_GROW = 0.05;

/* ── the rubber ─────────────────────────────────────────────────────────
   A ball swung on a string draws out ALONG the string: the rubber resists
   the turn, the mass lags, and the body thins radially. Here that lands on
   top of the width wave as extra narrowing under real centrifugal load
   (ω²·r) plus whatever radial speed the pulse is adding — on its own
   looser underdamped spring, so it lags the motion and settles back
   instead of snapping. The long axis also TRAILS the travel direction
   slightly, but only slightly: the reference measures every axis radial
   within about a degree, so this is a whisper of physicality at speed,
   never a pinwheel skew. */
/** extra aspect per unit of centrifugal acceleration */
const CENT_K = 1.6;
/** extra aspect per unit of radial speed (the pulse flinging it out) */
const RADV_K = 1.1;
/** how far the long axis trails the travel direction, per rad/s of spin */
const TRAIL_K = 0.12;
/** ceiling on the centrifugal contribution alone */
const STRETCH_MAX = 0.9;
/** the rubber's own spring — looser than the ring's, so it lags visibly */
const RUB_K = 120;
const RUB_ZETA = 0.42;

/* ── the spin ───────────────────────────────────────────────────────── */
const SPIN_IDLE = 0.11;
const SPIN_BUSY = 0.62;

/* ── the springs ────────────────────────────────────────────────────── */
/** petal 0 is the stiffest; each one after it is softer, which is what
 *  staggers their arrival and turns a sway into a travelling wave */
const K0 = 150;
const K_FALLOFF = 0.1;
/** ζ ≈ 0.45 — every disturbance resolves in one clean overshoot */
const ZETA = 0.45;

/* ── flicks (the playful part) ──────────────────────────────────────── */
const FLICK_MIN = 1.5;
const FLICK_JIT = 3.2;
const FLICK_IMPULSE = 3.4;

/* ── breathing, so a resting orb is never frozen ────────────────────── */
const BREATHE_HZ = 0.23;
const BREATHE_AMP = 0.022;

const MAX_FRAME = 1 / 30;

/** sign-preserving power ease — the shape that gives the sway its spring
 *  character instead of a sine's even sweep */
const powEase = (s: number, e: number) => (s < 0 ? -Math.pow(-s, e) : Math.pow(s, e));

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** what the renderer consumes: one flat ellipse */
export interface Petal {
  /** centre, in the shader's p-space */
  x: number;
  y: number;
  /** rotation of the ellipse's major axis */
  rot: number;
  /** semi-axes */
  a: number;
  b: number;
}

export class OrbWorld {
  readonly petals: Petal[] = [];
  time = 0;
  /** Where the orb is being ASKED to be: 0 = dormant, 1 = working. Set it
   *  freely and as often as you like; `energy` springs toward it. */
  target = 0.55;
  /** Where it actually IS — the single driver every amplitude reads. */
  energy = 0.55;
  private vEnergy = 0;

  private rnd: () => number;
  private spin: number;
  /** current spin rate (rad/s) — the centrifugal load reads this */
  private omega = 0;
  /** energy shaped by `effort` — how hard the orb is visibly working */
  private eff = 0;
  private phase: number;
  /** each petal's own lagging copy of the driver */
  private w = new Float64Array(PETAL_COUNT);
  private vw = new Float64Array(PETAL_COUNT);
  /** each petal's rubber stretch, and its spring velocity */
  private s = new Float64Array(PETAL_COUNT);
  private vs = new Float64Array(PETAL_COUNT);
  private nextFlick: number;

  constructor(seed = 0x51a7) {
    this.rnd = mulberry32(seed);
    // a random starting turn and wave phase, so two orbs on screen at once
    // (the button and its behind-glass twin) never march in lockstep
    this.spin = this.rnd() * Math.PI * 2;
    this.phase = this.rnd() * Math.PI * 2;
    this.nextFlick = FLICK_MIN + this.rnd() * FLICK_JIT;
    for (let i = 0; i < PETAL_COUNT; i++) {
      this.petals.push({ x: 0, y: 0, rot: 0, a: MAJOR, b: MAJOR });
    }
    this.place();
  }

  /** The driver for petal `i`: a NORMALISED 0..1 bump, offset per petal so
   *  the wave travels round the ring. Power-eased, so it leaves quickly
   *  and dwells at the extreme rather than sweeping evenly like a sine.
   *  Amplitudes live at the consumers (reach, width), not here — that way
   *  the width ramp maps straight onto the reference's aspect run. */
  private drive(i: number): number {
    const s = Math.sin(this.phase - i * STAGGER);
    return 0.5 + 0.5 * powEase(s, WAVE_EASE);
  }

  /** where petal `i` sits this instant */
  private radius(i: number, breathe: number) {
    const amp = WAVE_IDLE + (WAVE_BUSY - WAVE_IDLE) * this.energy;
    return RING_R * breathe * (1 + this.w[i] * REACH * amp);
  }

  private place() {
    const breathe =
      (1 + BREATHE_AMP * Math.sin(this.time * BREATHE_HZ * Math.PI * 2)) *
      (1 + RING_GROW * this.eff);
    const eff = this.eff;
    // the long axis trails the direction of travel, more the faster it turns
    const trail = -TRAIL_K * this.omega;
    const aspectMax = ASPECT_IDLE + (ASPECT_BUSY - ASPECT_IDLE) * eff;
    // how far the six may disagree about their size — the working state
    const scaleAmp = SCALE_IDLE + (SCALE_BUSY - SCALE_IDLE) * eff;

    // ── the throw. The wave's peak sits at `spin + phase - π/2` (the
    //    per-shape stagger is exactly one ring step, so it cancels), and
    //    it travels tangentially — that tangent is the momentum every
    //    shape gets pushed along, the swelling one hardest.
    const pk = this.spin + this.phase - Math.PI / 2;
    const mx = -Math.sin(pk);
    const my = Math.cos(pk);
    for (let i = 0; i < PETAL_COUNT; i++) {
      const wi = this.w[i];
      const base = (i / PETAL_COUNT) * Math.PI * 2;
      const ang = base + this.spin + wi * SWEEP;
      // out and back: the ball's whole distance from the centre rides the
      // pulse, and it swells a little as it goes
      const r = this.radius(i, breathe);
      // The spring's overshoot belongs to the REACH, where it reads as
      // bounce; past 1 it would only push the size and width runs onto
      // their ceilings, where idle and busy stop telling each other apart.
      const wq = wi < 0 ? 0 : wi > 1 ? 1 : wi;
      // the throw: everyone moves along the momentum, the swelling one most
      const wq2 = wq * wq;
      const peak = wq2 * wq2 * eff; // concentrated on the shape at the crest
      const push = (THROW_BASE + THROW_GAIN * wq) * eff + THROW_PEAK_ALONG * peak;
      const out = THROW_PEAK_OUT * peak;
      const p = this.petals[i];
      p.x = Math.cos(ang) * (r + out) + mx * push;
      p.y = Math.sin(ang) * (r + out) + my * push;

      /* ── the deformation, from the shape's OWN motion.
         Its velocity is whatever the spin, the pulse and the throw
         together are doing to it, so when the turn surges the shape is
         genuinely being hauled sideways: it draws out along the way it is
         going and leans its long axis into the turn, then eases back as
         the surge passes. That is the natural half — the centrifugal term
         below is the steady half. Read from the LAST frame's velocity,
         which lags by one frame and is worth the simplicity. */
      // the long axis is the radius, trailing a whisper behind the spin
      p.rot = ang + trail;

      // SIZE carries the working state: centred on the wave's midpoint, so
      // the mean size holds steady and only the disagreement opens up.
      const scale = 1 + (wq - 0.5) * 2 * scaleAmp * BALL_GAIN[i];
      p.a = MAJOR * breathe * scale;
      // WIDTH is the family resemblance to the reference, plus the
      // spring-lagged centrifugal narrowing and the speed the shape is
      // actually carrying. ENERGY OWNS THE CEILING: the physics terms fill
      // the headroom energy opened, never exceed it, or a quiet orb
      // borrows the working orb's range and the two stop reading apart.
      const room = aspectMax - ASPECT_MIN;
      const aspect =
        ASPECT_MIN + Math.min(room, room * wq * BALL_GAIN[i] + this.s[i]);
      p.b = p.a / aspect;
    }
  }

  step(frameDt: number) {
    const dt = Math.min(Math.max(frameDt, 0), MAX_FRAME);

    // ── the transition. Rising and falling get their own spring, chosen by
    //    which way the orb is being asked to go, and the velocity is never
    //    reset — so a target that changes mid-flight bends the motion
    //    instead of restarting it.
    const rising = this.target > this.energy;
    const k = rising ? ENERGY_K_UP : ENERGY_K_DOWN;
    const zeta = rising ? ENERGY_ZETA_UP : ENERGY_ZETA_DOWN;
    this.vEnergy +=
      ((this.target - this.energy) * k - this.vEnergy * 2 * zeta * Math.sqrt(k)) * dt;
    this.energy += this.vEnergy * dt;
    // the amplitudes downstream are only defined on 0..1; the spring may
    // overshoot past 1 on the way in, and that lands as life, not as a bug
    if (this.energy < 0) this.energy = 0;
    else if (this.energy > 1.12) this.energy = 1.12;

    const e = this.energy;

    const hz = WAVE_HZ_IDLE + (WAVE_HZ_BUSY - WAVE_HZ_IDLE) * e;
    this.phase += dt * hz * Math.PI * 2;
    this.eff = effort(e);
    this.omega = SPIN_IDLE + (SPIN_BUSY - SPIN_IDLE) * e;
    this.spin += dt * this.omega;
    this.time += dt;

    // a flick every few seconds — the orb catching itself mid-wave
    if (this.time >= this.nextFlick) {
      const k = (this.rnd() * PETAL_COUNT) | 0;
      this.vw[k] += (this.rnd() < 0.5 ? -1 : 1) * FLICK_IMPULSE * (0.35 + 0.65 * e);
      this.nextFlick = this.time + (FLICK_MIN + this.rnd() * FLICK_JIT) * (1.6 - e);
    }

    const breathe = 1 + BREATHE_AMP * Math.sin(this.time * BREATHE_HZ * Math.PI * 2);
    const rubD = 2 * RUB_ZETA * Math.sqrt(RUB_K);
    for (let i = 0; i < PETAL_COUNT; i++) {
      // softer down the ring ⇒ each petal lags a little more than the last,
      // on top of the stagger already built into the driver
      const k = K0 * (1 - K_FALLOFF * i);
      const d = 2 * ZETA * Math.sqrt(k);
      this.vw[i] += ((this.drive(i) - this.w[i]) * k - this.vw[i] * d) * dt;
      this.w[i] += this.vw[i] * dt;

      // the rubber: centrifugal load plus whatever radial speed the pulse
      // is adding, chased through its own looser spring so the ball wobbles
      // back to round rather than snapping
      const r = this.radius(i, breathe);
      const radialV = RING_R * REACH * this.vw[i];
      const load = CENT_K * this.omega * this.omega * r + RADV_K * Math.abs(radialV);
      const target = Math.min(STRETCH_MAX, load);
      this.vs[i] += ((target - this.s[i]) * RUB_K - this.vs[i] * rubD) * dt;
      this.s[i] = Math.max(0, Math.min(STRETCH_MAX, this.s[i] + this.vs[i] * dt));
    }

    this.place();
  }

  /** Each petal's current position in the wave (the probe measures the rig
   *  directly rather than trying to reverse the spin out of the drawn
   *  angles, which is not recoverable once the spin rate itself varies). */
  waveAt(i: number): number {
    return this.w[i];
  }

  /** How much is actually happening — the fastest petal's wave speed. The
   *  renderer throttles on this rather than on a timer, so a quiet orb
   *  costs nothing and a flick always draws at the full rate. */
  activity(): number {
    let v = 0;
    for (let i = 0; i < PETAL_COUNT; i++) v = Math.max(v, Math.abs(this.vw[i]));
    return v;
  }

  /** Pin the orb at one energy with the transition spring already at rest —
   *  for probes and the SVG export, which want a steady state rather than a
   *  moment inside a transition. Setting `energy` alone would not do it:
   *  the spring would immediately haul it back toward `target`. */
  settleAt(e: number) {
    this.target = e;
    this.energy = e;
    this.vEnergy = 0;
  }

  /** settle into a composed pose before the first frame is ever shown */
  warm(seconds = 1.6) {
    const steps = Math.round(seconds * 60);
    for (let s = 0; s < steps; s++) this.step(1 / 60);
  }
}
