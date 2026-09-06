## HERO Initiative Manager

You are a web development expert. You are designing a new web application. This
document explains the requirements that must be adhered to.

## Architecture & Design

* The app must be authored in JavaScript or something that transpiles to
  JavaScript. Prefer bun over node.

* Use SQLite for local storage.

* Use Tailwind for styling, with daisyUI on top of it for components and for
  colour. Every colour in the app is one of daisyUI's semantic tokens —
  `base-100`, `base-content`, `primary`, `error` and their neighbours — resolved
  by whichever theme is active; nothing names a palette shade of its own, and
  nothing carries a hand-written dark-mode twin. Always offer light and dark
  mode for visual elements: daisyUI's stock `winter` and `night`. Every page
  carries the light/dark/system control, so the choice can be made or changed
  wherever the reader happens to be.

* Make good use of the screen. A page always takes the full width of the window
  it is in: never a centred column with empty glass either side of it, and never
  a scrollbar inside a panel that had room to be wider. On a wide, short screen —
  a 16:9 monitor — a page should fill one viewport with its panels side by side,
  each scrolling its own content, rather than stacking them into a page that
  scrolls as a whole. Narrow or tall screens keep the stacked layout. Where cards
  sit side by side with another panel, as the campaigns do, the panel holding
  them is no wider than the whole number of cards it can show — never part of a
  further column — and the panel beside it takes the room that leaves. That is a
  starting point rather than a rule: where panels sit side by side the boundary
  between them can be dragged, with a pointer or from the keyboard, to whatever
  balance the reader wants, and neither panel can be crushed narrower than one
  whole card. The width they choose lasts for the visit rather than being
  remembered, and handing the boundary back — a double-click on it — restores the
  automatic fit.

* Wherever characters are listed by name — the library, the roster a session
  opens with, the list a player picks their character from — a name is filed
  under its first real word: a leading "The" is not what decides where it lands,
  so "The Crimson Fist" is found with the Cs rather than in a drift of Ts. Only
  the leading one, and only as a whole word: "Sword of the Morning" is filed
  under S, and nobody called Theodore is filed under A. Case never decides an
  order. Two names that file in the same place still come out the same way every
  time.

* How large a card's picture is drawn is a deployment setting, not a constant in
  the code. It measures the picture: the card comes out larger, since its border
  and the name underneath are extra. The size is a ceiling. A card is never drawn
  larger than it, however much room a column has — a narrow window shows fewer
  cards rather than bigger ones — and it is drawn smaller only where a card at
  that size would not fit the column at all. Changing the size re-fits every
  panel measured in cards, at once.

* A character sheet is shown as it was written: it opens over the page in the
  window's own aspect ratio, with nothing drawn around it — no title, no border,
  no margin — save the control that closes it. How much of the window it takes is
  a deployment setting; by default it is most of it, leaving the page dimmed
  around the edges.

* A card in a library carries the proportions of a playing card: five wide by
  seven tall, the top five of those sevens its picture as a square and the bottom
  two the strip carrying its name, with a character's kind — player character or
  not — named at that strip's upper right rather than over the picture. A card is
  printed in a frame — the same one wherever a character card appears, whether the
  game master is looking at their library or a player is choosing who to play —
  with its picture showing
  through the frame's window and its name drawn on the panel the frame paints. The
  frame is one piece of artwork rather than a light and a dark version of itself,
  since it is painted card stock; the name on it is drawn in the light theme's ink
  in either theme, because the panel it sits on is pale in both, so it is legible
  either way. The typeface a card's name is set in is a deployment setting,
  since a display face suits a card in a way the interface font does not; unset,
  the name is drawn in the interface font like everything else. A campaign card
  is framed in artwork of its own rather than the character frame, which is one of
  the ways the two
  kinds tell themselves apart. A card's controls are icons stacked into the upper
  right of its picture, inside the frame's window and drawn the same way on both
  kinds of card: edit and delete, and on a character card an icon that opens its
  sheet. A name too long for its panel is cut short rather than allowed to make
  the card taller, and it is centred on the panel, both ways.
  Cards must come out the same size as each other whatever the length of the name
  they carry, and in every library. They must show a clear highlight when
  hovered, and give the same feedback to anyone arriving by keyboard rather than
  mouse. A card tilts towards the pointer as it is hovered, so it reads as an
  object being handled rather than a picture on a page, and its picture catches
  the light where the pointer is, so the thing being handled reads as a glossy
  object rather than a matte one. A player character's picture is printed on foil:
  a faint sheet of rainbow lies over it at rest and drifts across it as the card
  turns, so the card reads as a holographic one rather than as plain card stock.
  The foil bends the picture's colour without flattening it — what is dark in the
  photograph stays dark. Only a player character's card is printed this way. An
  NPC's and a campaign's are plain stock — they tilt and catch the light like any
  other card, but no rainbow lies over them — so the foil is one more way the
  kinds of card tell themselves apart, alongside the artwork they are framed in. How brightly a card does all of this is a single deployment setting, since
  it depends on the artwork a table uses, and it can be turned off. The
  light and the foil stay on the picture and off the name, whose contrast must not
  be touched by them. A reader who has asked for less motion is neither tilted at
  nor shone at, and keeps the hover highlight on its own, along with the foil,
  held still.

