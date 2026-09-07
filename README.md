# HERO Initiative Manager

A private table companion. The game master keeps a library of campaigns and
character sheets, starts a session, and hands out a code. Players join with that
code, claim a character, and watch the table update live — who is in the scene,
what order they act in, whose turn it is, and which characters nobody has
claimed yet.

Built on Bun 1.4, SQLite, React 19, Tailwind v4 and daisyUI 5. One process, one
database file, no external services.

![GM Library view](doc/library.webp)
![GM Session view](doc/gm_session.webp)

## Getting started

```bash
bun install
bunx extract-rules /path/to/HD6.jar   # the HERO game rules; see below
cp .env.example .env                  # then edit it
bun run cli gm:add --email you@example.com
bun run dev                           # http://localhost:3000
```

**The rules data has to be extracted once, from your own copy of HERO
Designer.** A `.hdc` character file records structure rather than presentation —
a skill is `XMLID="ACTING" LEVELS="1"`, and what it costs and how it prints is
computed against the game system's data. That data is Hero Games' copyrighted
material, so it ships with neither this app nor the renderer it uses.
`extract-rules` writes it where the app looks by default; `HERO_RULES_DIR` moves
it elsewhere. Without it no character sheet can be drawn and no characteristic
can be read from an upload, and the server says so at startup.

`ork-hero-export-renderer` is not on npm yet, so `package.json` points at a local
tarball; that becomes an ordinary `^0.1.0` once it is published.

Accounts are deliberately not manageable from the web UI — see the CLI below.

For local development over plain HTTP, set `INSECURE_COOKIES=1` in `.env`. This
drops the `Secure` flag from session cookies so they work without TLS. **Never
set it in production.**

## Command line

There is no account management UI, by design. Everything to do with game master
accounts happens here:

```bash
bun run cli gm:add     --email you@example.com [--password …]
bun run cli gm:list
bun run cli gm:edit    --email you@example.com [--new-email …] [--password …]
bun run cli gm:delete  --email you@example.com [--yes]
bun run cli db:migrate
bun run cli db:gc      [--dry-run]
```

Omit `--password` and you'll be prompted for it without echo — better than
putting a password in your shell history and the process list. Changing a
password signs out every browser that account was signed in on.

`db:gc` sweeps upload wreckage in both directions: rows nothing references any
more, and files under `data/uploads/` — characters, images and export templates
alike — that no row claims. `--dry-run` counts them without deleting. Deleting a
game master or a character already collects the first kind on the way out, so a
run that finds anything is cleaning up after an interrupted upload or a database
restored from a backup older than the files beside it.

## How it fits together

```
src/
  server/    Bun.serve: JSON API, authorised file delivery, WebSocket
  db/        schema, migrations, and every SQL statement (queries.ts)
  lib/       config, logging, errors, validation, id generation
  cli/       game master accounts
  client/    React app
data/        SQLite database and uploads (gitignored, never served statically)
```

A few things are worth knowing before reading the code.

**The library watches the sessions it lists.** Each row in "sessions in progress"
opens that session's socket, so the turn and the player count follow the table
without a reload — the same snapshots the console gets, read for two numbers. The
list's own figures stand in until the first snapshot arrives, and again if the
socket drops. The rows sit in campaign
name order, since the campaign is the only name a session is shown under; sorting
by age instead reshuffled the list every time a session was started.

**And which sessions there are is live as well.** A session socket cannot carry
that: it is named after a session, and a session that has not started yet has no
socket to watch. So the library opens a second kind — `/ws?scope=library`,
authenticated as the game master and subscribed to a topic named after them —
and the server republishes the whole list to it whenever the list changes:
a session started or ended, a campaign renamed or deleted. The payload is what
`GET /api/sessions` returns, built by one function (`buildGmSessionList`), so a
list that arrived over the socket needs no separate handling on the client. Both
socket kinds share their connection machinery, including reconnect-with-backoff,
in `src/client/useLiveSocket.ts`; what differs is only how the messages are read.
Changes *inside* a session are deliberately not published here — each row already
follows its own session — so a busy table does not rebuild the whole list on
every turn.

**A player is present for as long as they are connected.** Closing the tab is how
people actually leave a table — few of them find the button first — and someone
who is gone still holds their character, so the seat has to come free on its own.
But a socket closing is not the same as a player leaving: a reload, a dropped
tunnel, or a phone locking itself close it too, and the client comes straight
back. So a closed socket only starts a clock (`PLAYER_GRACE_MS`, 30 seconds by
default), any new socket for that player stops it, and only a player who is still
absent when it runs out is removed — releasing their claim and republishing the
session. The asymmetry is deliberate: dropping someone who was reloading takes
their character away mid-scene, while holding a seat a little too long is a stale
row in a list. An ended session is exempt, keeping the roster it finished with.

Since a removed player's socket is refused rather than told why, a page that was
left open would otherwise retry behind "Reconnecting…" for ever. While the socket
is away, the player screen asks `/api/auth/me` who it is; an answer that is no
longer this player means the seat is gone, and it says so instead of spinning.

**Every change republishes the whole session.** Rather than sending diffs, any
mutation recomputes a complete snapshot — session, players, the stage in the
order it acts — and publishes it to everyone watching. The lists are a dozen rows
at most, and it means a client can never merge updates in the wrong order: a
character arriving racing a turn change cannot leave someone highlighting the
wrong row.

**One live session per campaign.** Two would give the same characters two
clocks and two turn markers, and a code would not say which table a
player had joined. The rule is a partial unique index on `game_sessions`
(`002_one_active_session_per_campaign.sql`) covering active rows only, so a
campaign can still be played again and again; the start handler checks first and
answers 409 with something a game master can act on, and the index is what makes
that check impossible to get around.

**A session opens with the party in it.** Starting one inserts every PC in the
campaign onto the stage in a single statement, inside the same
transaction that creates the session — `sessionCharacters.addCampaignPcs` in
`src/db/queries.ts`. Characters already in the session are filtered out of that
statement rather than left to `ON CONFLICT DO NOTHING`, because a skipped row
would leave a hole in the positions.

**The fight runs on the HERO clock, and the clock lives on the server.** A Turn
is twelve segments; SPEED says which of them a character acts in, off the Speed
Chart in `src/lib/hero.ts`, and DEX+INIT says who goes first inside one. The
session carries `turn` and `segment` alongside `active_slot_id`, and `advanceTurn`
(`src/server/routes/sessions.ts`) is the only thing that moves any of the three —
so two open game master tabs cannot come to different views about where in the
fight the table is. Stepping forward takes the next character acting in this
segment, or else the first character of the next segment anybody acts in;
segments with no phases in them are stepped straight over rather than shown empty.

The turn counter goes up on *arriving at segment 1*, not on passing segment 12,
which is what makes a fight open on Turn 1 Segment 12 and the first Segment 1
belong to Turn 2. That is how HERO starts a combat, and it reads as an off-by-one
without being one. A SPEED of nought is an empty row of the chart, so a character
nobody has filled in never comes up on turn — and a stage where *nobody* has a
SPEED is refused outright with something the game master can act on, since the
segment walk would otherwise have all twelve to search and nothing to find.

**Crossing segment 12 hands everybody a Recovery.** HERO gives every character in
a fight a free Recovery once the twelfth segment is done, so the step that takes
the clock from 12 round to 1 takes it for the whole stage — NPCs included, since
the rule is about characters rather than about who is playing them — before the
snapshot goes out. It is one `UPDATE` over the stage (`takeRecoveryAll`) sharing
its arithmetic with the single-slot Recovery button, so the two cannot come to
disagree about what a Recovery is, and the stage recovers all at once or not at
all. `advanceTurn` answers whether it happened, and the route then publishes a
`notice` on the session socket — an event rather than state, kept out of the
snapshot so a client reconnecting an hour later is not toasted about it — which
every screen in the session, the game master's included, shows as
`Post-Segment 12 Recovery`. `Previous` never takes one: it retraces the path so
the game master can correct a click, and a Recovery already taken is not untaken.

The Speed Chart is written out longhand rather than derived. It is a published
table, not a formula: the segments SPD 7 gets are not the segments an even spread
of seven phases would give, and a clever reconstruction that came close would be
wrong exactly where nobody checks. `tests/hero.test.ts` pins every row of it.

**Restarting the fight clears the turn rather than parking it.** `POST
/api/sessions/:id/turn/restart` sets the clock to Turn 1, Segment 12 and the
active slot to `null`, which is the state a session opens in — "No turn set yet",
with the first press of Next opening segment 12 on whoever leads it. Putting the
marker on the first character instead would look equivalent and is not: the stage
may well have changed since the fight began, and it would quietly decide the new
leader had already acted. Nothing else is touched, so the stage and the players'
claims both survive a restart; it restarts the fight, not the session. The button
asks first (`Confirm.tsx`), since it is the one turn control that throws work away
and the only way back is to press Next as many times as it took to get there — and
it is disabled outright at turn one with no turn set, where there is nothing to go
back to.

**Every picture comes from one set.** Icons are FontAwesome v7's free solid
icons, imported one at a time from `@fortawesome/free-solid-svg-icons` and drawn
as inline SVG by `Icon` (`src/client/components/ui.tsx`) — so nothing is fetched
at runtime, there is no webfont, and the page's `default-src 'self'` policy needs
no exception. `main.tsx` sets `config.autoAddCss = false` and imports the
library's stylesheet instead, because it otherwise writes a `<style>` element
into the head the first time an icon renders, and every other stylesheet here is
bundled. Sizes stay Tailwind's (`h-4 w-4`) rather than the library's own `size`
prop, since the buttons were measured against those classes.

Icons are always decorative: each one sits in a button carrying its own
`aria-label` and `title`, or inside a wrapper already marked `aria-hidden`, so a
picture is never the only thing saying what a control does. That is also why the
turn controls kept their words — the icon replaced the arrow beside `Previous`,
not the label. The free icons are CC BY 4.0, © Fonticons, Inc.

**A destructive control in a list is a variant, not a red `className`.** `Button`'s
`dangerGhost` (`src/client/components/ui.tsx`) is the quiet form of `danger`:
daisyUI's `btn-soft btn-error`, a faint red wash rather than a fill, for "End
session" in the library's list and "Kick" in the players panel, where one filled
red button per row would drown the row it belongs to. It exists as a variant
because the obvious shortcut — `variant="ghost"` with a red `className` —
silently does not work: both set `color`, and which utility wins is decided by
the order Tailwind emits them in rather than by the order the caller wrote them,
so those buttons rendered grey. The same hazard the drop-target ring avoids, in a
different property.

**Nothing is deleted out from under a running session.** A character on the stage
of a live session cannot be deleted; `DELETE /api/characters/:id` answers 409 and
says which way out to take. Without the guard the `ON DELETE CASCADE` on
`session_characters.character_id` would do it silently — the character would
disappear from the players' screens mid-fight on the next broadcast, and the
stage would be left with a hole in its positions, since a cascade removes rows
without renumbering `position` the way `sessionCharacters.remove` does. The guard is
`sessionIdsWith` (`src/server/session-state.ts`), the same check that already
refuses to refile a character out of a campaign they are playing in; it filters on
`status = 'active'`, so an ended session is history and a character merely filed
under a busy campaign is still deletable. Refusing the operation is what closes the
dense-position hazard, rather than any renumbering code: the cascade can no longer
fire on a stage anyone is looking at.

