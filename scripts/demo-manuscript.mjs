/* ─────────────────────────────────────────────────────────────────────────
   The demo manuscript used for product shots.

   Written for the CAPTURE, not for the reader: it exists to give the analysis
   layer something worth marking up. That means, deliberately —

     · a large cast. Nine named speakers, so the speaker palette actually
       spreads across its ten hues instead of showing two blues. A shot with
       two characters in it makes the highlight layer look like bold-and-
       italic; a shot with nine makes it look like what it is.
     · dialogue that varies in how ATTRIBUTABLE it is. Some lines carry an
       explicit "X said", some are carried by turn-taking alone, some are
       genuinely ambiguous. That is what puts all three confidence bands on
       screen at once, which is the honest picture.
     · named places and factions, so entity marks appear alongside speaker
       marks and the two read as different things.
     · chapters with different jobs — a quiet one, a turn, a confrontation —
       so the story graph classifies them differently rather than drawing a
       flat line of twelve identical beats.

   The names match the world already used in the app's own sample content, so
   captures taken months apart stay recognisably the same book.
   ───────────────────────────────────────────────────────────────────────── */

export const CAST = [
  { name: "Kinoko", role: "protagonist" },
  { name: "Riven", role: "mentor" },
  { name: "Kel", role: "ally" },
  { name: "Vey", role: "antagonist" },
  { name: "Anwen", role: "ally" },
  { name: "Mira", role: "supporting" },
  { name: "Caud", role: "supporting" },
  { name: "Dowsa", role: "supporting" },
  { name: "Ifian", role: "supporting" },
];

export const PLACES = [
  { name: "the Middle Ring", type: "district" },
  { name: "Mosswell", type: "town" },
  { name: "the Vell house", type: "building" },
  { name: "the flour-shed", type: "building" },
  { name: "the candle-maker's roof", type: "location" },
];

export const FACTIONS = [
  { name: "the Compendium", type: "institution" },
  { name: "the Ring Authority", type: "institution" },
];

const CH = (number, title, content) => ({
  id: `ch${String(number).padStart(3, "0")}`,
  number,
  title,
  content: content.trim(),
});

