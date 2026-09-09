/**
 * Every line the log can carry.
 *
 * One module rather than a string at each call site, for two reasons.
 *
 * The first is that the log has a voice, and a voice is only consistent if it is
 * in one place to be read. These are the sentences a table will scroll back
 * through at midnight trying to work out when somebody went; they should sound
 * like they were written together, because they were.
 *
 * The second is circular imports. The events are written from three modules —
 * the session routes, the auth routes, and the socket's own grace-period
 * removal — and `ws.ts` cannot import from `routes/sessions.ts`, which already
 * imports from `ws.ts`. Somewhere neutral is the only place all three can reach.
 *
 * Builders rather than templates at the call site, so a test asserts on the same
 * string the server writes rather than on a copy of it that can drift.
 *
 * Two rules hold the wording together. Every line is in the past tense and names
 * the person, because a log line is read long after the moment it describes:
 * `Ada joined` still makes sense an hour later, where "joined" on its own does
 * not. And **whoever acted is the subject of the sentence** — the players' own
 * doings in their names, the game master's in theirs — so that reading back
 * through a night tells you not only what the table came to be, but who made it
 * so. The routes can always tell: a player's claim and the game master's
 * assignment are separate endpoints behind separate authorisations.
 *
 * The clock is the one exception, and it is at the bottom with its reasons.
 */

import { markTag, STATUS_TAG_LABELS } from "../lib/hero.ts";

export const SESSION_STARTED = "Session started";

/** The subject of every line about something the game master did. */
export const GAME_MASTER = "The game master";

/* ------------------------------------------------------------ the players' */

export const playerJoined = (name: string): string => `${name} joined`;

export const playerSelected = (name: string, character: string): string =>
  `${name} selected ${character}`;

export const playerLeft = (name: string): string => `${name} left`;

/**
 * Nobody pressed anything for this one — a browser closed and the grace period
 * ran out — which is exactly why it is worth writing down. It is the only way of
 * leaving the table that no one at the table saw happen.
 */
export const playerDisconnected = (name: string): string => `${name} was disconnected`;

/* ------------------------------------------------------ the game master's */

export const gmAssigned = (character: string, name: string): string =>
  `The game master assigned ${character} to ${name}`;

export const gmUnassigned = (character: string, name: string): string =>
  `The game master unassigned ${character} from ${name}`;

/**
 * One line rather than an unassignment and an assignment, because it was one
 * action by one person. Two would also read as a moment when the character was
 * held by nobody, which never happened.
 */
export const gmReassigned = (character: string, from: string, to: string): string =>
  `The game master reassigned ${character} from ${from} to ${to}`;

export const gmKicked = (name: string): string => `The game master kicked ${name}`;

/**
 * Written *after* the log is emptied, so a cleared log says who emptied it
 * rather than coming back as a blank drawer that reads like a fault.
 */
export const LOG_CLEARED = "The game master cleared the log";

export const gmAddedToScene = (character: string): string =>
  `The game master added ${character} to the scene`;

export const gmRemovedFromScene = (character: string): string =>
  `The game master removed ${character} from the scene`;

/* ------------------------------------------------------------- either of them */

/**
 * What condition a character is in — the one thing both roles change through the
 * same endpoint, since being knocked prone happens to your character and saying
 * so is part of playing it.
 *
 * So these are the only builders that take their subject rather than knowing it:
 * the route names the game master or the player who pressed, and the rule that
 * whoever acted is the subject of the sentence holds either way.
 *
 * A list rather than one tag because one hit commonly leaves a character both
 * prone and stunned, and a caller with the pair in hand should be able to say so
 * in one line. Today's route sets one tag per press and passes one.
 *
 * The conditions themselves are marked with `markTag`, so the log can draw each
 * as the pill the character's row draws it as. The sentence is still a sentence
 * with the marks in it — see the note on `markTag`.
 */
