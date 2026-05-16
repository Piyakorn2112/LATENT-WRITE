// Text wall content — same source as renderer-site HeroSection
const COMBINED = `She woke on a floor she didn't know. The ceiling was old plaster water-stained in the shape of a coastline. The room smelled of damp stone and something mineral and sweet that she had no category for. Light through the high window was grey and morning. She had been lying on her side with her arm under her head, and when she lifted it her arm was numb. She stood. The numbness resolved. She walked to the door. The door was unlocked. She walked out of it into a corridor, and the corridor into a street, and the street was the city. She had no plan and no origin and no word for either of these facts, but she had the city, and she walked into it the way she would come to understand she did everything in those first hours. Her hand was warm. The wall remembered. Nothing else did. She hated this. She was magnificent at it. The hum at zero point eight seconds. The first time is the crack. She held the language honest. Temperature differential becoming only two temperatures. Take me home. The coat before words. Anchor voice draft scene arc prose thread motif beat register tension flow chapter lore review canon expansion pass pivot climax resolution continuity naming timeline ghost embodied disruption lattice governance calibration warmth distance skeleton assembly export precision depth register embodied disruption lattice anchor scene draft arc lore voice thread motif beat pass review tension chapter prose canon flow expansion pivot climax resolution continuity naming timeline distance warmth calibration governance precision depth register`;

export function getRendererTextLines(wordsPerLine = 10): string[] {
  const words = COMBINED.split(/\s+/);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(" "));
  }
  while (lines.length < 30) {
    lines.push(...lines.slice(0, 30 - lines.length));
  }
  return lines;
}