**The stage is a list of slots, not of characters.** A fight usually has more than
one goblin, so `session_characters` rows carry an id of their own and two of them
may name the same character. That id is what the turn marker points at
(`game_sessions.active_slot_id`) and what a removal names — because "remove
Strahd" stopped being a question with one answer. It is also the `id` in the
snapshot, so every id-keyed thing on the client — React keys, `Go now`,
`Remove` — kept working and simply means the slot now; the
character it shows rides alongside as `characterId`, which is what a claim and a
sheet are about. The one place this had to be watched is `advanceTurn`: matching
the marker on the character would find the first goblin every time, so the marker
would spring back to it and the other two would never act.

**A copy's number is a name, not a position.** `copy_number` is stored, assigned as
one more than the highest that session has ever used for that character. Remove
Goblin 2 and you are left with Goblin 1 and Goblin 3, and the next one along is
Goblin 4. Deriving the number from the row's place in the order would have been
less to store and wrong at the table: the number would change when another copy
died or the order was dragged about, and someone tracking a monster's wounds on
paper needs the label to stay put. The number is only drawn while there is a second
copy to tell it apart from — a lone goblin is just the goblin — which is
`stageLabel` in `InitiativeList.tsx`, shared with the turn banner so the two can
never disagree about what the monster on turn is called.

**Only NPCs repeat.** A PC added twice is a no-op: `sessionCharacters.add` takes the
character's kind and refuses a second slot for a hero. Two would give one player two
seats and break the one-claim-per-character rule the players table enforces, and a
party does not have two of the same hero in it. That is also what lets claims stay
keyed on the character rather than the slot, which is the reason the whole player
side of this — claiming, "Playing as", the sheet check — needed no schema change at
all.

**The order is derived, not stored.** `sessionCharacters.list` sorts by
`dexterity + initiative` descending, which is what HERO runs a segment in, and
`session_characters.position` survives only as the tiebreak between two characters
on the same DEX+INIT: it is the order they came on stage. Sorting at read time
rather than writing positions when a character walks on is what keeps the panel
right the moment a DEX is edited mid-session — a stored order has somewhere to
drift to, and this has nowhere. `position` is still dense `0..n-1`, since adds
append and removes close the gap, so the tiebreak stays a real sequence.

**The segment filter is one reader's own.** The button on the segment panel narrows
it to the characters acting in the current segment, and both audiences get one:
which rows a game master would rather not scroll past is not a fact about the
session, so it is never broadcast and never reaches anyone else's screen. It lives
in `sessionStorage`, keyed by session (`SegmentFilter.tsx`) — it should survive a
reload mid-fight and it should not still be set months later at another table. It
is one setting rather than one per segment, so it stays on as the fight walks the
clock. Turned off, a character with no phase this segment is dimmed rather than
hidden: their STUN is still the game master's to change on a segment they are not
acting in.

**A status tag hangs off the slot, one row per tag.** Prone, stunned, dead and
the rest are facts about this copy in this fight — one goblin can be face down
while its twin is swinging — so `session_character_tags` keys on the stage slot
and cascades with it: taking a copy off the stage takes its conditions with it
and needs no cleanup code. The primary key is `(slot, tag)`, which is the rule
itself, since a character is prone or is not and being told twice is not two
pronenesses. The write is `PATCH /api/sessions/:id/stage/:slotId/tags` carrying
`{ tag, active }` — the state the tag should end in, not an instruction to flip
it — so a retried request or two people reaching for Prone at once leaves one
prone character. It is the fourth route `requireSlotAccess` guards: the game
master may tag anybody in the scene, a player only the character they claimed.

The nine the app knows by name live in `src/lib/hero.ts` beside the
characteristics, which is what feeds both the zod schema and the labels; the
pictures for them are in `src/client/components/StatusTags.tsx`, because
`hero.ts` is read by the server and FontAwesome is the browser's business.
Anything else a table wants to track is typed, kept as typed, and drawn with a
generic mark and its own word — with the one twist that a typed "Prone" folds
onto the button's `prone` rather than becoming a second kind of prone. The
column is `COLLATE NOCASE` for the same reason, and the table deliberately
carries no `CHECK`: what a tag may be is decided by the schema on the way in,
where every other such rule lives.

Both audiences read the tags off the segment panel — who is stunned is what the
table is looking at when it decides what to do next — but only a reader who may
write a row gets the control that opens the picker. That is the same split as
the numbers, drawn the same way: the game master's list is passed the callback,
a player's is not, and a player sets their own character's conditions on their
`My character` panel instead. The pills are icon-only with the name in the
tooltip and in an `sr-only` span, since a row already carries a name, a kind, a
count and five characteristics.

**Card styling is shared.** The campaign and character grids are different
components, so their shape lives in one place — `CARD_BASE` in
`src/client/components/ui.tsx` — and the player's character picker is built from
the same two, so a player sees the shape the game master saw. The picture is the
square, not the card: the image well is a full-width square, the card's controls
ride on the picture as bare glyphs stacked into the top right corner of the
frame's window (`IconButton bare`, positioned by `CARD_WINDOW_CONTROLS`) — edit,
delete, and on a character card one that opens its sheet — and the name sits
under it, on the panel the frame paints. That keeps the card mostly picture, and
since every caption is built the same way a row still lines up whatever the names
are.

**Every card is printed in a frame.** `assets/character-pc-card-template.webp`,
`assets/character-npc-card-template.webp`
and `assets/campaign-card-template.webp`
are 350×490 — the same five by seven the card is — so the art lays over a card
with nothing to crop or letterbox. Its window is transparent and the picture
shows through it; its lower panel is what the name is drawn on. `CardFrame`
(`ui.tsx`) is the overlay, `pointer-events-none` because `hover-3d`'s hover zones
sit beneath it and the tilt would otherwise stop, and `CARD_CAPTION_FRAMED` puts
the name on the artwork's panel (72.7%–96.5% of the card's height, the part every
frame draws panel behind) rather than in
the card's own bottom two sevenths, which would leave it astride the frame's
lower border. `CARD_WINDOW_CONTROLS` does the same job for the corner controls, which
are pinned to the square well otherwise and would sit across the gold divider the
art draws at 64%. `CARD_WINDOW` is the window itself, for something laid in it
whole rather than pinned to a corner of it — the back of a character's card. The card's own 1px border is deliberately left showing around the
art: it is the hover and keyboard-focus highlight, and painting over it would
take that away. Every kind of card is framed, so they all put their controls in
the same corner and there is one arrangement in `HoverCard` rather than a choice.
**Each kind of card is framed in its own artwork** — `CardFrame` takes the
kind (`"pc"`, `"npc"` or `"campaign"`) and adds `.card-frame-npc` or
`.card-frame-campaign` to the same overlay, a PC being the bare `.card-frame` —
so the kinds still tell themselves apart at a glance, while every measurement
above is shared because all three frames are cut to the same 350×490. They are
separate files, routes and variables all the way down, so redrawing any one is a
file swap rather than a code change.

**There is one cut of each, not a light and a dark twin.** The art is painted
stock, and stock does not change colour when the room does. What does have to
change is the name drawn on it: the panel under it is pale in either theme, so
`base-content` alone would go white on white on a dark page. `CARD_CAPTION_FRAMED`
hangs `data-theme="winter"` on the name's strip instead, which scopes the light
theme's whole palette to that one element — so the name goes on asking for
`base-content` and gets ink that belongs on a pale panel either way, and nothing
in the app names a colour to do it. The attribute brings daisyUI's `base-100`
background with it, which would be an opaque rectangle over the panel, so
`.card-caption` in `styles.css` clears that.

They are WebP rather than PNG. The window has to stay transparent, so the format
has to carry alpha, and WebP does it in roughly a third of the bytes, which
matters for artwork that every card on the page draws.

The frames are named in CSS (`--card-frame-pc`, `--card-frame-npc` and
`--campaign-frame` in `styles.css`), so which artwork a card takes is a class
rather than a prop and switching theme never re-renders a card. The `url()`s are
*not* written there, though: Bun's bundler resolves every url it can see, and
pointed at the files it inlined them all as base64 — taking the stylesheet from
60KB to 448KB, render-blocking and refetched whenever any unrelated rule changed
— while pointed at a server path it refused to build at all. So the addresses arrive from `/appearance.css`, which the server writes and
the bundler never sees, and the images themselves are served by
`server/routes/frames.ts`: read once at startup, public, and revalidated with an
ETag of their own contents.

**The names on cards can be set in a font of the deployment's choosing.**
`CARD_FONT_URL` is a stylesheet carrying the font and `CARD_FONT_FAMILY` the
family within it to draw with — both are needed, since such a stylesheet often
names several families and a family name alone has nothing to load. The URL is
`@import`ed at the top of `/appearance.css` and the family arrives beside it as
`--card-font-family`, which `.card-name` reads; unset, that falls back to
`inherit` and a card's name keeps the interface font. Only the name takes it, on
all three libraries — not the session lists' PC/NPC badge, where a display face
at that size is a puzzle rather than a label.

Both values are validated in `config.ts` rather than trusted, because both are
written into a stylesheet every page loads. The URL must be https on
`fonts.googleapis.com`, which is the host the page CSP admits — a URL the browser
would block is refused where it can be explained instead. The family is held to
letters, digits, spaces and hyphens, which names every family a font service
offers and cannot close a `font-family` value or open a rule of its own. A
rejected value is logged at startup and ignored: `config.ts` cannot log for
itself, since `log.ts` reads it for its level, so it collects the complaints in
`configWarnings` and `server/index.ts` reports them.

Two details worth knowing before changing the fallback. `--card-font-family` ends
in a plain `sans-serif`, and neither of the two more obvious tails works:
`inherit` is a CSS-wide keyword, legal only as an entire value and never as one
item in a font list, so it makes the whole declaration invalid; and
`var(--font-sans)` resolves to nothing, because Tailwind inlines its theme values
in this build rather than emitting that property — and an unresolvable `var()`
makes the custom property itself invalid. Both failures look identical from the
outside: the name quietly keeps the interface font and the setting appears not to
work.

**A card is a playing card**: five wide by seven tall, the top five of those
sevens the square picture and the bottom two the name under it. The ratio is
declared once, as `aspect-[5/7]` on `CARD_BASE`, and the two parts divide it
between them — the well takes its own width as a square and the caption takes
what is left, which comes to two fifths of the width without a second number to
keep in step with the first. So the reader's own card size still decides the
size of a card, and the shape is no longer a matter of how tall a name
happened to make its strip. The strip's padding is horizontal only, the name
centred in it both ways: at the smallest card the setting allows, a fixed 12px
above and below would be taller than the whole strip. Centring is two rules
rather than one — the caption centres the name as a box, and `CARD_NAME` carries
`text-center` so the lines inside that box are centred too, which is what a
wrapped name needs and what a name filling the strip needed before it wrapped.