* A character's kind can be set from the card itself, without opening anything:
  with the reader on a card in the library — the pointer over it, or the keyboard
  focused on it — `P` makes that character a player character and `N` makes it a
  non-player character. A key typed into a field is text, not a command, and no
  hot key fires while a dialog is open. The card redrawing itself in the other
  kind's frame is the whole of the answer: a change made this way announces
  nothing, since the reader is already looking at the thing that changed. A
  failure is still reported, because that is the case where nothing else moves.

* Pressing a card anywhere does the card's own thing: selecting a campaign,
  turning a character's card over. Its corner controls stay reachable over the
  top of that, and remain reachable however the card is animated — except while a
  card is showing its back, since they are printed on the face that has turned
  away.

* A character's card in the library has a back, and pressing the card turns it
  over as an object being turned over rather than a picture being swapped.
  Printed on it: the character's characteristics, in the frame's window where the
  picture is on the front, and the character's name where it always is — a shelf
  of turned-over cards is still a shelf somebody can read. The back is printed
  stock like the front, not a blank panel, and the numbers on it are set in the
  same face, weight and ink as the name, since they are the only type a card
  carries. It is the library's
  alone. Where a character's card appears beside those same numbers, as it does
  in a session, the card has no back: turning it over would hide the picture to
  say something the screen is already saying. Which way up a card is must be
  legible to somebody who cannot see it turn.

* Icons come from one published set rather than being drawn per control or typed
  as text symbols, so they match each other and render the same everywhere. An
  icon is never the only thing saying what a control does: it carries a label a
  screen reader can read, and a control that pairs an icon with a word keeps the
  word.

* A question asked before something irreversible is the app's own dialog, drawn
  like every other: `window.confirm` is never used, because the browser draws it
  in its own chrome and it ignores the theme and the palette entirely. The button
  that goes through with it names the action rather than saying "OK", so it still
  says what will happen when read on its own, and the question can be refused
  with Escape or the close control as well as with Cancel.
  The one native dialog left is `window.prompt`, as the fallback when the browser
  refuses clipboard access and the text has to be offered for copying by hand.

* Observe OWASP Top Ten guidelines.

* Observe best practices for modern web development.

* All error messages should be user-friendly.

* Implement consistent logging to aid debugging.

## Terms

We define the following terms.

### Game Master

A game master or GM is an administrative user. They authenticate with email and
password and have read/write access to make changes.

### Player

A player is a non-administrative user. Players authenticate with a session code
and are read-only.

### Character

A character is a fictional persona in the game. There are two types of
characters:

#### Player Character

A player character or PC is a persona played by a player.

#### Non-Player Character

A non-player character or NPC is a persona played by the game master.

### Session

A session is a single continuous sitting of a game that might last a few hours.

### Campaign

A campaign is a connected series of sessions that share a arcing story.

## Features

The app should have the following features:

