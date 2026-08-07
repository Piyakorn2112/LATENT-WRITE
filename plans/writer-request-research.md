# Field research: writer instructions on a selected passage

(Deep-research pass, 2026-08-08. House punctuation applied. Checkability legend: DET = deterministically checkable, DET-PROXY = countable proxy, SOFT = judge-only.)

Method note: instruction types below are triangulated from (a) fossilized demand in paid tools (Sudowrite's Rewrite presets and its documented custom-instruction examples, ProWritingAid's 25 reports, AutoCrit's report set and self-editing checklist, Hemingway Plus AI-fix actions, Marlowe's report contents, Scrivener's Project Replace forum traffic), (b) writer-community and prompt-guide material (Wattpad self-editing checklist, weasel/crutch-word literature, talking-heads craft posts, ChatGPT-for-fiction editing guides), and (c) the standard fiction self-editing canon. Sudowrite's presets are the strongest single signal: they built exactly six one-click rewrites plus a free-text box, and their docs show what users type in that box ("be more ominous", "be in first person", "be in third person with name James", "add more dialogue").

Legend for checkability: **DET** = fully deterministic check possible; **DET-PROXY** = countable proxy covers pass/fail, quality residue is soft; **SOFT** = judge-only.

## Ranked instruction types (selection-scoped, beyond generic proofread/rewrite/shorten/lengthen)

### Tier 1 · near-universal (every tool has a dedicated feature for it; every checklist lists it)

1. **Kill word/phrase repetition ("echoes") in the passage** · PWA Echoes/Repeats/Overused Words, AutoCrit repetition, Marlowe "repetitive phrases", every checklist.
   - "she 'nods' three times in this paragraph, fix it"
   - "I used 'gaze' twice in two sentences, vary it"
   - "find another way to say 'darkness', it's everywhere in this scene"
   - **DET-PROXY**: count occurrences of the repeated lemma within an N-word window before/after; require reduction to ≤1 (or user-stated cap). Word-choice quality is soft.

2. **Ban/reduce a specific crutch word** · "just", "really", "very", "that", "suddenly", "seemed", "started to", "a bit". The single most concrete instruction writers issue; whole books exist on "weasel words".
   - "stop using the word 'just'"
   - "cut every 'suddenly'"
   - "get rid of the 'that's that aren't needed"
   - "she shrugs too much, cut the shrugging"
   - **DET**: target-token count in output = 0 (or ≤k). One of the cleanest gates you can build.

3. **Remove filter words** (saw/heard/felt/noticed/watched/realized/wondered/seemed) · canonical self-editing item, on every checklist (Wattpad, AutoCrit, craft blogs).
   - "remove the filter words"
   - "cut 'she felt' and 'he saw', just show the thing directly"
   - "de-filter this, it's deep POV"
   - **DET-PROXY**: filter-word list count must drop to ~0; the rewritten direct perception is soft, but a residual-count gate plus length-drift bound covers most of it.

4. **Show, don't tell / make it more sensory-descriptive** · two of Sudowrite's six presets (Show Not Tell, More Descriptive) plus its whole Describe tool; PWA Sensory report; every checklist.
   - "show her fear instead of naming it"
   - "make this more visceral, what does the room smell like"
   - "stop telling me he's angry"
   - **SOFT** mostly. Weak proxies: named-emotion word list ("felt sad", "was angry") count should drop; length should grow; concrete-noun/sense-word density up. Gate on the emotion-label list + length band, judge the rest.

5. **Tighten: cut filler/glue words and redundancies** (distinct from "make it shorter" · the ask is remove the padding, keep the content) · PWA Sticky Sentences (glue-word ratio >45%), AutoCrit filler report, Hemingway's whole premise.
   - "cut the throat-clearing"
   - "this is flabby, trim the deadwood but don't lose anything"
   - "remove redundant pairs like 'nodded his head'"
   - **DET-PROXY**: glue-word ratio (of/that/just/there was/in order to...) must fall; word count down but bounded (e.g. 60–90% of original); redundant-pair list count → 0.

### Tier 2 · very common (dedicated reports in tools, constant checklist items)

6. **Adverb purge / stronger verbs** · AutoCrit adverb reports, PWA Writing Style, Marlowe adverb stats, "spoke quietly → whispered".
   - "cut the -ly adverbs and use stronger verbs"
   - "no adverbs in dialogue tags"
   - **DET-PROXY**: -ly token count (minus whitelist: only, family, early...) below threshold; adverb-adjacent-to-tag pattern count = 0.

7. **Passive → active voice** · PWA, AutoCrit, Hemingway one-click fix.
   - "make this active voice"
   - "too many 'was's, rewrite around them"
   - **DET-PROXY**: be-verb + past-participle regex/POS count down to threshold; "was/were" density down.

8. **Vary sentence openings** · PWA Writing Style flags "repeated sentence starts", Pronoun report flags >30% sentence-initial pronouns; extremely common complaint ("every sentence starts with She").
   - "vary the sentence openings, everything starts with 'She'"
   - "too many sentences start with 'I' in a row"
   - "stop opening with participial phrases ('Walking to the door, ...')"
   - **DET**: max run of same sentence-initial token; % sentences starting with a pronoun; count of sentence-initial -ing openings. Fully countable.

9. **Vary sentence length/rhythm** · PWA Sentence Length report, AutoCrit Pacing & Momentum (sentence variation), "read-aloud" checklist advice.
   - "these are all the same length, break up the rhythm"
   - "too choppy, combine some of these"
   - "give me one short punchy sentence at the end"
   - **DET**: sentence-length variance/stddev, longest monotone run, presence of a ≤5-word sentence, etc.

10. **Dialogue-tag cleanup** · AutoCrit's flagship report; PWA Dialogue Tags check.
    - "replace the fancy tags with 'said'"
    - "cut the tags where it's obvious who's talking"
    - "turn some of these tags into action beats"
    - **DET-PROXY**: said-bookism list (exclaimed, retorted, guffawed...) count → 0; tag density per dialogue line; tag+adverb pattern = 0. Which tags to keep is mildly soft.

11. **Tense fixes and tense conversion** · checklist staple ("review all verbs for tense consistency"); conversion (present→past for a whole draft) is a recurring community project.
    - "change this to past tense"
    - "I keep slipping into present tense, fix the slips"
    - "convert to present tense but leave the dialogue alone"
    - **DET-PROXY**: present-tense marker counts (is/are/says/3rd-sg -s verbs) vs past markers outside quoted spans; direction of the ratio is decisive. Irregulars need a POS heuristic but this gates well.

12. **POV conversion and POV-slip repair** · Sudowrite documents users typing exactly this ("be in first person", "be in third person with name James"); head-hopping/POV-slip is a top checklist item; whole-novel 1st↔3rd conversions are a known community rite.
    - "third person to first person"
    - "rewrite in third limited, her name is Mara"
    - "fix the head-hop in the middle, we're in Jake's POV"
    - **DET-PROXY**: outside quoted spans, first-person pronoun count must be ~0 (for →3rd) or dominant (for →1st); named-character-as-subject appears (for →3rd with name). Quote-aware counting is essential. Slip *detection* is countable; whether interiority survived is soft.

### Tier 3 · common, concrete, high-value for a selection tool

13. **Rename a character / name↔pronoun balance** · Scrivener forums are full of "change a character's name globally" threads (Project Replace, whole-word caveats, possessives); the selection-scoped versions are the pronoun-balance asks.
    - "she's called Maren now, not Sarah"
    - "replace the name with a pronoun, I say 'Elias' five times here"
    - "too many 'she's, I can't tell who's who · use their names where it's ambiguous"
    - **DET** for renaming: old-name count = 0 (incl. possessive 'Sarah's'), new name present, everything else byte-identical (this is your strongest gate: diff-locality). **DET-PROXY** for name/pronoun balance: name-occurrence count moves the required direction; antecedent clarity is soft.

14. **Dialogue voice/register restyle** · huge in AI-tool usage: age, class, era, formality.
    - "make the dialogue sound like a teenager"
    - "he's a Victorian butler, make him talk like one"
    - "her lines are too formal, use contractions"
    - "make this exchange feel natural · incomplete sentences, interruptions"
    - **SOFT** mostly. Countable slivers: contraction count inside quotes up ("do not"→"don't" = countable), banned-vocab list for period pieces (anachronism word list), only quoted spans changed (DET diff check).

15. **Add dialogue beats / ground "talking heads"** · a named craft problem with an entire advice literature; Sudowrite users type "add more dialogue" for the inverse.
    - "add a beat between these lines, it's floating heads"
    - "ground this in the room, they've been talking for a page with no action"
    - "break up this speech with some business"
    - **DET-PROXY**: max run of consecutive quoted-only paragraphs must drop; narration:dialogue character ratio moves; original dialogue lines preserved verbatim (DET). Beat quality is soft.

16. **Continuity/fact patch within the passage** · the "she's holding a knife not a gun" class; AI continuity checking (eye color, held objects, timeline) is an actively marketed feature (Sudowrite Chapter Continuity, dedicated startups).
    - "she's holding a knife, not a gun · fix it through the scene"
    - "his eyes are green, I wrote brown here"
    - "it's morning in this scene, not night"
    - "she already knows his name by this chapter"
    - **DET-PROXY**, often near-DET: wrong-fact token absent, correct-fact token present, diff confined to relevant sentences. Ripple effects (a later line that only makes sense with the gun) are soft but rare within one selection.

17. **Tone/mood restyle of narration** · the top documented Sudowrite custom asks: "be more ominous", "make this really dark and foreboding", "be more quirky", plus "More Intense" as a preset.
    - "make this more ominous"
    - "lighten this up, it reads grimmer than I want"
    - "amp up the tension in the last paragraph"
    - **SOFT**. Gate only on invariants: length band, names unchanged, dialogue unchanged if asked, plot facts (object/actor list) preserved.

18. **More interiority / inner conflict** · a Sudowrite preset (More Inner Conflict), so demand is proven.
    - "add more of her inner conflict here"
    - "what is he thinking during this? give me some interiority"
    - **SOFT**; proxies: length up, first-person-thought or free-indirect markers appear. Mostly judge.

19. **Cliché and redundancy removal** · PWA Clichés & Redundancies report, Marlowe cliché count, AutoCrit checklist.
    - "cut the clichés"
    - "'heart pounding out of her chest' · replace with something fresher"
    - **DET-PROXY**: cliché-phrase list count → 0; freshness of replacement is soft.

20. **Unstick/rephrase one sentence** · Sudowrite's Rephrase preset exists for this; line-edit guides show "before/after of what can be trimmed" asks.
    - "this sentence is clunky, unstick it"
    - "give me three ways to say this"
    - "smooth the transition between these two paragraphs"
    - **SOFT** on quality; DET on scope (only the flagged sentence changed · diff-locality gate) and on n-alternatives-returned.

## Checkability summary for your harness

- **Cleanest DET gates**: banned-word count (crutch words, "suddenly", filter-word list), rename (old=0/new>0 + rest byte-identical), sentence-opening runs, sentence-length variance, contraction conversion in quotes, dialogue-preserved-verbatim constraint, diff-locality ("only change X"), length-ratio bands, quoted/narration character ratio, em-dash count.
- **Strong DET-PROXY gates**: tense-marker ratios and POV-pronoun ratios computed *outside quoted spans* (quote-aware tokenization is the single most reusable primitive you can build), -ly counts with whitelist, be+participle passive count, glue-word ratio, said-bookism list, cliché list, consecutive-quoted-paragraph runs.
- **Judge-only (gate invariants, not the goal)**: show-don't-tell, tone/mood, voice/register, interiority, "make it flow". For these, gate what must NOT change (names, facts, dialogue spans, length band) and score the rest softly.
- A recurring writer-attached **constraint** worth first-class support: "keep my wording where possible", "don't touch the dialogue", "keep it the same length" · all DET (edit distance, quoted-span identity, length band).

## Long tail (rarer but real)

- "Remove all the em dashes" / "make it sound less like AI wrote it" (kill "tapestry", "testament to", rule-of-three sentences) · rapidly growing ask. DET for the token/phrase lists.
- Gender-swap a character (he→she through the passage, incl. himself/his) · DET-PROXY, referent disambiguation needed.
- Americanize/Britishize spelling and vocab ("colour→color", "jumper→sweater") · DET.
- "Remove the profanity" / "make it PG" · DET-PROXY (swear list = 0; substitution quality soft).
- Convert internal thought to italics convention (or remove "he thought" tags) · DET-PROXY.
- Strip epithets ("the tall man", "the blonde") back to names/pronouns · DET-PROXY.
- "Cut the 'started to/began to' constructions" · DET.
- Dialogue punctuation mechanics: comma before the tag, lowercase tag, punctuation inside quotes · DET (regex).
- Anachronism sweep for period fiction ("no 'okay' in 1850") · DET against a word list.
- De-purple ("tone down the flowery prose", fewer adjectives per noun) · DET-PROXY (adjective density).
- Alliteration removal, accidental rhyme/homophone fixes (PWA has literal reports for these) · DET-PROXY.
- "Too many sentences of dialogue start with 'So'/'Well'" · DET.
- Reading-level shift ("simpler words, this is middle grade") · DET-PROXY (syllable/grade-level score band).
- Anonymize a passage for sharing (swap all names for placeholders) · DET.
- "Combine these two paragraphs" / "split this paragraph" · DET (paragraph count).
- Smart-quote/ellipsis/dash normalization · DET.
- "Remove the second character's POV lines entirely" · DET-PROXY.

Sources: [Sudowrite Rewrite docs](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/rewrite/9hkeezeUsCiUCG4dRdEqjS), [Sudowrite Features](https://docs.sudowrite.com/getting-started/dQph1snuwbfMWG9wRjsNug/features/dq7YUMNy5ZMvKUJiRAisyT), [ProWritingAid 25 reports](https://medium.com/personal-growth/what-are-the-25-writing-reports-in-this-editing-tool-anyway-e569fd0e167d), [PWA writing reports](https://prowritingaid.com/features/writing-reports), [AutoCrit self-editing checklist](https://www.autocrit.com/self-editing-fiction-writers/), [AutoCrit dialogue tags](https://www.autocrit.com/editing/support/dialogue-tags/), [Hemingway Editor Plus](https://hemingwayapp.com/hemingway-editor-plus), [Marlowe Basic](https://authors.ai/marlowe-basic/), [Wattpad self-editing checklist](https://creators.wattpad.com/writing-resources/sentence-and-scene-structure/self-editing-checklist/), [Scrivener rename threads](https://forum.literatureandlatte.com/t/changing-characters-name-globally-in-my-manuscript/143908), [ChatGPT line-editing prompts](https://zane.substack.com/p/chatgpt-speeds-up-line-editing), [Edit with ChatGPT](https://inkshift.io/resources/edit-with-chatgpt), [Humanize AI fiction prompts](https://www.creativindie.com/how-to-humanize-chatgpt-written-content-for-better-fiction-and-to-pass-ai-detection/), [Weasel words](https://melissajagears.com/weasel-words/), [Talking heads fix](https://www.septembercfawkes.com/2024/03/how-to-fix-talking-heads-in-your-story.html), [AI continuity checking](https://epos-ai.ch/en/blog/ai-manuscript-continuity-check.html), [Sudowrite dialogue guide](https://sudowrite.com/blog/best-ai-for-dialogue-writing-make-characters-sound-human/), [Sudowrite Chapter Continuity](https://sudowrite.com/blog/how-to-avoid-plot-holes/)