A long name **wraps to a second line** and is cut short only past that, which is
why the name's type scales with the card (`.card-name`, a fraction of
`--card-image-size`) rather than sitting at a flat 16px: the panel holds exactly
two of those lines at every size the card-size setting allows, where a fixed size
held two on a large card and one on a small one. The fraction is chosen to land
on the 16px it has always been at the default card, so nothing moves for a table
that never touches the slider — and as a side effect the name is now the same
size relative to its card everywhere, instead of shouting on a small one and
whispering on a large one. An icon button
always carries a label — it is the tooltip and the only thing a screen reader has
to go on. Every hover rule is paired with a `focus-within` one, because a card is
a box of buttons and a keyboard user would otherwise get no feedback at all.

**A card tilts towards the pointer, and that decides its markup.** `HoverCard`
(`ui.tsx`) wraps daisyUI's `hover-3d`, which is a three-by-three grid of exactly
nine children: the first spans the whole grid and is what tilts, and the other
eight are empty divs occupying the cells around the middle. Those eight sit
*above* the content at `z-index: 1` and exist only to be hovered — which corner
the pointer is in is read back with `:has()` and turned into the rotation. They
therefore swallow every pointer event over the card, and daisyUI says outright
that buttons must not go inside the wrapper. Every card here is a box of buttons,
so both of the ways out are in `HoverCard`:

* **The card's own click target is the wrapper.** A press on a zone bubbles up to
  the `<button>` containing it, so the whole card is pressable while the zones
  keep working — daisyUI's own advice, "wrap the entire component in a link". It
  is why `label` is required beside `onClick`: left to compute its own name, the
  button would be called after everything printed on the tile, and
  `tests/e2e.test.ts` looks a character up by its name exactly.
  This is also what retired the two full-bleed buttons that used to cover a
  card's picture — selecting a campaign, and opening a character — since the card
  itself is now the control.
* **The corner controls live outside the wrapper**, and they have to. The tilting
  tile carries a transform — an identity matrix at rest, but a transform all the
  same — so it establishes a stacking context, and anything inside it is confined
  below the zones however high its `z-index`. That is the real reason daisyUI says
  buttons must not go in the wrapper: inside it they are not clickable, and no
  amount of layering fixes it. So the controls sit in the `<article>`, above
  everything, and pass the pointer through except at the buttons themselves —
  otherwise they would blank out the tilt across the whole picture.

  **They still move with the card**, rather than staying flat on top of it: they
  take the same rotation the tile does, so they read as printed on the card's face
  rather than stuck to the glass. Getting that costs a duplication worth knowing
  about. `hover-3d` turns "which zone is hovered" into a `--transform` set on
  itself, and a custom property set there does not reach a sibling of the wrapper —
  so `styles.css` repeats those eight `:has()` mappings on the `<article>` under
  `.card-3d`, along with the rotation, daisyUI's two easing curves and the hover
  scale. If a daisyUI upgrade changes any of them, the controls drift away from
  the card and that block is where to look. The transform is applied to a layer
  that is the card's whole box rather than the controls' own smaller one: a
  rotation about a shared centre maps a given point identically whatever the box's
  size, which is what keeps them glued to a tile inset from it by the border.

Two consequences worth knowing before editing `CARD_BASE`. It carries **no
`transform`, `transition` or hover shadow** — `hover-3d` sets all three on that
same element, and a Tailwind utility for any of them silently wins (Tailwind's
utilities are unlayered within `@layer utilities`; daisyUI's are in a sublayer),
which would simply stop the tilt. The lift the cards used to have is what the
tilt replaces. And its hover colours are **`group-` variants**, because the
pointer is never over that element at all: the zones cover it and are its
siblings, not its children, so its own `:hover` never fires. The group is the
`hover-3d` wrapper, which the zones *are* inside.

**A character's card in the library turns over.** Pressing one flips it in 3D to
a back that prints all eight characteristics — SPD, DEX, INIT, CON, REC, END,
STUN, BODY — ruled down the frame's window like the back of a baseball card, with the
name still in its usual strip so a shelf of turned-over cards is still readable.
The sheet that pressing a card used to open has its own control in the corner, so
nothing was taken away; it stopped being what the whole card does. Only the
library gives a card a back: on the session screens those numbers are already on
the screen beside it, and turning the card over there would hide the picture to
say something said twice.

The flip cannot go on the tile, and that is the thing to know before touching it.
`hover-3d` owns that element's `transform` — the tilt — and gives it
`overflow: hidden`, which forces `transform-style: flat`, so a rotation there is
either overwritten or drawn flat. So the turn is a **layer inside** the tile
(`.card-flip` in `styles.css`): the tile goes on tilting and supplies the
perspective, the layer below it turns, and the two compose. Both faces are
mounted and stacked at all times — the far one has to be there to be turned
towards — and `backface-visibility: hidden` is what swaps them, each face
disappearing as it turns away. `HoverCard` grows a `back` and a `flipped` for it;
with no `back` the markup is exactly what it always was, so campaign cards and the
session screens pay nothing. The card is a toggle once it has a back, so it
carries `aria-pressed`, and the corner controls — which ride outside the tile and
cannot turn with it — fade out while the back is showing.

The back is drawn in the same frame as the front and carries `data-theme="winter"`
for the whole face, for the reason the name's strip carries it on the front: one
cut of the artwork serves both themes, so the back of a card is pale whatever the
page is doing, and the ink on it has to be the ink that belongs on pale card. It
is printed on stock of its own — `assets/back.webp`, served beside the frames and
delivered as `--card-back` for the same bundler reason — laid in the same
full-width square the front prints its picture in, not in the frame's window: the
window is smaller than that square on every side, and art cut to it leaves a bare
band between the window's foot and the name's panel. What overruns goes under the
frame, which is what a bleed is for.

The numbers are set as the name is — the same face (`--card-font-family`), the
same weight, the same ink at full strength — because they are the only two pieces
of type on a card and a back set in the interface font reads as a screen with a
card in front of it. Only the size differs: it scales with `--card-image-size`
(`.card-stat`) exactly as the name's does, but smaller, since seven ruled rows
come to about 0.61 of the card's width against a window of 0.85 and the name's own
0.09 would not fit them at any card size.

**The card also catches the light as it tilts**, and that too is daisyUI's, only
turned up. `hover-3d` sets a `--shine` beside the `--transform` it rotates by —
`0% 0%` for the top left zone, `200% 200%` for the bottom right, `100% 100%` at
rest — and draws a blurred pool of light there. At `#fff3` under an opacity fade
it is invisible in practice, so `styles.css` restates it at a strength that
reads, and adds the diagonal glare band daisyUI's hover rule already anticipates
(`&:before, &:after`) but never defines. Both layers are one cell of the same
three-by-three grid the zones form, so the light lands on the cell the pointer is
in by construction, and moves in the same nine steps the tilt does.

It lives on `CardWell` rather than on the tile, which is what clips it: the
well's `overflow-hidden` keeps the highlight square to the picture, so no streak
ever crosses the name below and its contrast is untouched. daisyUI's own
tile-level `::before` is switched off with `content: none` so there are not two
of them, and the hover state is restated locally because these rules are
unlayered and would otherwise beat daisyUI's `opacity: 1`. The strength is two
custom properties, `--card-sheen` and `--card-glare` — the one place in the app
that names a colour, since a specular highlight is light falling on the card
rather than a colour from the palette. How glossy a card should look depends on
the artwork a table uses and the screen it is read on, so the deployment scales
both with `CARD_SHEEN_PCT` (100 is the tuned strength, the default is a quarter
of it, and 0 turns the highlight off), which
arrives as `--card-sheen-strength` through `/appearance.css` exactly as the card
size does. The two percentages stay in the stylesheet, so the balance between the
hotspot and the band survives whatever the setting is.

**And a player character's card is printed on foil.** `assets/sheen.webp` is a
sheet of soft rainbow — the pastel bloom a holographic card throws back — laid
over the picture by `card-foil`, an empty `<span>` `CardWell` puts before its
children when it is asked for. An element
rather than a third pseudo-element, because `card-sheen` has only two and both
are spoken for; first in the well, so it paints beneath them — the foil is what
the picture is printed on, and the highlight is what lands on the foil. It blends
with `mix-blend-mode: overlay`, which bends the photograph's hue while leaving
its own darks and lights alone, so a card reads as printed on foil rather than as
a picture behind coloured film; `isolation: isolate` on the well keeps that blend
off the frame and the tile underneath. Its geometry is the highlight's one size
up — the same 33.33% cell moved by `--shine`, at `scale: 5` so the sheet still
covers the whole well from the far corner cells — so the colour drifts in the
same nine steps the tilt does. Unlike the highlight it is there at rest, since a
foil card catches colour standing still and only brightens as it turns; both
strengths scale with `--card-sheen-strength`, so `CARD_SHEEN_PCT` turns
everything the card does with light up and down together. The image is served by
`server/routes/frames.ts` and its url arrives as `--card-foil` through
`/appearance.css`, for exactly the bundler reason the frames do.

**Which cards get one** is `CardWell`'s `foil` prop, and it defaults to **false**:
a card is ordinary stock unless it says otherwise, so a library added later that
never thinks about this gets the plain card rather than the special one. Only
`CharacterCard` asks for it, and only for a PC; the player's character-picking
list asks unconditionally because it is filtered to PCs before it renders; the
campaign card does not ask at all. A holographic card is the special one in the
pack, and a library where every tile shimmers says nothing about which is which —
so the foil joins the frame artwork as a way the kinds tell themselves apart. An
NPC's card and a campaign's still tilt and still catch the white highlight; it is
the rainbow they go without, and `tests/e2e.test.ts` pins both halves of that by
counting `.card-foil` on a card of each kind.

Under `prefers-reduced-motion`, the card does not move, does not shine, and nor
do its controls — left moving, they would tilt over a card that does not.
Zeroing transition durations is not enough — it would turn the tilt into a snap,
which is worse than the slide — so `styles.css` neutralises the transform
outright and drops the sheen's pseudo-elements, unlayered so it beats daisyUI's
own rule. The hover border still says which card the pointer is on. The foil
stays, pinned to its resting cell: held still it is a colour the card is printed
in rather than a motion, which is nothing for that reader to object to. The flip
needs nothing of its own: it is a turn between two settled states rather than a
motion that starts and stops on hover, so the blanket zeroing above simply makes
it instant, which is what a reader who asked for less movement wants of it.

**Colour belongs to daisyUI, not to the components.** `src/client/styles.css`
enables two of its stock themes — `winter` for light and `night` for dark — and
every component is written against the semantic tokens they define: `base-100`
for a panel, `base-200` for the ground it sits on, `base-300` for an inert well,
`base-content` for text, and `primary` / `error` / `warning` / `success` / `info`
/ `secondary` for the six things that mean something. Nothing in `src/client`
names a palette shade, and nothing carries a `dark:` twin — the theme decides
what each token resolves to, so dark mode stopped being per-utility work. A
`grep` for `stone-`, `amber-` or `dark:` over the client is the check that this
still holds; it should find nothing but prose.

Components come from daisyUI too: `btn`, `card`, `badge`, `alert`, `input`,
`select`, `file-input`, `modal`, `join`, `avatar`, `loading`. What is left in
`ui.tsx` is the handful of decisions daisyUI has no opinion about.

**The theme control has three states for two themes.** Light and dark are the
themes; "system" is the *absence* of a choice, and it is handled entirely in CSS
— `winter --default` applies at `:root`, `night --prefersdark` applies inside a
`prefers-color-scheme: dark` query when no `data-theme` attribute is set. So a
reader who never touches the toggle gets a correct first paint with no script
involved. An explicit choice writes `data-theme` onto `<html>` and is remembered
in `localStorage` under `ttrpg.theme`; `initTheme()` applies it before React
renders so a stored choice never flashes the other theme. What is *stored* is the
preference ("light"), and what is written to the attribute is the theme that
realises it ("winter") — `THEMES` in `src/client/theme.ts` is the only place that
knows which stock themes were picked, so swapping one leaves every reader's
stored preference intact. That split is also why the toggle is a `join` of three
buttons rather than daisyUI's `theme-controller` radio, which has no way to
express "no attribute".

Two of its habits are worth knowing before adding a control. **Its form controls
are `width: 100%` by default** — a `select` dropped into a flex row will take the
whole row and squeeze its siblings to nothing, which is why the one in the GM's
player list carries `w-auto`. And **its `error`, `warning` and `success` are pale
by design**, meant to be washed behind text or filled behind their own `-content`
pair; a number or a caption drawn in one of them on the light theme is barely
there. Where a colour has to carry meaning *and* be read, the tone goes on the
border and the wash and the text stays `base-content` — see `TONES` in
`Vitals.tsx` and the unclaimed row in `InitiativeList.tsx`.

**Four of its components are restored rather than trusted.** The development
server rewrites daisyUI's stylesheet into rules nested under a pseudo-element —
`.range { &::-webkit-slider-thumb { @layer … { & { … } } } }` — and a rule nested
under a pseudo-element is not something a browser resolves, so those declarations
are dropped entirely. The production build flattens the same source correctly,
which is why this is invisible until somebody opens the app they are building.
Four components are drawn with pseudo-elements and so come out half-made: the
range's track and thumb, the toggle's knob, the file field's "Choose File"
button, and the aura's glow. A range was a dot on no rail, a toggle an empty pill
that did not visibly move, a file field the browser's own bare label sitting in
daisyUI's box, and an aura a gold hairline near enough to nothing that it read as
a change that had not taken.

`styles.css` carries flat copies of those rules at the bottom, written against
daisyUI's own `--range-*`, `--toggle-*`, `--btn-*` and `--aura-*` properties so the themes
still decide the colours and a version bump carries most of the way. What is left
out is decoration — the noise texture, the depth highlights. Unlayered, so they
beat daisyUI's own; the values are the same, so development and production render
identically, which is the whole point. They come out when Bun's dev pipeline stops
nesting under pseudo-elements, and the test for that is a dev server that draws a
rail without them.

Neither file input carries `file-input-sm`: at `sm` the card image field was 32px
tall at 12px type against the name field's 40px at 14px, and the two sit one above
the other in the same form.

**And so are the shapes the screens repeat.** `ui.tsx` names them once —
`TEXT_MUTED`, `SURFACE`, `HAIRLINE`, `FIELD_CAPTION`, `PANEL_CAPTION` and their
neighbours — and the pieces of markup that repeat are small components beside
them: `CardWell` and `CardPicture` for a card's square picture, `CountBadge` for
"how many of this one", `LoadingNote` for a screen with nothing to show yet.
Before that, the muted-text classes alone were written out in eighteen places,
and a change to them meant finding all eighteen.

These are exported class *strings* interpolated into `className`, not CSS classes
built with `@apply`. That is what Tailwind itself recommends for a React codebase,
and it keeps every class in the app inside one mental model: when two of them set
the same property, which wins is decided by the order Tailwind emits them in, and
that rule holds for a constant exactly as it does for a literal. **So a constant
deliberately leaves out any property its callers disagree about** — `SURFACE`
carries no shadow because the turn bar wants none, `PANEL_CAPTION` carries no font
size because its five users pick five different ones. A call site that has to
override what it just applied is the bug this shape exists to prevent; write the
classes out longhand instead, as the small select in the GM's player list does.

**So is the grid the cards sit in.** `CARD_GRID`, alongside it, lays them out on
a fixed-width track rather than a fraction of the panel. The two libraries sit in
panels of different widths, and anything proportional makes a campaign card and a
character card come out different sizes; a fixed track makes them identical at
every window size, at the price of some slack at the end of a row.

That size is a **ceiling, not a target**, which is what the `minmax` in the track
is for. A window too narrow for two columns gets one column with empty space
beside it, rather than one card stretched across the panel — the size is the
reader's own setting now, and a card that grew past it whenever the window
narrowed would be ignoring it. The floor is `min(100%, …)` rather than the track
itself, for the one case the two disagree about: a column narrower than a single
card, where the track would simply overflow. There the floor drops to the column's
own width and the card comes out *smaller* than asked for, which is the only
direction it may go, since there is nowhere else to draw it.

The size can also change under a panel that never moves — it is an inline custom
property on the document (`cardSize.ts`), so neither a `ResizeObserver` nor a
media query hears about it. `useCardFit` subscribes to that store as well, because
a panel still pinned to whole columns of the *old* card is a fraction of a column
short of the new one, and the grid answers that by drawing the card smaller than
the reader has just asked for.

**The campaign panel gives that slack away.** On the wide layout it is trimmed to
the width that holds a whole number of card columns and no part of another, so its
edge sits flush against the last column and the character panel beside it takes
what is left. `useCardFit` (`src/client/useCardFit.ts`) measures the panel, works
out how many columns its natural share holds — never more than there are campaigns
to fill them, never fewer than one — and writes that width into `--campaign-col`,
which the split's grid template reads (`styles.css` declares the fluid default, so
unpinned it is the ordinary `1 : 1.4` split). It only ever narrows: what the
campaign panel gives up, the `1.4fr` next to it absorbs. Nothing there assumes a
card size, a gap or a padding — all of them are read back from the rendered
layout, so a deployment drawing larger cards needs no matching change. The
scrolling panel body deliberately does *not* reserve a scrollbar gutter it is not
using: that strip sits outside the grid's content box, so a panel had to be a
scrollbar wider than it looked before another column fitted — a card dropped out
of the row while there was still visibly room for it — and the cards sat in twice
as much padding on that side as on the other three. Reserving it bought
measurement stability that was never at risk, since pinning a panel to the columns
it already holds changes neither the row count nor whether the body scrolls.