* All pages must be inaccessible publicly. Game masters must authenticate with
  email and password, and players must authenticate with a session code.
  The sign-in page puts the cursor in the first field the person arriving still
  has to fill in: the session code, or the player's name when a join link has
  already supplied the code, and the email address on the game master's tab.

* Create a CLI to add, edit, and delete game master accounts. There will be no
  UI for account management.

* A game master may create, edit, and delete campaigns. Each campaign must have
  a unique name. Each campaign may have a card image. Present the campaign
  library as cards.

* A game master may add, edit, and delete PCs and NPCs. These are represented by
  HTML file uploads. Each PC and NPC must be categorized into one campaign. Each
  PC and NPC may have a card image. Either file may be chosen with the file
  picker or dropped onto its field; sheets may also be dropped anywhere on the
  character panel, which files each of them as a PC of the selected campaign at
  once, without a dialog, named after its file; and an image may be
  dropped straight onto a card — a campaign's or a character's — which becomes
  that card's picture at once, without a dialog. The add and edit form
  asks for the sheet first, then the name, the type, the campaign, and the image. Uploading a sheet
  fills the name in from the file's name, minus its extension, unless the game
  master has typed a name of their own. Pictures — a campaign's, a character's,
  and one found inside a sheet alike — are scaled down on the way in to the size
  the cards show them at, in proportion and without cropping. An uploaded sheet
  is also scanned for a portrait: if it carries one, and the character has no picture of its own, that
  becomes the character's image, and that picture's bytes are removed from the
  stored sheet, since the card is now the copy that is kept. A picture the game
  master chose is never replaced by one found in a file. Both edit forms offer `Remove the current card
  image` when there is one, which empties the picture; uploading an image in the
  same submission wins over ticking it. Present the character library as cards,
  ordered by name whatever their kind.
  A character may be refiled into another campaign by dragging its card onto that
  campaign's card. A character playing in a session that is still running may not
  be moved until that session ends, and may not be deleted at all: deleting would
  take them off the stage mid-fight with the players watching them vanish. Taking
  them off the stage is enough to free them, since the rule is about being in play
  rather than about the campaign being busy — an ended session holds nothing back.

* A game master may start a new session on a campaign that has none running.
  Every PC in the campaign joins the new session automatically, in name order; the NPCs stay in the library until the
  scene calls for them. This generates a unique unguessable code. Provide a means to copy the code (and the URL target that receives the
  code) to the clipboard so that the GM can easily send session invites to
  players. Once the players receive the code, they may use it to authenticate
  and join the session.

* The game master may indicate which characters from the library are active in
  the current session. These characters will be visible to the players that
  join.

* A game master may end a running session. Once the session is ended, the code
  should no longer work. It can be ended from its own console or straight from the
  library's list of sessions in progress, without opening the console first. Either
  way it asks before doing it, and the library's question names the campaign, since
  more than one session may be listed.

* The game master's library lists the sessions in progress in campaign name
  order, each with the turn it has reached and how many players have joined.
  Both update live as players join or leave, without the game master reloading
  the page. The list itself is live too: a session started or ended elsewhere —
  another tab, another device — appears or disappears on its own.

* Multiple sessions should be able to be active at the same time, but only one
  per campaign. Starting a second session on a campaign that is already playing
  must be refused; the game master ends the first one to start another.

* When a player joins a session, they should be prompted for their name. Ensure
  that names are unique in a session. They should also be presented with a list
  of the active PCs that the GM has placed in this session, in name order, as
  cards of the same size and shape as the library's. From this list, they may choose one PC to
  play. This PC to player association must be maintained as
  long as the player stays in the session.

* A player who closes their browser leaves the session: their seat is given up
  and their PC becomes free for someone else to claim. A brief disconnection —
  a reload, a flaky connection, a phone locking itself — must not count as
  leaving, so this only takes effect after a grace period.

* An active PC that no player has claimed should be highlighted in an alert
  colour on the session page, so that both the game master and the players can
  see at a glance which characters are still free. The cue must not rely on
  colour alone.

* A player's session page is headed by the campaign, as the game master's
  console is. Who the player is and which character they hold are on their own
  panel below, so the heading is not spent repeating them.

