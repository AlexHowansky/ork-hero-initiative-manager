/**
 * Shapes database rows into the JSON the client consumes.
 *
 * Kept separate from the routes so that the WebSocket snapshot and the REST
 * responses describe a character the same way, and so neither has to import the
 * other.
 */

import type { CampaignRow, CharacterRow, GameSessionRow, GmRow, PlayerRow, TemplateRow } from "../db/types.ts";
import { BUILT_IN_TEMPLATE_ID } from "../lib/templates.ts";

/**
 * A game master as their own console sees them: who they are, and how they have
 * asked the app to behave.
 *
 * One shape for both the answer to signing in and the answer to "who am I",
 * because arriving already signed in and signing in this minute should leave the
 * console in the same state. The settings ride along with the identity rather
 * than behind a call of their own, so they are in hand before the first render.
 *
 * Never a password hash, and never a timestamp nobody has asked for: this is a
 * hand-written list rather than a spread of the row for exactly that reason.
 */
export function presentGm(gm: GmRow) {
  return {
    id: gm.id,
    email: gm.email,
    cardImagePx: gm.card_image_px,
    // Stored as SQLite's 0 or 1; a boolean is what the browser wants.
    showAllNpcs: gm.show_all_npcs === 1,
    // NULL is the template this app ships; the browser gets it as an id like any
    // other, so a `<select>` has one kind of value to hold. This is the only
    // place that translation happens on the way out.
    templateId: gm.template_id ?? BUILT_IN_TEMPLATE_ID,
  };
}

export function presentCampaign(campaign: CampaignRow) {
  return {
    id: campaign.id,
    name: campaign.name,
    cardUrl: campaign.card_upload_id
      ? `/uploads/images/${campaign.card_upload_id}`
      : null,
    createdAt: campaign.created_at,
  };
}

/**
 * One of a game master's export templates, as their settings drawer lists it.
 *
 * `builtIn` rather than an absent id, so the list the drawer holds is one shape
 * throughout: the template this app ships is a row like any other, and the only
 * one that says it cannot be deleted.
 */
export function presentTemplate(template: TemplateRow) {
  return {
    id: template.id,
    name: template.name,
    builtIn: false,
    originalName: template.original_name,
    createdAt: template.created_at,
  };
}

export function presentCharacter(character: CharacterRow) {
  return {
    id: character.id,
    campaignId: character.campaign_id,
    kind: character.kind,
    name: character.name,
    sheetUrl: `/characters/${character.id}`,
    cardUrl: character.card_upload_id
      ? `/uploads/images/${character.card_upload_id}`
      : null,
    // The HERO characteristics. `endurance`, `stun` and `body` are the full
    // totals; what a copy of this character has left in a session is a separate
    // number, carried on the stage slot rather than here.
    speed: character.speed,
    dexterity: character.dexterity,
    initiative: character.initiative,
    constitution: character.constitution,
    recovery: character.recovery,
    endurance: character.endurance,
    stun: character.stun,
    body: character.body,
  };
}

/**
 * The game master's view of a session, including the code they hand out.
 *
 * `playerCount` is passed in rather than looked up here, so a list of sessions
 * can count them all in one query.
 */
export function presentSessionForGm(
  session: GameSessionRow,
  campaign: CampaignRow,
  playerCount: number,
) {
  return {
    id: session.id,
    campaignId: session.campaign_id,
    campaignName: campaign.name,
    code: session.code,
    status: session.status,
    turn: session.turn,
    segment: session.segment,
    playerCount,
    createdAt: session.created_at,
    endedAt: session.ended_at,
  };
}

export function presentPlayer(player: PlayerRow) {
  return {
    id: player.id,
    name: player.name,
    claimedCharacterId: player.claimed_character_id,
  };
}