**And the reader can overrule it.** The gutter between the two panels is a drag
handle (`ColumnHandle` in `ui.tsx`, driven by `useColumnSplit` in
`src/client/useColumnSplit.ts`), so a table with twenty campaigns and three
characters can have the balance the other way round. The handle and the automatic
fit are two writers of one custom property, which is the whole design problem:
they take turns rather than share. From the first drag the reader's width is in
force and `useCardFit` stands down — its `enabled` check sits *before* the branch
that clears the property, because the effect runs on every render and clearing it
there would wipe the width mid-gesture — and a double-click or Enter on the handle
removes the width and hands it back, whereupon the fit re-pins on the next render.
The choice lasts for the visit and is not stored: a reload is the other way back.

The drag writes the width straight to the container's inline style rather than
through React state, because a pointer-move fires at the refresh rate and every one
of them would otherwise re-render the whole screen; the only state is which writer
is in charge, which changes twice per gesture. The same is true of `aria-valuenow`
and its bounds, which the hook sets on the handle as attributes. How far a
key-press moves the split, and how narrow a column may be squeezed, come from the
caller where it can do better: the library passes `measureTrack` — the card
measurement `useCardFit` was already doing, now shared — so a panel is never
dragged narrower than one whole card and a deployment drawing larger cards needs no
change here; a caller that passes nothing gets a floor of a sixth of the split and
a step of a twentieth, fractions rather than pixels so they mean the same thing on
a laptop and on a dashboard. The handle is exactly as wide as the `gap` it
replaced, so adding it moved nothing, and it is `hidden` below the breakpoint that
puts its two columns side by side, where there is no boundary to drag and it stays
out of the tab order.

**The session console has three of them for two layouts**, because the two
layouts share no boundary: at `sm` the one gutter is between the table's stuff on
the left — the code, the players, the library — and the fight on the right, while
the dashboard takes that stack apart and puts the fight between its halves, so its
gutters are library-to-stage and stage-to-players. Each hook sizes the column to
its left, the column at the far end absorbs what the others give up, and a handle
is hidden on the layout whose columns it does not divide. Two things
there are worth knowing. First, the split is measured off the **handles**, not off
a column count the hook is told: a column runs from one handle to the next, so
their rects describe every column between them — and that matters because the
console places its columns with `order`, which means position in the DOM is not
position on the page, and because a column there can be a `display: contents`
wrapper's child rather than a box of the grid's own. Second, how the columns beyond
a handle share what it takes is the browser's business — one may be pinned by
another handle and give up nothing, two fluid ones shrink together — so rather than
model it, `apply` puts the width on the page, reads back the narrowest column
beyond, and hands room back if it fell under its floor. It settles in one pass
except near the edge, because the first guess is only wrong there.

**The player screen has one**, between the column holding the turn, their own
character and the player list, and the scene beside it. It is the plainest use of
the hook — one boundary, no `order` to see through, and no automatic width to take
turns with, so the handle is the only writer of `--player-mine` and the scene's
`1.4fr` absorbs whatever the first column gives up. It appears at `lg`, where the
second column does; below that the panels stack and there is no boundary to drag.

It did cost the panel above it one line. A column the reader can squeeze is a
column whose contents have to stay inside it, and `My character` is the one panel
on either session screen that does not scroll its body — so its deliberately
unwrapping line of numbers simply overflowed, and at the narrow end it lay across
the handle and put it out of reach exactly when a reader wanted their column back.
That line now scrolls sideways within the panel, which is what the spec asked for
anyway: pushed sideways to read the end of, rather than folded in half.

**File fields take a drop, and still are file fields.** Adding a character means
handing over a `.hdc` character file and often a picture, and dragging a file from a folder
is the shorter path — so both fields on the character form are `FileDrop`
(`src/client/components/ui.tsx`), a dashed zone that names the file once it has
one. The native `<input type="file">` stays inside it rather than being replaced
by a div: it is what a keyboard reaches, what the `accept` filter belongs to, and
what `FormData` reads on submit. A drop copies the file into that input through a
`DataTransfer`, so the form submits exactly as it did before the zone existed and
knows nothing about any of this. Dropped files are not type-checked in the
browser — the server identifies an image by its magic bytes, not by what the
client called it, so a wrong file comes back as the same error the picker would
have produced. The sheet field leads the form, ahead of the name: handing the
file over is what the dialog is for, and everything under it — name, type,
campaign, picture — is filing the thing that was just uploaded.