* Once a session is joined, players should see four panels: the turn, their own
  character, a list of all the joined players, and a list of all active PCs and
  NPCs. For the PCs, that last list should include which player is associated.
  No row in it offers to open a sheet; a player reaches their own through a
  single `My sheet` control on their `My character` panel, and no other sheet is
  theirs to open.

* A player's own character panel carries the five characteristics that are looked
  up rather than spent — SPD, DEX, INIT, CON and REC — on one line under the name,
  with what they have left of ENDURANCE, STUN and BODY below it.

* Nothing in that panel wraps. It is one character's line of numbers, and a row
  folded in half reads at a glance as two characters; where
  the screen is too narrow to hold the line, the numbers themselves draw a little
  tighter, and a name too long for the panel is cut short rather than wrapped —
  the whole of it heads the page anyway. Narrower than even that will hold — a
  reader may drag this column as narrow as they like — the line of numbers is
  pushed sideways to read the end of, and stays inside its panel rather than
  spilling over what is beside it.

* The session code, the two ways of handing it out and the control that ends the
  session share a panel of their own, at the top of the column the players are
  in. They belong together — ending the session is what stops the code working —
  and the panel carries no heading, since a code with copy buttons beside it says
  what it is.

* That leaves the page header holding what this page can open, where you are, and
  how you look at it: the log and the way back to the library on one side, the
  campaign's name in the middle, and the light/dark control and `Sign out` on the
  other. Signing out is in the header rather than beside the code because it is
  about this browser and nobody else's — the session goes on running, the code
  goes on working, and the game master can come back to it. Ending the session
  is the opposite of all three, which is why it sits down in the panel with the
  code it revokes.

* No panel on the session console is stretched to fill the screen either, and
  the turn sits above the segment panel and shares its width — it is the same
  fight. Where the screen is a dashboard the console is three equal columns: the
  turn over the segment panel, then the library the GM adds from, then the
  code over the players. Narrower, it is two equal halves: the turn over the
  segment panel on one side, the code, the players and the library on the
  other. Narrower still, one column, with the code first — it is the first thing
  a game master needs. Equal is where the columns start rather than where they
  must stay: on both layouts that have more than one, the boundary between two
  columns can be dragged to whatever balance the reader wants, as it can on the
  library screen, and the same rules hold — no column crushed away to nothing, the
  choice lasting for the visit rather than being remembered, and handing a
  boundary back restoring the share it began with.

* No panel on a player's session page is stretched to fill the screen: each is
  only as tall as what it holds. Where the screen is wide enough for two columns,
  the turn, the player's own character and the list of players sit in the first
  column — so the turn is the width of the player list rather than of the page —
  and the scene sits in the second. Stacked, the order is the turn, their
  character, the scene, then the players. Where the two columns exist, the
  boundary between them is draggable in exactly the way the console's and the
  library's are, and under the same rules: neither column crushed away to
  nothing, the choice lasting for the visit rather than being remembered, and
  handing the boundary back restoring the share it began with.

* Both session screens carry a **log**: what has happened at this table, one
  line per event, each with the time it happened on a twelve-hour clock, oldest
  at the top and newest at the bottom. `Session started` is the first line of
  every session's log, and `Turn 1 Segment 12` — where HERO opens a combat — is
  the second.

* What the log records, besides the session starting, is the table's membership
  — a player joining, a player taking or losing a character, and a player leaving
  — the stage, as the game master walks characters on and off it, and the clock,
  which writes `Turn <turn> Segment <segment>` each time the fight reaches a new
  segment. That last line is what gives the others their place: read back later,
  the events between two of them are what happened in that segment.

* Only a segment the fight actually arrives at is written down. Stepping from one
  character to the next inside a segment moves the marker and not the clock, and
  stepping backwards is an arrival like any other — a game master correcting a
  click should see where the fight went, not a log that only counts forwards.
  The clock also says where it is put, rather than only where it walks: a session
  writes `Turn 1 Segment 12` as it is created, and a restart writes it again, so
  every event in the log falls under a segment the log has named.