const marked = (tags: string[]): string => tags.map(markTag).join(", ");

export const tagsAdded = (actor: string, tags: string[], character: string): string =>
  `${actor} added ${marked(tags)} to ${character}`;

export const tagsRemoved = (actor: string, tags: string[], character: string): string =>
  `${actor} removed ${marked(tags)} from ${character}`;

/**
 * A held action, and the taking of it.
 *
 * Two lines rather than one about "holding": what a table looks back for is the
 * moment somebody cut in, and a line only at the start would leave the log
 * saying a character was waiting with no record of them ever going.
 */
export const actionHeld = (actor: string, character: string): string =>
  `${actor} held ${character}'s action`;

export const actionTaken = (actor: string, character: string): string =>
  `${actor} took ${character}'s held action`;

/* -------------------------------------------------------------- the rules' */

/**
 * A character stunned by the size of the hit that landed on them.
 *
 * The second line in this module with nobody in it, and for a different reason
 * than the clock's: somebody pressed the button that did the damage, but nobody
 * decided this. A hit bigger than a character's CON stuns them because that is
 * what the rules say, and writing it as `The game master stunned Goblin 2` would
 * credit a person with a ruling they only rolled dice for — and would read as a
 * game master who had reached for the Stunned button, which is a different thing
 * a table would want to be able to tell apart in the log.
 *
 * So the character is the subject and the rule is the verb — and the line says
 * which rule, because a table reading back will want to know why a condition
 * they did not set appeared. The condition itself is marked with `markTag` like
 * every other line about one, so the log draws it as the pill on the character's
 * row rather than as a word that happens to name it.
 *
 * The tag is fixed rather than passed in, unlike `tagsAdded`: this line is only
 * ever about the one condition, and it is the rule's own sentence rather than a
 * report of whatever somebody pressed.
 */
export const becameStunned = (character: string): string =>
  `${character} has taken more STUN than CON ${markTag(STATUS_TAG_LABELS.stunned)}`;

/**
 * A character knocked out by the STUN running out.
 *
 * The same shape as the line above and for the same reasons — nobody decided it,
 * so nobody is named; the rule it came from is in the sentence, so a table can
 * see why a condition they did not set appeared; and the condition is marked, so
 * it draws as the pill.
 *
 * Both can be true of one hit, and then both lines are written. That is not a
 * repetition to be collapsed: a character can be stunned without going down, and
 * can go down without ever being stunned, so which of the two happened — or that
 * it was both at once — is exactly what a table reads the log back for.
 */
export const knockedOut = (character: string): string =>
  `${character} has had STUN reduced to zero ${markTag(STATUS_TAG_LABELS.unconscious)}`;

/**
 * A character shaking off the stun by coming up on turn.
 *
 * The third line the rules write for themselves, and the first of them that is
 * good news. Nobody decided it either: being stunned costs a character their
 * next phase and ends with it, so the clock arriving on them is the whole of the
 * ruling, and naming the game master who pressed Next would credit them with it.
 *
 * The one line about a condition with no `markTag` in it. Every other one names
 * the condition and so draws it as the pill on the character's row; this one
 * names the end of it, and a Stunned pill in a sentence saying the character is
 * no longer stunned would say the opposite of the line it sits in.
 */
export const becameUnstunned = (character: string): string =>
  `${character} has become unstunned`;

/* ------------------------------------------------------------- the clock's */

/**
 * The one line with nobody in it.
 *
 * Every other event here names whoever acted, because somebody did. A segment
 * beginning is the fight's own clock moving, and while a game master pressed
 * Next to get there, what the line records is where the fight now is rather than
 * who pressed what — so it is written the way a marker on a table is written,
 * flat and without a verb. It is also the line that gives all the others their
 * place: read back through a night, the events between two of these are what
 * happened in that segment.
 */
export const segmentBegan = (turn: number, segment: number): string =>
  `Turn ${turn} Segment ${segment}`;