That ordering is also what makes the name fill itself in. A character file is nearly
always saved under the character's name, so uploading `Bilbo Baggins.hdc` puts
"Bilbo Baggins" in the field below it — the extension goes, and nothing else
about the filename is second-guessed. It writes only into an empty field or over
a name the last upload put there, tracked in a ref: a second file replaces its
own suggestion, but never a name the game master typed, and never the name of a
character being edited.

The panel behind the dialog is a drop target too, and it does not open the
dialog at all: character files dropped anywhere on "Characters in …" are filed
as characters there and then. Everything the dialog would have asked for is already
known by the time the drop lands — the panel only exists while a campaign is
selected, the filename names the character exactly as the dialog's own field
would, and a dropped character is an NPC until someone edits it — so the dialog
would have been a form with nothing left to fill in. A whole folder of characters
is therefore filed by dropping the folder: `fileSheets` (`GmLibrary.tsx`) splits
each file and posts one at a time, since each one is taken apart and its picture
re-encoded, and a dozen of those at once is a dozen image decodes racing each
other for no gain. Each card appears as its file lands — inserted in name order, which is the order the
library arrives in — under a line saying how many are still to come, and one
failure is reported without stopping the rest.

**A name files under its first real word.** "The Crimson Fist" is listed with the
Cs, the way a catalogue or a record shop files it — leave the article in and half
a campaign's cast collects under T, which is no order at all for finding anybody
in. `compareNames` (`src/lib/names.ts`) is the whole of the rule: a leading `The`
is dropped from the key, one *inside* a name is left alone ("Sword of the
Morning" files under S), `Theodore` keeps its T because the article is a word
rather than a prefix, and the full name breaks a tie so a library lists the same
way twice.

It lives in `lib/` because both sides sort: the server sends the library in order
and the browser files a newly uploaded character into that same order without
asking for the list again. That is also why it is TypeScript rather than the
`ORDER BY` it used to be — SQLite takes a collation from its host program, but
`bun:sqlite` exposes no way to register one, so a rule written in SQL could only
be a second copy in a language that cannot be made to agree. `characters.listForGm`
is therefore the one query in `queries.ts` that sorts outside SQL, and
`addCampaignPcs` gave up a window function for the same reason: the party that
opens a session is numbered in the order the library lists it, so two characters
on the same DEX+INIT stand where the game master expects.

**A name the campaign already has is that character being updated**, not a
collision. Re-exporting from HERO Designer and dropping the file back is how a
character is kept current, and refusing it left the game master finding each
character, opening its dialog and picking the file by hand. So the drop replaces
the stored file, the characteristics inside it replace the character's, and
the portrait inside it replaces the picture — the dropped file is the whole of the
intent, and there is nothing in the gesture that could mean "but keep the old
picture". The kind is what it leaves alone: a monster dropped over a hero does not
make that hero a monster, and the dialog is where that is decided.

`fileSheets` matches the name the way the server does — its `COLLATE NOCASE`
against `sensitivity: "base"` in the browser — and the list it searches is the
page's own, so a character added in another tab since the page loaded takes the
create path and gets the conflict it always did. Matching is not ordering, which
is why that comparison stayed here rather than moving into `compareNames` below:
"The Ravager" is a different character from "Ravager", however near each other
they are filed. That is also why the toast counts the two separately: a batch that quietly
updated ten characters when the game master meant to add ten is worth noticing.

The **portrait** rule is the one place the drop and the edit dialog differ, and
the difference is a `portraitFromSheet` flag that only the drop sends. The dialog
carries a card-image field and a remove box, so a picture there was chosen and a
file must not overrule it; a bare drop has no way to express that, so the file
wins. The Add-character dialog still refuses a duplicate name: creating a
character is a deliberate act, and the conflict is a useful guard there.

Both targets are the same three
handlers — `useFileDropTarget` in `ui.tsx`. `Panel` learns nothing about files:
it spreads unknown props onto its `<section>` the way `Button` does, and the highlight is a `ring`, since a
border or background utility would fight the panel's own for the same property
and let stylesheet order decide the winner. The page also swallows `dragover` and
`drop` at the window: having invited a drag, a miss must not make the browser
navigate away to render a character sheet as a bare page.

**A drop target names what it accepts.** `useDropTarget` (`ui.tsx`) is keyed on a
`dataTransfer` type — `"Files"` for the file fields and the character panel,
`CHARACTER_DRAG` for a campaign card — and a drag carrying anything else is left
entirely alone: not `preventDefault`ed, so it passes through to whatever is behind
and the browser draws a no-drop cursor rather than an invitation the element cannot
honour. That one guard is what lets card drags and file drags share a page: before
it, the character panel claimed every drag that crossed it, so a character dragged
back onto its own panel was filed as though a character file had arrived. The
window-level swallow is narrowed the same way, for the same reason.

**Dragging a character onto a campaign refiles it.** Both libraries are on screen
together on the wide layout, so the shortest way to move a character is to drop its
card on the campaign it belongs to. It is native HTML5 drag: the two panels are
separate `overflow-y-auto` scroll
containers that would clip a dragged card, and the accessible path here already
exists — the edit dialog's campaign field — so the drag is an accelerator rather
than the only way in. During `dragover` the payload is unreadable, only its type, so
`GmLibrary` holds the dragged character in state as well: a campaign card has to know
while the drag is still in the air whether letting go would move anything, and the
card of the campaign the character is already in stays dark. The cue on the one that
would take it is a ring with an offset — a different shape from both the selection
ring a campaign card may already wear and the ring the character panel draws for a
file, so the three never read as each other.

The selection does not follow the character: it leaves the list and the panel stays
where it was, so a run of characters can be filed out of one campaign without
re-selecting it between each. Two rules are the server's, since they are about the
data rather than the gesture. A name is unique within a campaign, so the PATCH asks
whether the character's *effective* name and campaign collide rather than which
fields the form carried — a move alone can collide just as a rename can, and a drop
sends nothing but the campaign. And a character playing in a session that is still
running cannot be moved at all: refiling it would leave it in the running session of
a campaign it no longer belongs to, which is not something the players could make
sense of, so the drop is refused and says to end the session first.

**A character file knows its own characteristics.** A character is filed by
uploading the `.hdc` HERO Designer saved, and everything the app shows is worked
out from it. That file records *structure*, not presentation — a skill is
`XMLID="ACTING" LEVELS="1" BASECOST="3.0"`, and a characteristic is the levels
bought rather than the number a sheet prints — so reading it means computing
against the game system's rules, which is what
[ork-hero-export-renderer](https://github.com/AlexHowansky/ork-hero-export-renderer)
does.

`src/server/hero-sheet.ts` is the whole of this app's contact with that library.
SPD, DEX, CON, REC, END, STUN and BODY are the characteristics' totals rather
than their values, so a power or a talent that raises one is counted; INIT is not
a characteristic at all but the Lightning Reflexes talent, matched on
`LIGHTNING_REFLEXES_ALL` — the rules data gives a bonus bought for one kind of
action its own id, and a bonus that applies only to ranged attacks is not an
initiative bonus a fight can be ordered by. A character without the talent reads
INIT 0, because in HERO that is an answer rather than a gap.

It is server-side because the rules are megabytes of JSON on disk. So the dialog
asks: choosing a file splits it in the browser and posts the character half to
`POST /api/characters/stats`, which parses it, answers with the numbers, and
stores nothing. One implementation of "what does this file say", so the dialog
and the folder-drop path — which sends no boxes at all and is read from the
stored file — cannot disagree. The server puts the form first, since whatever the
dialog sent is what the game master saw and could have corrected, and bounds
anything it reads by the same `schemas.heroStat` a typed number passes through,
dropping what will not fit rather than refusing an upload over a characteristic
this table may never use.

Choosing a file **overwrites** what is in the boxes, including on a character
being edited: choosing a file is choosing what the character is, and that is what
uploading a replacement is for. It happens silently — the numbers appearing is
the message — and they are still the game master's to correct before saving.

**The rules data is not shipped, by anyone.** It is derived from Hero Games'
`*.hdt` files and is their copyrighted material, so neither this app nor the
renderer distributes it. An operator extracts it from their own copy of HERO
Designer with `bunx extract-rules /path/to/HD6.jar`, which writes it where the
app looks by default; `HERO_RULES_DIR` moves it elsewhere. Without it no sheet
can be drawn and no characteristic can be read, so the server says so at startup
rather than leaving it to be discovered mid-session — and the tests that need it
skip rather than fail, since it cannot be in CI either.

**The sheet is rendered, not stored.** What a game master or a player opens is
built from the character file on request, by applying an export template to the
stored `.hdc`. Nothing caches the result. Re-export a character, drop the file
back, and the next person to open it sees the new sheet, with nothing to
invalidate: the file *is* the character, and the sheet is what that character
looks like through today's template and today's rules.

**The template is the game master's own.** Each keeps their own collection of
`.hde` files, uploaded and chosen from `Template` in the settings drawer, and
each collection is private to the account that filed it. The one this app ships —
`assets/Ork-16x9.hde`, from
[Ork HERO Templates](https://github.com/AlexHowansky/ork-hero-templates) — is
always the first row of that list and cannot be deleted, so a game master who has
uploaded nothing still has working sheets and so does one who has removed
everything they uploaded. A sheet is drawn through the template of the game
master who *owns* the character rather than the one reading it, so a player and
their game master looking at the same character see the same page. Uploading a
template under a name that collection already has is that template being updated:
the row keeps its id, so re-exporting the one you are using does not cost you the
choice. The template in use cannot be deleted until another is chosen.

It costs about 30ms once the rules and the template are read, which they are once
per process rather than once per request — the rules once for the deployment, and
each template once. What is never held is the HTML they
produce. Rendering runs with the library's strict mode **off**: in strict mode
anything the renderer cannot work out stops the render with an explanation, which
is right for a command line and wrong for a game master who has just clicked a
character's name mid-fight — a blank where one line should be is recoverable, and
a blank page is not.

A character filed before the app read `.hdc` files has an HTML sheet stored
against it and there is nothing to render one from. That says so in those words,
naming the file the game master already has, rather than 404ing as though the
character were somebody else's.

**A character file contains the portrait already.** HERO Designer keeps the
character's picture inside the file, as base64 in a CDATA section, so asking the
game master to find and upload the same image a second time is work the app can
do itself. It becomes the character's card, and is taken back out of the stored
file rather than kept twice — the picture is nearly the whole of what one of
these files weighs. The fixture is 3.7 MB, of which all but 92 KB is a 1.3 MB
PNG: base64 in UTF-16 costs about three bytes for every one of the picture's.

There is exactly one place to look and one picture to find, which is the whole of
the difference from the HTML sheets this replaced. Those had to be *scanned* for
long runs of base64 or hex that decoded to something with image magic bytes, with
the largest one assumed to be the portrait, because no markup convention said
which image was which — the same picture turns up in an `img` tag, in a CSS
`url()`, and in a string a script assigns to `.src` at load time. What has not
changed is that only what is **embedded** counts: following a URL an uploaded
file names would let that file steer a request from the server, at whatever
address it likes, which is the whole of SSRF.

Nor has the other rule. **A picture the game master chose is never overruled**:
an image uploaded in the same request wins, a new file fills an empty picture but
never replaces an existing one, and a failure is logged and forgotten rather than
failing the upload, since a portrait nobody asked for is not worth an error.

**The browser takes the file apart before uploading it.** `src/client/hdc.ts`
decodes the `.hdc`, lifts the picture out, scales it to the size a card shows it
at and encodes it as WebP, and sends the character and the picture as two parts —
a 3.7 MB upload becomes tens of kilobytes, twice over, since the dialog also
sends the file to be read for its characteristics. It also means a character
whose embedded portrait would push the file past `UPLOAD_LIMIT_BYTES` can be
filed at all.

None of it is load-bearing. Every step falls back to handing the file over as it
arrived, because the server does all of this anyway for a file that reaches it
whole — through the API, or from a browser without an `OffscreenCanvas` that will
encode WebP. The server is still the authority on what a character's picture is.

Two details are easy to get wrong quietly, and both are why this code is not a
line of `TextDecoder`. These files are UTF-16 **big** endian with a byte-order
mark while the declaration inside says only `encoding="UTF-16"`, so the mark is
the authority and the declaration is not; and the picture sits in a CDATA
section, whose markers fed to a base64 decoder are an error rather than a few
stray bytes — a character with no card, indistinguishable from one that never had
a picture. `tests/client-hdc.test.ts` is named after both.

The picture arrives as its own form field, `sheetPortrait`, rather than as
`card`. `card` means *the game master picked this*, which outranks the remove
checkbox and outranks the file's own portrait; an auto-extracted picture arriving
under that name would silently replace a chosen card every time a new export was
uploaded. Under its own name it means what it is, and every precedence rule above
holds unchanged.

**The campaign being worked on is lit rather than merely outlined.** The card of
the selected campaign — the one whose characters fill the panel beside it — wears
daisyUI's `aura` in `aura-gold`, a conic gradient that turns behind the card with
two blurred copies of itself for the glow. It is a wrapper element rather than a
class on the card, so `CampaignCard` puts a `div` around the whole `HoverCard`
when it is selected.

Three classes make it sit right in the grid. `block`, because the component is
`inline-block` and an inline box would sit on the text baseline with a
descender's gap under it. A `--aura-padding` of its own, because every size
daisyUI ships is a hairline — `aura-xl` is four pixels — and a hairline is lost
behind a card whose artwork is already a printed gold frame; 6px reads as a glow
around the card rather than a highlight on its edge, and still leaves most of the
grid's `gap-4` between it and its neighbour. And `-m-1.5`, which is exactly that
padding pulled back out: without it the lit card would be twelve pixels narrower
than every card beside it, since the aura would take the difference out of a fixed
grid track — and a row of cards that change size as they are picked is worse than
no glow at all. Pulled back, the glow spills into the gap instead.
`tests/e2e.test.ts` measures a lit card against an unlit one for exactly that
reason.

The aura is also the *only* thing that says a campaign is selected. It replaced a
faint ring in the primary colour, which alongside the glow was two answers to one
question in colours that did not agree.

**A picture can be filed by dropping it on the card itself**, in the library, on
either kind of card: the `PATCH` that goes up carries only the picture, so the
server applies it exactly as it would from the dialog, and the card is redrawn
from what comes back. It is the one edit worth doing without a dialog at all —
the card is right there, and what it should look like is the whole of the
decision. The invitation is drawn *inside the well*, over the picture, rather
than as a ring around the card: a campaign card already wears a ring for a
character being refiled onto it, and a second would read as that one. The well says what a drop would actually replace. A card
also sits inside the panel that files a dropped character file as a new character, so
`useDropTarget` stops a drop it has claimed from travelling any further — the
innermost target that wants a file is the one that gets it, and one drop never
means two things.

**And so can a character's kind, with a key.** `P` and `N` over a card in the
library make it a player character or a non-player character — the same one-field
`PATCH` the picture drop sends. It exists because a dropped file arrives as an NPC (the
safer default), so filing a party of six meant six trips through the edit dialog
to say what anyone could see by looking at the card.

It says nothing when it works, which is the difference between it and the picture
drop beside it. The card redraws in the other kind's frame, foil arriving or
leaving with it, and that *is* the answer — a toast over a change the reader is
already looking at is one more thing to dismiss while going down a shelf a key at
a time. A failure still speaks, since that is the case where nothing visible
happens.

`useKindKeys` (`GmLibrary.tsx`) hangs the listener on the window rather than on
the cards: a key is pressed wherever the reader last clicked, and a card is not
focused merely by being hovered. It stands down for a key with a modifier on it
(`Ctrl-P` prints), a key held down (`event.repeat`, which would send a `PATCH` per
repeat), a key typed into a field, and any key at all while a dialog is open —
because a dialog covers the library, and a pointer that was over a card when one
opened is never told it has left.

Which card the key means is **a ref, not state** (`attendedId`), and that is the
part worth keeping. Nothing is drawn differently because the pointer is on a card
— the tilt and the hover border are the stylesheet's — so state here would
re-render the library for every card the pointer crossed, to no effect. It would
also be a re-render that can arrive too late: React ranks a pointer crossing a
boundary below a keystroke, so on a busy page the hover can still be uncommitted
when the key lands a few milliseconds behind it, and the key would be read against
the card the pointer was on *before*. A ref is true the instant the pointer
arrives. `onAttention` on `CharacterCard` is what reports it, and it reports the
keyboard's focus as well as the pointer, since a game master driving the page by
keyboard has no pointer and the card they are on is the card they mean.

Emptying the picture deliberately is what `Remove the current card image` is for — on both edit dialogs, and offered only when there is
one to remove. It outranks a portrait from a character file uploaded alongside it, and
loses to a picture chosen in the same submission, so neither box nor file has to
be undone by the other.

**The session library can reach past its own campaign.** `Show All NPCs` — the
other setting in the drawer — lists every monster a game master owns rather than
only the campaign's, so an ogre built for last year's game can be brought into
tonight's fight. Only monsters: a player character belongs to a player *in* a
campaign, and the claim a player holds is on that, so heroes stay where they are.
The server enforces exactly that (`routes/sessions.ts`, staging a character) —
without which the setting would be an offer the console could not honour — and
each borrowed row carries the name of the campaign it came from, since two
campaigns with a `Goblin` in each are otherwise two identical rows. The console
re-reads the library when the setting changes, so the list refills under the
reader's hand rather than on the next visit.

Switching it back **off** is the one setting change that can be refused. Turning
it off is what takes a borrowed monster out of the library, and doing that while
one is standing in a fight would leave a slot whose character the library no
longer lists — no count beside it, no sheet to open from there, no second copy to
add. So the server checks every running session of that game master first
(`sessionCharacters.borrowedNpcsForGm`) and answers 409 while any is on a stage.
The console greys the toggle out and says why in place of what the setting does,
but it cannot be the whole rule: it can only see its own fight, and a game master
may be running another in the next tab. Switching it *on* is never refused —
only the way back out closes, and only while something out there depends on it.

**How big a card is, is each game master's own setting.** It measures the
*picture* on a card; the frame around it and the name underneath make the card
itself larger — by a fixed amount, since the card is five by seven whatever the
picture size is. It used to be `CARD_IMAGE_PX`, one number the deployment set for
everybody, and it moved because it was never a fact about the deployment: a game
master on a laptop beside the table and one casting to a television want
different answers, and the server has no way to know which it is talking to.

So it lives on the `gms` row (migration `012`), the range it may take is stated
once in `lib/cards.ts` — the slider, the schema that checks what the slider sends
and the stored-picture size all read it from there — and it is dragged in the
settings drawer (`client/components/Settings.tsx`), which is on the game master's
screens for exactly the reason it is stored where it is: a player has no account
to keep a setting against, and their screens draw at the default.

Getting the number onto the page is the interesting part. It arrives with the
identity, on the `/api/auth/me` call the client already makes before it renders
anything, so there is no second round trip and no first paint at the wrong size.
`client/cardSize.ts` then writes it as an **inline** custom property on the
document element — `--card-image-size`, which is what the card grid is measured
in. Inline is what makes it win over the `:root` default in `styles.css` without
a specificity argument, and it is the same move `useColumnSplit` makes for a
dragged column: a value belonging to this page view, set on the page rather than
described in a rule. Nothing re-renders when it changes, and no component has to
know the setting exists — which is why dragging the slider reflows the library
behind the drawer for free. Signing out removes the property, so the next person
at that browser is not left with someone else's cards.

`styles.css` declares the same property with the default (176px), so a signed-out
page, a player's screen, and a game master whose settings never arrived are all
laid out correctly.

The grid track adds the card's border back on (`--card-border`), so the picture
is the size that was asked for rather than two pixels short of it — the one place
those two variables meet, and the reason the border width is a variable at all.

**Pictures are stored at the size they are looked at.** Every image the app shows
— a campaign's, a character's, and the portrait lifted out of a character file — ends up
in a square card, so keeping the 4000px photograph that was uploaded costs a game
master's phone several megabytes to draw a thumbnail. `fitToCard`
(`src/server/uploads.ts`, on the path every image upload takes) scales the
**shorter** side down to `limits.storedImagePx` — twice the *largest* card anyone
may ask for, which covers that card on a 2x screen exactly — since that is the
side that has to cover a square. Twice the largest rather than twice the reader's
own: a picture is stored once and looked at by game masters who have chosen
different sizes, so the only size that keeps all of them sharp is the biggest of
them. A table that never leaves the default pays for that in bytes, which is the
better way round — a picture stored soft cannot be made sharp again. Nothing is cropped: the card takes its square at display time,
and the rest of the picture is still in the file for anywhere it is shown
differently. Nothing is enlarged either, and one whose bytes sharp cannot read is
stored exactly as it arrived, since it passed the magic-byte check and a game
master would rather have their picture at full size than an error.

The browser does the same arithmetic before uploading a character file
(`src/client/hdc.ts`): the picture inside it is scaled to that same
`limits.storedImagePx` and encoded as WebP, so the upload is tens of kilobytes
rather than megabytes. `fitToCard` still runs on what arrives and is unchanged by
it — an already-small picture passes its "nothing is enlarged" check and is
returned as it came, which is what keeps the server correct for images arriving
from anywhere else without a branch for who sent them.

**And in the format that holds them in the fewest bytes**, which is rarely the
one they arrived in: a photograph saved as PNG is lossless data about a lossy
subject, and over the pictures this app had been given, WebP at quality 80 came
out about seven times smaller in total — one 2.3 MB card became 169 KB. So the
fitted picture is encoded as WebP as well, and whichever buffer is *actually*
smaller is the one stored, with `mime` following it. That comparison is the whole
rule, and it is there because re-encoding an already-lossy JPEG can make it
bigger — when it does, the original stands. Alpha survives, an animated GIF is
converted whole rather than flattened to its first frame, and what is *accepted*
is still decided by the magic bytes of the file as uploaded, never by the format
it ends up in.

This is the one thing in the app that needs a real library: `sharp`. It is a
native binding, which is a heavier dependency than anything else here, and it is
worth it — decoding and rescaling four image formats correctly is not something
to hand-roll.

**Asking before something irreversible is the app's own dialog.** Deleting a
campaign or a character, ending a session and removing a player all ask first,
and none of them uses `window.confirm`: the browser draws that in its own chrome,
so it arrives in the wrong typeface, ignores light and dark entirely, and shows a
name in curly quotes in whatever font the chrome happens to use. `ConfirmProvider`
(`src/client/components/Confirm.tsx`) puts the question in the same `Modal` every
other dialog uses, and hands the caller a promise, so the guard at the top of a
handler stays the one line it was — `if (!(await confirm({…}))) return;` — rather
than each route growing its own piece of open-question state. It is a provider for
the reason `ToastProvider` is one: the answer has to outlive the click that asked
for it. The one-line native message becomes a title and a body, the button that
goes through with it carries the verb rather than "OK" so it still says what will
happen when read on its own, and Escape, the ✕ and Cancel all mean no — the answer
a dialog dismissed by accident should give. It sits at `z-40` like `SheetOverlay`,
under the toasts at `z-50`, so the message about what just happened is still
readable over it.

**A page takes the whole window.** `AppPage` used to centre a column capped at
`max-w-6xl`, which is right for prose and wrong for panels of lists: a tall
monitor — wide enough for two columns, too tall to count as a dashboard by the
`wide` variant below — left two thirds of the glass empty while a panel inside it
needed a horizontal scrollbar. There is no cap now, and no page-level scroller;
where a row is genuinely tight it is the row that draws tighter, as `Vitals` does
by narrowing its boxes and gaps below `sm`.

**Wide screens get a dashboard, not a document.** A 16:9 monitor is much shorter
relative to its width than a phone, so a page that stacks its panels makes the
game master scroll away from the turn tracker mid-turn. A `wide` variant in
`src/client/styles.css` — keyed on the aspect ratio as well as the width, so a
portrait monitor is left alone — switches the session and library pages to a
frame exactly one viewport high, panels side by side, each scrolling its own
list. `AppPage` and `Panel`'s `scroll` prop in `src/client/components/ui.tsx`
carry this; the routes only choose how the panels divide the frame, and — on both
session pages, with `order` rather than a second copy of the markup — what
sequence they sit in once there are columns. The console goes one column, to two
equal halves, to three equal thirds, and the turn travels with the segment
panel the whole way: it is the same fight, so it sits above it and shares its
width rather than running the width of the page. The code travels with the
players in the same way — and stacked, `order-first` lifts it above everything,
since handing out the code is the first thing a game master does. On the player's page the column
wrappers are `display: contents` until the columns exist, so the four panels are
items of one column while stacked and `order` alone moves the player list below
the scene; nothing there grows, so a short list ends where its content does
instead of being stretched to the frame, and `scroll` is left on the two lists
only to catch the opposite case. Anything narrower or taller keeps the stacked
layout unchanged.

## Two kinds of number

A character carries seven HERO System characteristics, and three of them are
recorded twice. On the character they are the total — what SPEED, DEXTERITY,
INITIATIVE, RECOVERY, ENDURANCE, STUN and BODY *are* — and they change only when
the game master edits the library. On a stage slot, ENDURANCE, STUN and BODY are
recorded again as what that copy has left right now.

INITIATIVE is the odd one out and is deliberately its own column rather than
part of DEXTERITY: it is whatever moves a character up the order that DEX does
not already explain — Combat Reflexes and its like — and DEX has to keep meaning
DEX everywhere else it is read. It is the one characteristic whose name does not
explain itself, so it is also the one with hover text, which is why
`HERO_STAT_HINTS` sits beside the labels in `src/lib/hero.ts` rather than as a
string in the form.

The split is what makes two goblins two monsters. A slot is seeded from the
character's totals as it walks on (`sessionCharacters.add`, and the same columns
in `addCampaignPcs`) and is its own number from then on: one goblin beaten down
to 3 STUN stays there when its twin joins the fight, and a correction to the
library mid-session moves the total without healing anybody.

Which is why the totals live on `presentCharacter` — they are the character's,
and the REST character routes want them too — while the current values are added
in `buildSnapshot` (`src/server/session-state.ts`) beside the other things that
are true of a slot rather than of a character.

Who may read them is the same question as who may write them, which is why the
segment panel gates both on one prop: the game master's list is handed
`onSetVitals` and draws every row's numbers, a player's list is not and draws
none. What the monster has left is the game master's information to give out or
hold back at the table, and a player's own numbers are on their `My character`
panel rather than a second time in the scene.

The looked-up five — SPD, DEX, INIT, CON and REC — divide the same way, on `editable`:
the game master's rows carry them, since the segment panel is where the order is
worked out and those are what it is worked out from, and a player's rows carry
who is playing what instead. `StatLine` draws that line for both the game
master's rows and a player's own character panel, so the numbers are written
identically wherever they are read — the counterpart to `Vitals` for the three
that are spent.

**A box asks for the change, not the total.** What anyone at the table says is
"that's eleven STUN", never "you're on fourteen", so pressing a box opens a
dialog of every step from 50 off to 50 on and the app does the subtraction —
the arithmetic that goes wrong when it is done in someone's head in a hurry.
"Take" and "Recover" are separate blocks rather than one run through zero,
because a misread sign is a character knocked out by a heal, and the small
numbers come first in each because that is what dice produce. The old behaviour is still there
at the bottom of the dialog as "Or set it exactly", which is what a game master
setting a monster up actually wants.

Each box is coloured by how much of the total is left, so the state of a fight
reads off the panel before any of the numbers do. Where the boundaries fall is a
rule about characters rather than about colours, so it lives in `bandFor`
(`src/lib/hero.ts`) with the characteristics themselves, and the component is
left only mapping each band onto a daisyUI tone — `error`, `warning`, `success` —
which each theme then draws in its own red, yellow and green.

A Recovery is a button, but the arithmetic is not: `POST
/api/sessions/:id/stage/:slotId/recover` does it in one `UPDATE`, adding RECOVERY
to both current values and capping each at the character's total. Two screens are
looking at the same monster and one of them is always slightly behind, so a
button that computed the new number from what it happened to be showing would
lose one of two Recoveries pressed at once. Its neighbour, `…/rest`, is the same
shape and the blunter instrument: END and STUN set straight to the totals, BODY
untouched.

**STUN sends the hit, and the other two send the total.** A hit bigger than a
character's CON stuns them in HERO, and that is a rule about the size of one hit
— which a new total cannot say. Nine STUN off a goblin is one hit or three, or a
game master fixing a number they mistyped, and the three mean different things.
So the STUN box sends `stunTaken` and the server does the subtraction, in one
`UPDATE` for the Recovery button's reason: two hits landing at once must both
land. END and BODY go on sending totals, because nothing turns on how big a
change to them was, and `enduranceTaken` would be shape nothing asks for. The two
may not arrive together, and `schemas.setVitals` refuses a body carrying both.

`Or set it exactly` is deliberately on the other side of that line: it is the
control for putting a number right, so it writes a total and never stuns. The
rules themselves are `consequencesOfTheHit` (`src/server/routes/sessions.ts`),
which reads the slot back after the hit is written — so the numbers it judges are
the ones the hit left behind — and asks two questions in the order they happen to
a character: was that more than their CON, and is there any STUN left. Each puts
its condition on with the same `setTag` the button uses, so a table takes it off
the way they take off any other, and each declines for a character already in that
condition: the tag is on, and a character being beaten on would otherwise fill the
log with one line.

Both decline for a characteristic left at nought, which matters more than it
looks. Zero is what an unfilled characteristic reads as everywhere in this app, so
a CON of nought treated as a threshold would stun a half-typed character on every
scratch, and a STUN total of nought — which is also where that character's slot
starts — would knock them out on the first one. One hit can answer both questions
yes, and then both conditions go on, both lines are written and both toasts are
sent, in that order: a character can be stunned without going down, and can go
down without ever being stunned.

Those two and `PATCH /api/sessions/:id/stage/:slotId/vitals` are the routes both
roles may call, and all of them share one authorization helper —
`requireSlotAccess` — so there is one answer to who may change a slot
rather than four that could drift apart. The game master runs the fight and may write any slot; a player may write exactly
the slot holding the character they claimed, checked on the server rather than by
hiding the boxes. Both end in the same `publish`, so an edit from either screen
reaches every screen the usual way. `src/lib/hero.ts` names the eight
characteristics once, for the form fields, the labels and the API alike.

## The log is state, not a notice

Everything the table does is broadcast as a *snapshot*: the whole of what is true
now, rebuilt and republished on every change. There is one exception —
`broadcastSessionNotice`, which says something out loud once and keeps nothing.
That is right for a toast: a client reconnecting five minutes later should not be
told about the Post-Segment 12 Recovery it missed.

Not every notice is the whole table's, though. A character stunned by a hit is
the business of whoever is running the fight and whoever is playing that
character, and a toast about it on the other five screens is noise about a
monster whose numbers they cannot see anyway. So `sendSessionNotice` is the
narrow one: it walks the open sockets and sends to the game master's and to one
player's, the way `disconnectPlayer` finds a kicked player's, because a topic is
exactly the thing that cannot be narrowed. It carries a tone with it, since a
notice that is not good news should not arrive in the green the Recovery does —
absent, which is what the Post-Segment 12 notice still sends, the screen keeps
its own default.

The log is deliberately on the other side of that line. It rides the snapshot,
because a history that only lived in the browsers watching at the time would not
be a history: a reload would empty it, and a player who joins an hour in would
see nothing of the hour. The first line makes the case on its own — a session is
started before any screen is watching it, so `Session started` can only ever be
read out of the database.

So `session_events` is a table, `sessionEvents.record` is how anything writes to
it, and `buildSnapshot` carries the tail of it to every screen. What the lines
actually *say* is `src/server/events.ts`, and it is a module of its own for two
reasons: the log has a voice, and a voice stays consistent only when it is in one
place to be read; and the events are written from three modules — the session
routes, the auth routes, and the socket's own grace-period removal — of which
`ws.ts` cannot import from `routes/sessions.ts` without closing a cycle.

The voice is one rule: past tense, and whoever acted is the subject. The clock is
the single line that breaks it — `Turn 2 Segment 3` names nobody, because what it
records is where the fight is rather than who pressed Next. The rule is that
the clock announces every segment it is *placed at*: `advanceTurn` writes one
where the walk lands, the session's own creating transaction writes `Turn 1
Segment 12`, and Restart writes it again on the way back. That is why stepping
from one character to the next inside a segment writes nothing — the marker moved
and the clock did not — and why the first press of `Next` in a fresh fight is
silent: the segment it opens was named when the session was made. What the rule
buys is that every line in the log sits under a segment the log has named. Nothing else was
needed: every mutating route already ends in `publish`, and `websocket.open`
already replays the current snapshot to a reconnecting client, so the log follows
both without a route or a socket message of its own.

The table is unbounded and the wire is not. `LOG_LIMIT` in `queries.ts` trims
each snapshot to the most recent two hundred lines — far more than the drawer can
show, and small enough that a fight running for hours is not sending hours of
history down the wire every time somebody presses a button.

On screen it is a drawer rather than a panel, opened from the `Log` control in
the upper left. It pushes the columns aside rather than covering them, because it
is the one overlay in the app you might want open *while* you work; every other
one — the sheet, the modals — is something you deal with and dismiss. Below
`lg:` there is no width to give up, so there it is a block above the page
instead.

## The turn chime

When the turn reaches a player's character, that player — and only that player —
gets a toast and a two-note chime. The chime is synthesised with the Web Audio
API (`src/client/ding.ts`) rather than shipped as a file, so there is no asset to
serve and nothing to add to the page's CSP.

Browsers refuse to start audio for a page nobody has interacted with. A player
has always clicked their way in by the time a turn can reach them, so it plays in
practice, but every step is best effort and the toast carries the message on its
own if audio is refused.

Announcing the turn is deliberately about *changes*: the snapshot that arrives on
a reconnect or a page load says nothing has changed, so a player who was already
up is not chimed at again. The alert is keyed on the turn and the segment as well
as the character, so a SPD 12 hero is announced for each of their twelve phases
rather than once for the whole turn.

## Character sheets

A sheet is not uploaded and not stored. What is stored is the `.hdc` HERO
Designer saved; the sheet is built from it on every request, by applying the
owning game master's export template to the file — the one this app ships
(`assets/Ork-16x9.hde`) until they upload and choose another. Nothing caches the
result, so re-exporting a character and dropping the file back is the whole of
keeping their sheet current.

The stored file is kept as it arrived, with one exception: when the picture
inside it becomes the character's card, that picture is taken back out
(`removeImage`, `src/server/uploads.ts`). Keeping both is keeping the same image
twice, and the copy inside the file is much the larger one — a card is fitted on
the way in, while the file carries whatever HERO Designer was given, as base64 in
UTF-16 at about three bytes for every one of the picture's. It is also nearly all
of what one of these files weighs: the fixture is 3.7 MB, and 92 KB of that is
the character. The rendered sheet therefore has no portrait on it, which is the
trade: the picture lives on the card, which is where this app shows it. A file
that cannot be rewritten is left alone and keeps its picture; the card still
stands either way.

**The sheet is still not this app's markup to trust.** It is output this app
generated, but a character's own fields carry whatever CSS and web fonts the game
master wrote into HERO Designer — the fixture puts a Google Fonts `@import` and a
`.character-name` rule in its Campaign Use box — and the export template is a
document in its own right. So it is served exactly as the uploaded HTML sheets
were: with a `sandbox` Content-Security-Policy, embedded in an iframe that
repeats it as an attribute, deliberately *without* `allow-same-origin`. That
gives the document an opaque origin — its scripts run, but it cannot read the
app's cookies or storage, reach into the surrounding page, or call the API as the
signed-in user. A sheet that tries gets a `SecurityError` for `document.cookie`
and a CORS rejection from `origin: null` for any fetch; both are asserted in
`tests/e2e.test.ts`. `Cache-Control: private, no-store` is doubly true now: there
is no stored artifact to go stale.

A sheet that will not build answers **500**, not 404. Everything above it in that
route is a 404 on purpose — "this is not yours to see", said identically whether
or not the character exists, so ids cannot be probed — and a character that is
yours and would not render is a different problem. A game master told the wrong
one of those goes looking for the wrong thing.

**A sheet is shown as its template wrote it.** Whichever of the three places it is
opened from — the library preview, the session console, the player's `My sheet` — it goes
through one `SheetOverlay` (`components/SheetFrame.tsx`), and there is nothing of
ours around it: no title bar, no border, no rounding, no padding. A sheet is a
whole page laid out by a template of its own, and a strip of our own chrome would both take
the room and change the shape it is laid out in. The one thing over it is the close
control, in the *window's* top right rather than the sheet's, so it stays in the
same place whatever size the sheet is drawn at. It is an `IconButton`, the same
one a card's icons are, because that is already built to stay readable over
something we know nothing about — here either the dimmed page or the sheet itself.

Escape closes the sheet, and so does a click on the dimmed page around it. The
button is not a convenience on top of those two: a sandboxed cross-origin frame
takes the focus when a reader clicks into a sheet, and no keystroke reaches this
page again until they click back out, so Escape alone would strand them.

It is drawn in the window's own aspect ratio, so a sheet written for a 16:9 screen
gets one. `--sheet-size` is a single percentage and it sets *both* dimensions,
which is what makes the ratio come out right without any measuring: at the default
of 90 the sheet is nine tenths of the window's width and nine tenths of its height
— the same shape, smaller, with the dimmed page still showing around it — and at
100 it fills the viewport outright. The deployment picks the number with
`SHEET_WIDTH_PCT`, which reaches the browser through `/appearance.css` exactly as
the card size does.

Who may read a sheet:

| | Sheets they can open |
| --- | --- |
| Game master | every character in their own campaigns |
| Player | only the character they have claimed, through `My sheet` |
| Anyone else | none — the route returns 404, never 403 |

## Deployment

The app expects a TLS-terminating reverse proxy in front of it.

```bash
bun install --production
bunx extract-rules /path/to/HD6.jar   # once, and again after a HERO Designer update
bun run cli db:migrate
NODE_ENV=production bun run start
```

Set `TRUSTED_PROXY=1` so `X-Forwarded-For` is honoured for rate limiting and
logs. Without it the forwarded header is ignored — otherwise anyone could spoof
it to escape a rate limit — and the socket address is used instead.

In production the app builds the client at startup and serves the document
itself, so the HTML carries the same headers every other response does —
`X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-Content-Type-Options`,
`Referrer-Policy` and `Cross-Origin-Opener-Policy`. It is framed by nobody
without a proxy having to arrange it.

Development is the exception: there the document is served by Bun's bundler, which
is what rebuilds the client as a file is saved, and a bundler-served response is
outside the app's headers. A development instance is therefore framable, which is
a reason not to expose one.

The proxy is still worth setting `frame-ancestors` at. `X-Frame-Options` is
honoured by every current browser, but it is the older mechanism, and the CSP
directive is the one that will outlive it — the `<meta>` CSP in the page cannot
carry `frame-ancestors`, as it is header-only. It goes in the proxy block below.

That policy is `'self'` throughout with two exceptions, both for `CARD_FONT_URL`:
`fonts.googleapis.com` in `style-src` for the stylesheet, and
`fonts.gstatic.com` in `font-src` for the font files it points at. They are
allowed whether or not a font is configured, since the policy is static, and they
mean a reader's browser contacts Google when one is. A deployment that wants a
different provider — or none of this at all — edits the tag in
`src/client/index.html` and the host list in `src/lib/config.ts` together; they
are deliberately kept in step so a URL the policy would block is refused with a
log line rather than failing silently in the browser.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # required for live updates
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Belt and braces: the app sets HSTS and X-Frame-Options on its own responses
    # in production. `frame-ancestors` is the modern spelling of the second and
    # cannot go in the page's <meta> policy, so it is worth having here too.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy   "frame-ancestors 'none'" always;

    client_max_body_size 10m;   # matching UPLOAD_LIMIT_BYTES
}
```

The `Upgrade` headers are not optional: without them the WebSocket cannot
connect and player screens stop updating live.

Back up `data/` — it holds both the database and every uploaded file.

## Security notes

- **Passwords** are argon2id (`Bun.password`). Sign-in failures return one
  message whatever the cause, and an unknown address still runs a verify, so
  neither the wording nor the timing reveals which addresses have accounts.
- **Session tokens** are 256 bits of CSPRNG output, stored only as a SHA-256
  hash, so a leaked database cannot be replayed as live sessions.
- **Session codes** are 60 bits (12 characters, ambiguous glyphs excluded so
  they can be read aloud). Joining is rate limited, and a code stops resolving
  the moment its session ends, so guessing one is not a practical attack.
- **SQL** is parameterised throughout; every statement lives in
  `src/db/queries.ts` and nothing interpolates into SQL.
- **CSRF**: cookies are `SameSite=Lax`, and mutating requests must additionally
  present a same-origin `Sec-Fetch-Site` or a matching `Origin`. There are no
  form posts. The WebSocket handshake is held to the same rule, which matters
  more there than anywhere else: a handshake is exempt from CORS, so nothing in
  the browser refuses one another site opened.
- **Uploads** are checked by content, not by name — images by magic bytes, so an
  HTML payload named `.png` is rejected. Files are stored outside any served
  directory and reached only through authorised routes, under a generated name —
  the id of the `uploads` row that describes them, so a file found on its own
  names its own row. The uploaded filename is kept as metadata and never reaches
  the filesystem, so there is no path to traverse out of. Delivery still resolves
  `disk_path` rather than rebuilding the path from the id, so rows predating that
  naming rule keep working and files can be rehomed.
- **Uploaded pictures** are reached by entitlement rather than by being signed
  in: a game master sees the cards in their own library, and a player sees the
  campaign they are sitting at and whoever is on their stage. The ids are random,
  so nobody guesses one; the rule is what stops an id that gets out — a
  screenshot, a browser history, a proxy log — from being readable by every
  account on the instance.
- **Character sheets** are rendered from the stored character file rather than
  uploaded, but they still carry whatever CSS and web fonts the game master wrote
  into the character, so they are served under a `sandbox` CSP with no
  `allow-same-origin`. That puts them in an opaque origin: script still runs, but
  it cannot reach this app's cookies, storage, DOM or authenticated API.
- **The page itself** is served by the app in production, so it carries
  `X-Frame-Options: DENY` and the rest of the response headers rather than
  depending on a proxy to add them. See Deployment for what development does
  instead, and why.
- **Errors** shown to a user never carry internal detail; anything unexpected is
  logged in full server-side and reported as one generic line.
- **Logs** are JSON lines with a request id, and redact passwords, tokens,
  cookies and session codes.

## Tests

```bash
bun test           # unit and HTTP integration
bun run test:e2e   # the above plus real-browser tests
bun run typecheck
```

The browser tests cover what only exists in a live page — the segment panel's
segment filter narrowing one reader's list without touching anyone else's, dragging
a character card onto another campaign, player screens updating without a refresh,
a sheet opening in the window's own shape, and the sheet sandbox holding. They need Playwright's
Chromium (`bunx playwright install chromium`) and are skipped without it.

Anything that computes a characteristic or renders a sheet needs the HERO rules
data, which is not in this repository and cannot be in CI. Those tests skip
without it rather than failing — `rulesAvailable` in `tests/helpers.ts` is the
gate — so a run with `HERO_RULES_DIR` set covers more than one without. The
tests that only read and store a character file run either way.

In development you may see a console warning that an inline script was blocked
by the page CSP. That is Bun's hot-reload injection; the production build
contains no inline scripts.

## License

MIT — see [LICENSE](LICENSE).

Font Awesome's free icons are bundled under the terms of their own license: the
icon artwork is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and
the surrounding code is MIT, both © Fonticons, Inc. Everything else under
`art/` and `assets/` is original to this project and covered by the MIT license
above.

This project is not affiliated with, endorsed by, or sponsored by Hero Games.
HERO System and Champions are trademarks of their respective owners; they are
used here only to describe what the tool is for.