* A character on stage in more than one copy carries its copy number into the
  log, exactly as the initiative list draws it, so three goblins arriving are
  three lines a table can tell apart.

* Every line names whoever acted, and reads with them as its subject: the
  players' own doings in their names, the game master's in theirs. So a character
  a player selected and the same character assigned by the game master read
  differently, even though the table ends up the same either way — a log is a
  record of what was done and by whom, not only of what came to be. For the same
  reason a player who left, one the game master kicked, and one whose browser
  simply closed are three different lines. The last of those matters most: nobody
  at the table saw it happen, so the log is the only record there is.

* A character reassigned from one player to another is one line rather than an
  unassignment and an assignment, because it was one act — and because two would
  describe a moment, which never existed, when nobody held the character at all.

  The clock's line is the one exception to naming an actor: a game master pressed
  Next to get there, but what the line records is where the fight now is rather
  than who pressed what, so it is written flat and without a verb.

* The log is not a panel in a column. It is a drawer, hidden until a `Log`
  control in the upper left of the page header is pressed, and it pushes the
  columns aside rather than covering them — a game master may want it open while
  the fight runs, so nothing of the fight may go behind it. Where the screen is
  too narrow to give up a column, it is a block above the page instead. Whether
  it is open is each reader's own business and is remembered for as long as they
  have the session open.

* The log is the session's rather than the browser's. A screen that reloads gets
  it back, and a player who joins an hour in can read the hour they missed. That
  is what tells it apart from a toast, which says something once to whoever
  happened to be watching and is then gone.

* Every character, PC and NPC alike, is a HERO System 5th Edition Revised
  character. Each one in the library carries eight characteristics — SPEED,
  DEXTERITY, INITIATIVE, CONSTITUTION, RECOVERY, ENDURANCE, STUN and BODY —
  edited in the character editor. A character nobody has filled in yet reads as
  zeros. INITIATIVE is any bonus to acting first that DEXTERITY does not already
  account for, such as the Combat Reflexes talent, and the editor says so on
  hover. SPEED is bounded at 0 to 12, since a turn is twelve segments long —
  refused by the server and not merely by the form — and the others are
  unbounded.

* ENDURANCE, STUN and BODY are also tracked per active character in a session,
  as what that copy has left rather than what it started with: two copies of one
  NPC take their own wounds. A slot is seeded from the character's totals when
  it joins the scene and is independent from then on, so editing the library
  mid-session never quietly heals anyone. The values are shown as what is left
  over the total, may go negative, and are not capped at the total.

* The game master may see and edit those three for any active character, from
  the initiative panel. A player may see and edit them for their own character
  only, on their `My character` panel. The scene shows them to a player for
  nobody at all — not for anyone else, since how hurt the monster is is the game
  master's to give out, and not for themselves either, since their own panel
  already carries them. Every change reaches all the screens live.

* Those three numbers are changed by the difference rather than by typing a new
  total: pressing one opens a dialog offering every value from 50 off to 50 on,
  and the app does the sum. An exact value is still reachable in the same dialog,
  for setting a character up or putting a mistake right.

* Each of those three boxes is coloured by how much of the total is left: under
  a third is red, up to two thirds is yellow, and above that green. A character
  with no total recorded has no reading to give and stays uncoloured. The number
  itself is always shown, so the colour is a second way of saying it rather than
  the only one.

* Beside those numbers, wherever they may be edited, are two controls. One takes
  a Recovery: RECOVERY is added to both current ENDURANCE and current STUN, and
  neither goes past the character's total. It never takes anything away, so a
  character somehow above their total keeps what they have.

* The other is a rest, which sets current ENDURANCE and STUN to the character's
  totals — exactly to them, so a character left above their total by a temporary
  boost comes back to what they are. BODY is not a rest's business: it heals over
  days, which is longer than a session.

* A character on the stage may also carry **status tags**: what condition they
  are in. Nine are known by name — Dead, Drained, Entangled, Flashed, Prone,
  Sleeping, Stunned, Suppressed and Unconscious — and a table may type its own
  for anything else. Like the three numbers, they belong to the copy rather than to the
  character: one goblin can be prone while its twin is standing, and none of it
  outlives the session.