export const CHAPTERS = [
  CH(19, "A Name Given", `
Mira came up the stair first because she always did, and because Kinoko had
learned not to argue about the order of things that did not matter.

"You could let me go first once," Kinoko said.

"You could be faster," said Mira.

The landing smelled of wet stone. Someone below them was burning something
that was not wood. Kinoko put her hand flat against the wall the way Riven had
shown her and waited for the building to tell her whether it was empty.

"Anything?" Mira said.

"Not yet."

They went up. On the fourth landing a woman was sitting on the top step with a
book open on her knees, and she did not move when they came up, and she did not
look up either.

"You are late," the woman said.

"We were careful," Kinoko said.

"Those are not opposites." She closed the book on her finger. "Kel. Since
nobody is going to say it."

Kinoko had not known there was a name to be given. That was the thing about
Riven's people — they arrived already knowing what you had been told, and they
never once explained who had told them.

"Kinoko," she said.

"I know," said Kel.
`),

  CH(20, "The Rope and the Ledger", `
The Compendium kept its ledgers in a room with no windows, which Caud said was
about damp and Anwen said was about witnesses.

"It is about damp," Caud said again.

"You have never once been right about a room," said Anwen.

Kel had the rope over her shoulder and was not participating. She had a way of
not participating that made the argument feel smaller.

"Both of you," Kinoko said.

They went quiet. That was new. A month ago neither of them would have stopped
for her, and she noticed it happening and decided not to look at it directly,
the way you do not look directly at a thing that might turn out to be luck.

Anwen found the entry first. She read it twice and then read it aloud, and her
voice did the thing voices do when the reader has understood a sentence before
the listeners have.

"It is dated after," she said.

"After what?" said Caud.

"After he was supposed to have stopped."
`),

  CH(21, "A Lesson About Surveillance", `
Riven met them on the candle-maker's roof. He was already up when they arrived —
Kinoko and Kel climbing the building's back stair in the last light of the
afternoon, the stair's wood complaining at the third step and the seventh in its
familiar sequence. Riven was standing at the rooftop's edge with his coat collar
turned up and the red compendium under his arm, looking east toward the Middle
Ring's skyline and the transit cables. He looked at Kel when they came up
through the hatch.

"She's staying?" he said.

"I asked her," Kinoko said.

He looked at Kel for another moment. Kel looked back at him with the focused
attention she brought to anything she had decided deserved it — the market's
pricing logic, Mer's transit delays, the book-stall woman's system for shelving
fiction — which was the attention of someone taking accurate inventory. She did
not fill the silence with anything. He looked away first.

"All right," he said.

The rooftop was a working surface: the solar-dry racks folded against the near
wall, a cistern, and the low parapet where the candle-maker's apprentice sat to
eat. Riven put the compendium down on the parapet and did not open it.

"Tell me what you saw on the way here," he said.

"Two watchers on the Ring stair," said Kel.

"Three," Kinoko said.

Riven did not correct either of them. That was the lesson, and it took Kinoko
another year to notice that he had taught it without saying anything at all.
`),

  CH(22, "The Tower Flags", `
The recording arrived on Calwyn's desk in the ordinary way, which was itself
the first strange thing about it.

Caud set it there — the small resonance cylinder the surveillance department
produced when a conversation had been marked for review by someone above the
department's own grade. There was a slip of summary paper beneath it, the
Compendium's own form, forty words or fewer on the left and the disposition
notation on the right.

Dowsa did not pick up the cylinder. He read the slip the way he read everything,
completely, in order, from the date to the bottom, without skipping the
self-explanatory sections.

"Who marked it?" he said.

"It doesn't say," said Caud.

"It always says."

Caud did not have an answer for that, and the not-having showed on him, and
Dowsa watched it show and then let him keep it.
`),

  CH(23, "The Brother", `
Ifian asked to use the table in the third week of autumn. Not to sleep in — he
had the room above the flour-shed, the corner room where you could hear the wood
settling through the floor on cold nights. What he wanted was a place to write
that could be left between sessions without needing to be cleared.

"You can have the spare room," Dowsa said.

"I don't need the room. I need the table."

"You can have the table in the room."

Ifian considered this the way he considered everything, which was slowly and
with his whole face, and then he laughed once, and Dowsa remembered later that
it was the last easy sound his brother made in that house.

Vey came the following week. Nobody had invited her.
`),

  CH(25, "The Safe-House Block", `
The block had been a laundry and still smelled like one in the mornings.

"You are certain about the door," Kel said.

"I am certain about the hinge," said Anwen. "The door is a separate question."

Mira came back from the corner with her hands in her sleeves. "Two on the
stair. Neither of them looking up."

"That is worse," Kinoko said.

"That is worse," Riven agreed.

They waited. The waiting was the part nobody wrote down afterwards, and it was
most of it.
`),

  CH(26, "The Listening Room", `
Caud had built the listening room himself, over four months, and he described
it to anyone who would stand still.

"The trick is the second wall," he said.

"You have told me about the second wall," said Dowsa.

"I have told you the fact of the second wall. I have not told you the reason."

Dowsa sat down, because it was going to take a while, and because his brother
had built the room and he had not been asked and he had decided not to mind.
`),

  CH(27, "A Family Dinner", `
Vey brought wine, which nobody had asked her to do, and set it on the table
where the light would catch it.

"Sit anywhere," Ifian said.

"I know where I sit," said Vey.

Anwen looked at Kinoko across the table and did not change her expression at
all, which was itself the message.

"How long have you two known each other?" Mira said.

Nobody answered. The pot on the stove reached the sound it made before boiling,
and Ifian got up to deal with it, and by the time he sat back down the question
had been allowed to expire.
`),

  CH(28, "The Diagnosis", `
"Say the number," Riven said.

Kel said the number.

Riven put both hands flat on the table and looked at them for a while, and when
he looked up his face had gone somewhere the others had not been invited.

"Again," he said.

"It will be the same number."

"Say it again."
`),

  CH(29, "The Lintel", `
There was a carving on the lintel of the Vell house that nobody in the Vell
house could read.

Mira traced it with one finger. "It is not decorative."

"Everything is decorative eventually," said Caud.

"That is the stupidest thing you have ever said," Anwen said, "and I want you
to know that I have been keeping a list."
`),

  CH(30, "A Visitor From the Road", `
He came from the south on a grey October afternoon — the sky low and even grey,
not raining yet but with the smell of rain in it, the air carrying the specific
cold of a season that had committed to its direction. The road from the south
ran along the valley's eastern edge before it descended into the valley proper,
and she could see a stretch of it from her window through the thinning trees.

She saw him on the road before he reached the valley.

A man alone, on foot, with a walking staff and a pack. He walked at the pace of
someone who had been walking a long time and had settled into the pace that
would carry him as far as he needed to go — not fast, not laboured, but steady,
the pace of a man who had made himself walk like this and had found the rhythm
comfortable in the way that a rhythm became comfortable when you had been
holding it for weeks. He was not a young man.
`),

  CH(31, "The Mosswell House", `
"You will want the back room," Dowsa said.

"I will want whatever you are offering," said the man.

"That is not the same thing."

"No," he agreed, "but it is the more useful answer."

Dowsa found that he liked him, and distrusted the liking, and let him have the
back room anyway.
`),

  CH(32, "The First Spring", `
Kinoko learned the names of eleven streets that spring and forgot four of them
by the following winter, and the four she forgot were the four Riven had told
her twice.

"You are not listening," he said.

"I am listening. I am not remembering."

"Those are the same failure at different speeds."
`),

  CH(33, "Two Terms", `
"Two terms," Vey said. "Since the autumn."

Anwen did not look up from the ledger. "And you are telling me now."

"I am telling you now."

"Why now?"

Vey did not answer, and the not-answering went on long enough that Anwen finally
did look up, and what she saw made her close the ledger.
`),

  CH(34, "The Rice Stall", `
"I work at the rice stall in the lower market," the woman said. "I have worked
there eleven years. I am telling you this so you understand that I know what a
regular customer looks like, and that man was not one."

Kel wrote it down.

"Do you want the rest of it?" said the woman.

"I want all of it."
`),

  CH(35, "Dowsa's Debt", `
"You are going to tell me it was necessary," Vey said.

Dowsa said nothing.

"You are going to tell me it was necessary and I am going to tell you that
necessary is a word people use after."

"It was necessary."

"After," she said.

The fire had gone down to the point where it was giving light instead of heat.
Anwen was in the doorway and had been for long enough that neither of them could
pretend she had just arrived.

"Say the rest of it," Anwen said.

Vey turned. "Which rest?"

"The part where you tell him what you did."
`),

  CH(36, "The Light Through the Window", `
Afterwards there was the ordinary business of a house in the morning, which
nobody had expected to still be there and which was there anyway.

Mira filled the kettle. Caud moved the chairs back without being asked. Kel
stood at the window with her arms folded and watched the lane, because that was
what she did with a morning.

"He will not come back," Kinoko said.

"No," said Riven.

"You could sound less certain."

"I could," he agreed, and did not.

The light through the window was the flat early light that made the room look
like a drawing of itself. Anwen came down last, and stopped on the bottom stair,
and looked at all of them for a moment before she said anything at all.

"Well," she said. "That is one thing settled."
`),
];

/** The novel, exactly in the shape src/lib/storage.ts persists. */
export const NOVEL = {
  meta: {
    title: "The Middle Ring",
    subtitle: "Book One",
    author: "K. Pie",
    description: "A demo manuscript used for product captures.",
  },
  chapters: CHAPTERS,
  worldData: {
    characters: CAST,
    places: PLACES,
    factions: FACTIONS,
    entities: [],
    // Skip the cold-start cast confirmation, which would otherwise sit over
    // the editor in every capture.
    castReviewed: true,
  },
};
