/** Shapes returned by the API, mirroring src/server/presenters.ts. */

export type CharacterKind = "pc" | "npc";

export interface Campaign {
  id: string;
  name: string;
  cardUrl: string | null;
  createdAt: string;
}

export interface Character {
  id: string;
  campaignId: string;
  kind: CharacterKind;
  name: string;
  sheetUrl: string;
  cardUrl: string | null;
  /**
   * The HERO System characteristics. `endurance`, `stun` and `body` are the
   * character's full totals; what one copy of them has left in a session is on
   * `SessionCharacter` instead.
   */
  speed: number;
  dexterity: number;
  initiative: number;
  constitution: number;
  recovery: number;
  endurance: number;
  stun: number;
  body: number;
}

/**
 * A slot on the stage.
 *
 * `id` is the slot, not the character: it is the React key, and what a turn or a
 * removal names. The character in it is `characterId` —
 * what a claim is about, and what two copies of one NPC share. `sheetUrl` is the
 * character's too, so both copies open the same sheet.
 */
export interface SessionCharacter extends Character {
  characterId: string;
  /** Which copy of that character this is. Shown only when there is more than one. */
  copyNumber: number;
  /** The order it came on stage. Only the tiebreak between equal DEX+INIT. */
  position: number;
  /** What this slot has left, against the totals above. Two goblins differ. */
  currentEndurance: number;
  currentStun: number;
  currentBody: number;
  /**
   * What condition this copy is in: the conditions the app knows by name first,
   * then any the table typed. Per slot, like the numbers above.
   */
  statusTags: string[];
  /** Whether this copy is holding its action, waiting to cut back into the order. */
  isHeld: boolean;
  claimedByPlayerId: string | null;
  claimedByPlayerName: string | null;
}

export interface SessionPlayer {
  id: string;
  name: string;
  claimedCharacterId: string | null;
}

export interface GameSession {
  id: string;
  campaignId: string;
  campaignName: string;
  code: string;
  status: "active" | "ended";
  turn: number;
  segment: number;
  playerCount: number;
  createdAt: string;
  endedAt: string | null;
}

/**
 * One line of the session's log.
 *
 * `at` is the ISO instant the server wrote it. What o'clock that is is worked
 * out here, because the reader's machine is the only thing that knows which time
 * zone they are sitting in.
 */
export interface SessionEvent {
  id: string;
  message: string;
  at: string;
}

export interface Snapshot {
  session: {
    id: string;
    status: string;
    /** How many HERO Turns of twelve segments the fight has reached. */
    turn: number;
    /** Which of those twelve segments it is on. Always 1–12. */
    segment: number;
    /** The campaign's name: what heads a player's screen. */
    campaignName: string;
    activeSlotId: string | null;
  };
  players: SessionPlayer[];
  characters: SessionCharacter[];
  /** The log, oldest first. Only the tail of it; the server bounds how much. */
  events: SessionEvent[];
}

/**
 * One export template in the list a game master picks from.
 *
 * The template this app ships is a row like any other, and `builtIn` is the only
 * thing that marks it out: it is the one that cannot be deleted.
 */
export interface TemplateSummary {
  id: string;
  name: string;
  builtIn: boolean;
  originalName: string;
  createdAt: string | null;
}

export type Identity =
  | { kind: "anonymous" }
  | {
      kind: "gm";
      gm: {
        id: string;
        email: string;
        cardImagePx: number;
        showAllNpcs: boolean;
        templateId: string;
      };
    }
  | {
      kind: "player";
      player: { id: string; name: string; sessionId: string; claimedCharacterId: string | null };
    };