* The game master may set them for anybody in the scene, and a player for the
  character they are playing and nobody else — the same division as the numbers,
  for the same reason. A player sets theirs on their `My character` panel, where
  their numbers already are. Both audiences see everyone's in the segment panel:
  who is stunned is not a secret, it is what the table is reading the list for.

* Stunned is the one condition the app sets by itself. A character who takes more
  STUN than their CONSTITUTION **in a single hit** is stunned by it, so the tag
  goes on without anybody pressing anything, and the log says `<character> has
  taken more STUN than CON Stunned` — a line with no actor in it, because nobody
  chose it, and one that names the rule it came from, since a table reading back
  will want to know why a condition they did not set appeared. The condition at
  the end of it is drawn as the same pill every other line about one is. A
  character with no CONSTITUTION typed in is never stunned this way: a zero there
  is an unfilled sheet rather than a threshold of nought. Neither is a character
  already stunned, who has nothing to add. And neither is a number put right with
  `Or set it exactly`, however large the correction: that control is for fixing a
  total, and fixing a total is not a hit.

* Unconscious is the other one the app sets by itself, and on the same terms. A
  hit that takes a character's STUN to nought or below knocks them out: the tag
  goes on, the log says `<character> has had STUN reduced to zero Unconscious`,
  and the game master and that character's player are told `<character> has been
  knocked out`. One hit can do both — past the CONSTITUTION and past the last of
  the STUN — and then both happen and both are said, in that order, because a
  character can be stunned without going down and can go down without ever being
  stunned. A character with no STUN total typed in is never knocked out this way,
  for the reason a character with no CONSTITUTION is never stunned: they start at
  nought because nobody filled them in, not because they are down.

* A known condition is drawn as its icon alone, with its name on hover and for a
  screen reader; a typed one keeps its word, since no picture would say it. A row
  already carries a name, a kind, a count and five characteristics, and nine
  spelled-out conditions would be wider than all of them. Setting a condition
  twice sets it once, and a tag typed as one of the nine is that one rather than
  a second condition spelled the same way.

* Each PC and NPC on a session page should be shown with a small picture of
  itself — in the scene, and in the list the game master adds them from —
  falling back to a placeholder for a character that has no card image.

* Combat runs on the HERO System clock rather than on a flat list. A **Turn** is
  twelve **segments**; a character's SPEED decides which of those twelve they act
  in, off the published Speed Chart, and within one segment characters act in
  DEXTERITY + INITIATIVE order, highest first. A tie is broken by the order the
  characters came on stage. A character with SPEED 0 — one nobody has filled in
  — has no phases at all and never comes up on turn.

* The list of PCs and NPCs is therefore ordered by the app rather than by hand:
  it is presented in DEXTERITY + INITIATIVE order, and a character brought on
  mid-fight lands in its own place in it rather than at the end. There is no
  dragging: the order is a reading of the characters' own numbers, so a manual
  override could only ever put it out of agreement with the rules.

* The panel that holds the list is the **segment panel**, headed `Segment <n>`.
  It carries a button on the right which switches between showing every character
  and showing only the ones acting in the current segment; it is labelled with
  what pressing it will do, `Show Acting` or `Show All`. That choice is one
  reader's own — the GM's does not reach the players and a player's reaches
  nobody — it applies to every segment rather than to the one it was pressed on,
  and it is remembered until the session ends. With it off, a character with no
  phase this segment is dimmed rather than hidden, since the GM may still want to
  reach their numbers.

* On the GM's segment panel each row carries SPD, DEX, INIT, CON and REC under the
  name, written the same way as on a player's `My character` panel — this is the
  panel where the order is worked out, so the numbers it is worked out from
  belong in it. It does not repeat which player holds which character: that is on
  the GM's players panel already, and another table's characteristics are not a
  player's to read, so the two lists carry one line each rather than both.

* A fight opens on Turn 1, Segment 12, with no turn set, which is where HERO
  starts a combat. The first press of `Next` gives the phase to the first
  character acting in segment 12. Stepping forward walks the characters acting in
  the current segment and then moves to the next segment anybody acts in;
  arriving at segment 1 is what increments the Turn counter, so the first
  Segment 1 of a fight belongs to Turn 2. Segments nobody acts in are stepped
  over rather than shown empty. `Previous` retraces the same path exactly, and
  there is nothing before the first phase of the fight.

* Once segment 12 is done every character on the stage takes a Recovery — their
  REC back into both ENDURANCE and STUN, neither going past the character's
  total. It happens as the clock crosses from segment 12 to segment 1, so the new
  turn is fought with the numbers it hands back, and every screen in the session —
  the game master's and the players' alike — is told `Post-Segment 12 Recovery`.
  NPCs recover with the PCs: HERO gives the Recovery to everyone in the fight
  rather than to the characters someone is playing. Stepping back over segment 12
  does not undo it, since `Previous` is there to correct a misplaced click rather
  than to rewind the fight.

* Taking a character off the stage asks first only when a player is actually
  playing it: that player is dropped back to choosing a character, which is not
  something a misplaced click should do mid-game. An unclaimed character or an
  NPC goes straight away — a fight is run by clicking quickly, and a question in
  front of every removal would be answered without being read.

* The GM should be able to add and remove NPCs from the session. When this
  happens, the player's screens should update instantly without a refresh. Use
  websockets or SSE for this.

* The GM should be able to indicate what PC or NPC is currently active, i.e.,
  whose turn it is. When the GM makes this selection, the player screens should
  instantly update without a refresh.

* An NPC may be on the stage more than once. Adding it again brings on another
  copy with its own place on the stage and its own phase in a segment, and its
  card stays in the library panel so it can be added again. Where a character has more
  than one copy on the stage, each is numbered beside its name, and the library
  row shows how many of it are out. Only NPCs carry that count: there is one of a
  given hero and never a second, so a `1` beside them would answer a question
  nobody can ask. A copy keeps its number for the whole fight:
  removing one never renumbers the rest, and the next copy added takes the next
  number up rather than filling a gap. A player character is on the stage once and
  no more, but their row stays in the library panel like an NPC's, with its `Add`
  ghosted: a row that vanished when its character walked on would read the same as
  a character that was never in the campaign, and it would reshuffle the list
  under the GM mid-fight.

* The GM opens a character's sheet from the library panel rather than from the
  segment panel: that list holds every character in the campaign, so one who has
  not walked on yet can still be read, and a sheet belongs to the character rather
  than to a copy of them — two goblins have one sheet between them.

* The library panel is ordered in four blocks — the PCs already in the scene, the
  NPCs already in the scene, then the PCs who are not, then the NPCs who are not
  — alphabetically within each. Who is in the scene is what the GM is looking the
  panel up against, so it groups before kind does; one flat run of everybody is
  none of those four lists. A row therefore moves between blocks as its character
  comes on or goes off, which is the point: where a row sits is what says whether
  it is in the fight. A row whose character is not in the scene is also dimmed,
  the same way the segment panel dims whoever has no phase this segment — except
  its `Add`, which stays at full strength, since bringing them on is exactly what
  the GM is reaching for on such a row. The rule between the last character in the
  scene and the first one out of it is drawn heavier than the rules between rows,
  so where the scene ends is found before any row is read.

* The GM should be able to restart the turn order, taking the session back to
  Turn 1, Segment 12 with no turn set, as though the fight had not begun. The
  characters on the stage and the players' claims are both left alone: this
  restarts the fight, not the session. Since it throws away however many turns
  have been tracked, it asks before doing it.

* When the turn reaches a player's character, that player should get a toast and
  an audible chime. Only that player: the turn passing to anyone else must stay
  silent.

* A character stunned by a hit is toasted to two screens: the game master's, and
  that character's player. Nobody else at the table is told — it is not their
  character and not their numbers — and a monster nobody is playing is news for
  the game master alone. It arrives in the tone of something gone wrong rather
  than in the green the Post-Segment 12 Recovery uses.

## Conclusion

Ask me about design decisions or for any additional details you may need.
