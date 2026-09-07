/** Row shapes as they come back from SQLite. */

export type CharacterKind = "pc" | "npc";
export type SessionStatus = "active" | "ended";
export type UploadKind = "sheet" | "image";

export interface GmRow {
  id: string;
  email: string;
  password_hash: string;
  /** How big this game master has asked for cards to be drawn, in CSS pixels. */
  card_image_px: number;
  /** 1 when their session library should reach past the session's own campaign. */
  show_all_npcs: number;
  /**
   * The export template their character sheets are rendered through, or null for
   * the one this app ships — which is what a game master who has never chosen
   * means, and the only answer that needs no row to exist.
   */
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GmAuthSessionRow {
  id: string;
  gm_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
}

export interface UploadRow {
  id: string;
  kind: UploadKind;
  disk_path: string;
  mime: string;
  byte_size: number;
  sha256: string;
  original_name: string;
  created_at: string;
}

/** A HERO Designer export template a game master has uploaded. */
export interface TemplateRow {
  id: string;
  gm_id: string;
  /** What the template calls itself, from its own `<!--TEMPLATE_NAME-->`. */
  name: string;
  original_name: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignRow {
  id: string;
  gm_id: string;
  name: string;
  card_upload_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterRow {
  id: string;
  campaign_id: string;
  kind: CharacterKind;
  name: string;
  sheet_upload_id: string;
  card_upload_id: string | null;
  /** HERO System characteristics. `endurance`, `stun` and `body` are the full totals. */
  speed: number;
  dexterity: number;
  initiative: number;
  constitution: number;
  recovery: number;
  endurance: number;
  stun: number;
  body: number;
  created_at: string;
  updated_at: string;
}

export interface GameSessionRow {
  id: string;
  campaign_id: string;
  gm_id: string;
  code: string;
  status: SessionStatus;
  active_slot_id: string | null;
  /**
   * Whose phase a character cut into when they took a held action. The next step
   * of the clock hands the turn back to them rather than walking on from the
   * interruption, and clears this. Null whenever nothing is pending, which is
   * nearly always.
   */
  resume_slot_id: string | null;
  turn: number;
  /** Which of the twelve segments of that turn the session has reached. */
  segment: number;
  created_at: string;
  ended_at: string | null;
}

export interface PlayerRow {
  id: string;
  game_session_id: string;
  name: string;
  token_hash: string;
  claimed_character_id: string | null;
  joined_at: string;
}

/**
 * A slot on the stage, joined with the library character standing in it.
 *
 * `id` is inherited from `CharacterRow` and is still the *character*; the slot's
 * own identity is `slot_id`. They are different things now that one character can
 * occupy two slots, and the join is the only place both are in hand.
 */
export interface SessionCharacterRow extends CharacterRow {
  slot_id: string;
  copy_number: number;
  position: number;
  /**
   * What this slot has left, as against the totals it inherits from the
   * character. Seeded from those totals when the slot is added, and its own
   * number from then on.
   */
  cur_endurance: number;
  cur_stun: number;
  cur_body: number;
  /** Whether this copy is holding its action. 0 or 1, as SQLite keeps a flag. */
  held: number;
}

/**
 * One line of a session's log.
 *
 * The message is stored as the sentence it will be read as, rather than as a
 * code to be composed at read time: the log is a record of what was true then,
 * and a character renamed afterwards must not rewrite the line about what they
 * did.
 */
export interface SessionEventRow {
  id: string;
  game_session_id: string;
  message: string;
  created_at: string;
}
