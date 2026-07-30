# Annotating `event-gold.json`

This is the fixture the event detector is scored against. Its quality caps the
quality of every number the project reports, so read this before adding to it.

## The one rule that protects everything else

**`evidence` must be an EXACT substring of the paragraph it claims.** The harness
verifies this before scoring anything. If it does not match, the suite fails
loudly — which is the point. Without that check, a changed paragraph split would
silently turn the whole fixture into plausible-looking near-misses and every
reported number would be confident and meaningless.

Copy the clause character-for-character, including original punctuation and
spelling (`to-night`, `_am_`, curly quotes). Keep it short: 4–12 words, the
clause that *is* the event, not the whole paragraph.

## Never look at the detector's output first

Do not run `test-event-detect`, `probe-*`, or `detectNarrativeEvents` before
annotating. Gold annotated to match what the engine already finds measures
nothing. Read the chapter as a reader, decide what happened, then write it down.

## Getting the text

```
npx tsx scripts/print-chapter.ts <book> <chapterNumber>
```

Paragraph numbers printed there are 1-BASED and match what the harness expects.
Use them exactly. If the chapter does not exist, skip it and say so.

## What counts as an event

An event is **something that happens which changes the situation**. A reader
summarising the chapter to a friend would mention it.

NOT events, however vivid:
- description of a room, a person, weather, or clothing
- a character thinking, remembering, feeling, or noticing
- habitual or repeated action ("every morning he would…")
- backstory in pluperfect ("he had been a clerk for twenty years")
- ordinary conversation that changes nothing
- crossing a room, sitting, standing, picking things up

Events:
- a decision, refusal, promise, or commitment
- a revelation: someone learns something that changes what they believe
- open conflict between people about something that matters
- an arrival, departure, death, or disappearance
- violence, threat, or capture
- something hidden being discovered
- an institution ruling, voting, or formally acting

## salience: `major` vs `minor`

**major** — a one-paragraph summary of the chapter could not omit it.
**minor** — real, but the summary would survive without it.

Be strict. A chapter usually has 2–5 majors. If you mark everything major the
field carries no information.

## `type` — pick the closest

`decision` · `revelation` · `confrontation` · `arrival` · `departure` ·
`state-change` · `action` · `shift`

Type agreement between trained scholars is only moderate (Krippendorff α
0.57–0.75), so do not agonise. Position and salience matter far more.

## `legacyType` — pick the closest

`climax` · `confrontation` · `revelation` · `introduction` · `transition` ·
`scene-break`

## Entry shape

```json
{
  "book": "expectations",
  "chapter": 1,
  "eventfulness": "moderate",
  "whatHappens": "One sentence: what a reader would say happened in this chapter.",
  "events": [
    {
      "paragraph": 29,
      "summary": "Short active clause naming who did what",
      "salience": "major",
      "type": "confrontation",
      "legacyType": "confrontation",
      "evidence": "exact substring copied from paragraph 29"
    }
  ]
}
```

`eventfulness`: `quiet` · `moderate` · `eventful`.

Order `events` by ascending `paragraph`.

## Coverage

Annotate EVERY event in the chapter, not just the obvious ones — recall is
measured against this list, so a missed annotation is scored as a false positive
against the engine. Typical chapter: 4–9 events total.
