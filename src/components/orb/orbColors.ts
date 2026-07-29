/* The orb's colours, as data.
   Kept out of OrbEngine.tsx on purpose: that module imports its own CSS,
   which node cannot load, and the SVG export script needs these values
   without dragging a React component (and a stylesheet) in with them. */
import { IOS_COLORS } from "../../lib/palette";

/** The petals' colours, FIXED and taken from the HIGHLIGHT LAYER's own
 *  palette (`lib/palette.ts` — the same iOS set that colours speakers and
 *  entities in the manuscript), so the orb is literally made of the
 *  colours the writer sees in their own prose.
 *
 *  Each oval is permanently assigned one. The order alternates cool and
 *  warm around the ring so no two neighbouring ovals share a hue family —
 *  with three blues in the set (blue, cyan, indigo) that is the only
 *  arrangement where none of them end up side by side, including across
 *  the wrap from the last back to the first. Nothing cycles, drifts or
 *  follows the analysis phase; the only colour change in the whole engine
 *  is the eased drain to grey when intelligence is off. No hue is ever
 *  computed at runtime, so no state can push one somewhere off-palette. */
export const PETAL_HEXES: string[] = [
  IOS_COLORS.blue.text, //   #1071D8
  IOS_COLORS.orange.text, // #DC7B19
  IOS_COLORS.cyan.text, //   #009ABC
  IOS_COLORS.red.text, //    #D6363B
  IOS_COLORS.indigo.text, // #4F45D8
  IOS_COLORS.green.text, //  #2EA84A
];

/** Off mode drains the ring to grey, each oval keeping its own value so
 *  the shape still reads. Light and dark get their own levels. */
export const OFF_GREY_LIGHT = [0.72, 0.8, 0.76, 0.62, 0.68, 0.84];
export const OFF_GREY_DARK = [0.42, 0.5, 0.46, 0.34, 0.38, 0.54];

export const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

export const PETAL_RGB: [number, number, number][] = PETAL_HEXES.map(hexToRgb);
