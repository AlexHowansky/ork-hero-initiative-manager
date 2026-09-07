/**
 * Every SQL statement in the application lives here.
 *
 * Keeping them in one module means the parameterisation can be audited in one
 * place: there is no string interpolation into SQL anywhere in this file, and no
 * other module builds SQL of its own.
 */

import { db, fromNow, now } from "./index.ts";
import { limits } from "../lib/config.ts";
import { sortTags } from "../lib/hero.ts";
import { newId } from "../lib/ids.ts";
import { compareNames } from "../lib/names.ts";
import type {
  CampaignRow,
  CharacterKind,
  CharacterRow,
  GameSessionRow,
  GmAuthSessionRow,
  GmRow,
  PlayerRow,
  SessionCharacterRow,
  SessionEventRow,
  TemplateRow,
  UploadKind,
  UploadRow,
} from "./types.ts";

/* ---------------------------------------------------------------- game masters */

export const gms = {
  byEmail(email: string): GmRow | null {
    return db.query<GmRow, { email: string }>("SELECT * FROM gms WHERE email = $email")
      .get({ email });
  },

  byId(id: string): GmRow | null {
    return db.query<GmRow, { id: string }>("SELECT * FROM gms WHERE id = $id").get({ id });
  },

  all(): GmRow[] {
    return db.query<GmRow, []>("SELECT * FROM gms ORDER BY email").all();
  },

  create(email: string, passwordHash: string): GmRow {
    const timestamp = now();
    const id = newId();
    db.query(`
      INSERT INTO gms (id, email, password_hash, created_at, updated_at)
      VALUES ($id, $email, $passwordHash, $timestamp, $timestamp)
    `).run({ id, email, passwordHash, timestamp });
    return gms.byId(id)!;
  },

  update(
    id: string,
    changes: {
      email?: string;
      passwordHash?: string;
      cardImagePx?: number;
      showAllNpcs?: boolean;
      /** null is the template this app ships, which is what no choice means. */
      templateId?: string | null;
    },
  ): void {
    if (changes.email !== undefined) {
      db.query("UPDATE gms SET email = $email, updated_at = $ts WHERE id = $id")
        .run({ id, email: changes.email, ts: now() });
    }
    if (changes.passwordHash !== undefined) {
      db.query("UPDATE gms SET password_hash = $hash, updated_at = $ts WHERE id = $id")
        .run({ id, hash: changes.passwordHash, ts: now() });
      // A password change invalidates every existing browser session.
      db.query("DELETE FROM gm_auth_sessions WHERE gm_id = $id").run({ id });
    }
    if (changes.cardImagePx !== undefined) {
      db.query("UPDATE gms SET card_image_px = $px, updated_at = $ts WHERE id = $id")
        .run({ id, px: changes.cardImagePx, ts: now() });
    }
    if (changes.showAllNpcs !== undefined) {
      // SQLite has no boolean; the column is the 0 or 1 every other flag in this
      // schema is written as.
      db.query("UPDATE gms SET show_all_npcs = $on, updated_at = $ts WHERE id = $id")
        .run({ id, on: changes.showAllNpcs ? 1 : 0, ts: now() });
    }
    if (changes.templateId !== undefined) {
      db.query("UPDATE gms SET template_id = $templateId, updated_at = $ts WHERE id = $id")
        .run({ id, templateId: changes.templateId, ts: now() });
    }
  },

  remove(id: string): void {
    db.query("DELETE FROM gms WHERE id = $id").run({ id });
  },
};

/* -------------------------------------------------------------- gm auth sessions */

export const gmAuthSessions = {
  create(gmId: string, tokenHash: string): GmAuthSessionRow {
    const id = newId();
    const timestamp = now();
    db.query(`
      INSERT INTO gm_auth_sessions
        (id, gm_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at)
      VALUES ($id, $gmId, $tokenHash, $ts, $expires, $absolute, $ts)
    `).run({
      id,
      gmId,
      tokenHash,
      ts: timestamp,
      expires: fromNow(limits.gmSessionTtlMs),
      absolute: fromNow(limits.gmSessionMaxMs),
    });
    return db.query<GmAuthSessionRow, { id: string }>(
      "SELECT * FROM gm_auth_sessions WHERE id = $id",
    ).get({ id })!;
  },

  /** Returns the GM behind a live token, or null if it is unknown or expired. */
  resolve(tokenHash: string): { session: GmAuthSessionRow; gm: GmRow } | null {
    const session = db.query<GmAuthSessionRow, { tokenHash: string; ts: string }>(`
      SELECT * FROM gm_auth_sessions
      WHERE token_hash = $tokenHash
        AND expires_at > $ts
        AND absolute_expires_at > $ts
    `).get({ tokenHash, ts: now() });
    if (!session) return null;
    const gm = gms.byId(session.gm_id);
    return gm ? { session, gm } : null;
  },

  /** Extends the sliding window, never past the absolute expiry. */
  touch(id: string): void {
    db.query(`
      UPDATE gm_auth_sessions
      SET last_seen_at = $ts,
          expires_at = MIN($slidingExpiry, absolute_expires_at)
      WHERE id = $id
    `).run({ id, ts: now(), slidingExpiry: fromNow(limits.gmSessionTtlMs) });
  },

  remove(tokenHash: string): void {
    db.query("DELETE FROM gm_auth_sessions WHERE token_hash = $tokenHash").run({ tokenHash });
  },

  /** Housekeeping: drop rows that can no longer authenticate anyone. */
  purgeExpired(): number {
    return db.query(
      "DELETE FROM gm_auth_sessions WHERE expires_at <= $ts OR absolute_expires_at <= $ts",
    ).run({ ts: now() }).changes;
  },
};

/* ------------------------------------------------------------------- uploads */

export const uploads = {
  /**
   * `id` is accepted rather than always minted here so a caller that has already
   * written the file can name it after the row it is about to insert — see
   * `persist` in `server/uploads.ts`. A caller with no file to match, such as a
   * test fixture, leaves it out and gets a fresh one.
   */
  create(input: {
    id?: string;
    kind: UploadKind;
    diskPath: string;
    mime: string;
    byteSize: number;
    sha256: string;
    originalName: string;
  }): UploadRow {
    const id = input.id ?? newId();
    db.query(`
      INSERT INTO uploads (id, kind, disk_path, mime, byte_size, sha256, original_name, created_at)
      VALUES ($id, $kind, $diskPath, $mime, $byteSize, $sha256, $originalName, $ts)
    `).run({ ...input, id, ts: now() });
    return uploads.byId(id)!;
  },

  byId(id: string): UploadRow | null {
    return db.query<UploadRow, { id: string }>("SELECT * FROM uploads WHERE id = $id").get({ id });
  },

  remove(id: string): void {
    db.query("DELETE FROM uploads WHERE id = $id").run({ id });
  },

  /** Every row, for the sweep that looks for files no row claims. */
  all(): UploadRow[] {
    return db.query<UploadRow, []>("SELECT * FROM uploads").all();
  },

  /**
   * Records that a stored file has been rewritten in place — which one upload
   * does: a sheet has its portrait taken out of it once that picture is a card.
   * The path and the type do not change, only what the file now weighs and
   * hashes to.
   */
  rewrite(id: string, input: { byteSize: number; sha256: string }): void {
    db.query("UPDATE uploads SET byte_size = $byteSize, sha256 = $sha256 WHERE id = $id")
      .run({ ...input, id });
  },

  /**
   * Upload rows that nothing references any more. The caller deletes the files
   * from disk and then removes these rows.
   */
  /**
   * Whether an image is one this game master's own library carries.
   *
   * The two places a picture can be a card: on a campaign, or on a character in
   * one. Both are reached through `campaigns.gm_id`, which is the only thing
   * that says who a picture belongs to — an `uploads` row itself has no owner,
   * because a file is not the thing that is owned. The character arm is what
   * covers a monster borrowed onto a stage from another of their campaigns,
   * which is still theirs (`characters.listForGm` never leaves a game master's
   * own campaigns).
   *
   * A picture nothing references at all is nobody's, and so is visible to
   * nobody — the honest answer for an orphan a sweep has not caught yet.
   */
  isVisibleToGm(uploadId: string, gmId: string): boolean {
    return db.query<{ ok: number }, { uploadId: string; gmId: string }>(`
      SELECT 1 AS ok WHERE
        EXISTS (
          SELECT 1 FROM campaigns
          WHERE card_upload_id = $uploadId AND gm_id = $gmId
        )
        OR EXISTS (
          SELECT 1 FROM characters c
          JOIN campaigns cp ON cp.id = c.campaign_id
          WHERE c.card_upload_id = $uploadId AND cp.gm_id = $gmId
        )
    `).get({ uploadId, gmId }) !== null;
  },

  /**
   * Whether an image is one this session actually puts on screen.
   *
   * A player is entitled to the pictures of their own table and no others: the
   * campaign they are sitting at, and whoever is standing on the stage. Stage
   * membership rather than campaign membership is the test for a character,
   * because that is what the snapshot hands them — a monster borrowed from
   * another campaign is on their stage and drawn on their screen, while the rest
   * of the cast of their own campaign is not yet in the fight and is none of
   * their business.
   */
  isVisibleInSession(uploadId: string, sessionId: string): boolean {
    return db.query<{ ok: number }, { uploadId: string; sessionId: string }>(`
      SELECT 1 AS ok WHERE
        EXISTS (
          SELECT 1 FROM game_sessions gs
          JOIN campaigns cp ON cp.id = gs.campaign_id
          WHERE gs.id = $sessionId AND cp.card_upload_id = $uploadId
        )
        OR EXISTS (
          SELECT 1 FROM session_characters sc
          JOIN characters c ON c.id = sc.character_id
          WHERE sc.game_session_id = $sessionId AND c.card_upload_id = $uploadId
        )
    `).get({ uploadId, sessionId }) !== null;
  },

  orphaned(): UploadRow[] {
    return db.query<UploadRow, []>(`
      SELECT * FROM uploads
      WHERE id NOT IN (SELECT card_upload_id FROM campaigns WHERE card_upload_id IS NOT NULL)
        AND id NOT IN (SELECT card_upload_id FROM characters WHERE card_upload_id IS NOT NULL)
        AND id NOT IN (SELECT sheet_upload_id FROM characters)
    `).all();
  },
};

/* ------------------------------------------------------------------ templates */

/**
 * Export templates, which are a game master's own rather than the deployment's.
 *
 * Not `uploads` rows, and deliberately: that table's `kind` admits two values
 * behind a CHECK, its orphan sweep is an allowlist of the three columns that
 * reference a file, and a row in it has no owner. A template is owned — each
 * game master keeps their own collection — and nothing else references it but
 * the `gms` row that has it selected.
 */
export const templates = {
  /**
   * `id` is accepted rather than minted here for the same reason `uploads.create`
   * accepts one: the file is written first, named after the row about to
   * describe it.
   */
  create(input: {
    id?: string;
    gmId: string;
    name: string;
    byteSize: number;
    sha256: string;
    originalName: string;
  }): TemplateRow {
    const id = input.id ?? newId();
    const timestamp = now();
    db.query(`
      INSERT INTO templates
        (id, gm_id, name, original_name, byte_size, sha256, created_at, updated_at)
      VALUES ($id, $gmId, $name, $originalName, $byteSize, $sha256, $timestamp, $timestamp)
    `).run({ ...input, id, timestamp });
    return templates.byId(id)!;
  },

  byId(id: string): TemplateRow | null {
    return db.query<TemplateRow, { id: string }>("SELECT * FROM templates WHERE id = $id")
      .get({ id });
  },

  /** The one this game master already has under this name, if they have one. */
  byName(gmId: string, name: string): TemplateRow | null {
    return db.query<TemplateRow, { gmId: string; name: string }>(
      "SELECT * FROM templates WHERE gm_id = $gmId AND name = $name COLLATE NOCASE",
    ).get({ gmId, name });
  },

  listForGm(gmId: string): TemplateRow[] {
    return db.query<TemplateRow, { gmId: string }>(
      "SELECT * FROM templates WHERE gm_id = $gmId ORDER BY name COLLATE NOCASE",
    ).all({ gmId });
  },

  /** Every row, for the sweep that looks for files no row claims. */
  all(): TemplateRow[] {
    return db.query<TemplateRow, []>("SELECT * FROM templates").all();
  },

  /**
   * Records that a stored template has been rewritten in place — which is what a
   * re-upload under a name this game master already has is: the same template,
   * exported again. The row keeps its id, so a template that was in use stays in
   * use across the update.
   */
  rewrite(id: string, input: { byteSize: number; sha256: string; originalName: string }): void {
    db.query(`
      UPDATE templates
      SET byte_size = $byteSize, sha256 = $sha256, original_name = $originalName, updated_at = $ts
      WHERE id = $id
    `).run({ ...input, id, ts: now() });
  },

  remove(id: string): void {
    db.query("DELETE FROM templates WHERE id = $id").run({ id });
  },
};

/* ------------------------------------------------------------------ campaigns */

export const campaigns = {
  listForGm(gmId: string): CampaignRow[] {
    return db.query<CampaignRow, { gmId: string }>(
      "SELECT * FROM campaigns WHERE gm_id = $gmId ORDER BY name COLLATE NOCASE",
    ).all({ gmId });
  },

  byId(id: string): CampaignRow | null {
    return db.query<CampaignRow, { id: string }>("SELECT * FROM campaigns WHERE id = $id")
      .get({ id });
  },

  create(input: { gmId: string; name: string; cardUploadId: string | null }): CampaignRow {
    const id = newId();
    const timestamp = now();
    db.query(`
      INSERT INTO campaigns (id, gm_id, name, card_upload_id, created_at, updated_at)
      VALUES ($id, $gmId, $name, $cardUploadId, $timestamp, $timestamp)
    `).run({ ...input, id, timestamp });
    return campaigns.byId(id)!;
  },

  update(
    id: string,
    changes: { name?: string; cardUploadId?: string | null },
  ): CampaignRow | null {
    if (changes.name !== undefined) {
      db.query("UPDATE campaigns SET name = $name, updated_at = $ts WHERE id = $id")
        .run({ id, name: changes.name, ts: now() });
    }
    if (changes.cardUploadId !== undefined) {
      db.query(
        "UPDATE campaigns SET card_upload_id = $upload, updated_at = $ts WHERE id = $id",
      ).run({ id, upload: changes.cardUploadId, ts: now() });
    }
    return campaigns.byId(id);
  },

  remove(id: string): void {
    db.query("DELETE FROM campaigns WHERE id = $id").run({ id });
  },

  /** Whether another campaign already holds this name (names are globally unique). */
  nameTaken(name: string, exceptId?: string): boolean {
    const row = db.query<{ id: string }, { name: string; exceptId: string }>(
      "SELECT id FROM campaigns WHERE name = $name AND id != $exceptId",
    ).get({ name, exceptId: exceptId ?? "" });
    return row !== null;
  },
};

/* ----------------------------------------------------------------- characters */

/**
 * The HERO System characteristics a library character carries.
 *
 * Named once here because three places speak in them: creating a character,
 * editing one, and seeding a stage slot from the totals.
 */
export interface HeroStats {
  speed: number;
  dexterity: number;
  initiative: number;
  constitution: number;
  recovery: number;
  endurance: number;
  stun: number;
  body: number;
}

/** Fills in the zero the column would have defaulted to, for a partial set. */
function zeroedStats(stats: Partial<HeroStats> | undefined): HeroStats {
  return {
    speed: stats?.speed ?? 0,
    dexterity: stats?.dexterity ?? 0,
    initiative: stats?.initiative ?? 0,
    constitution: stats?.constitution ?? 0,
    recovery: stats?.recovery ?? 0,
    endurance: stats?.endurance ?? 0,
    stun: stats?.stun ?? 0,
    body: stats?.body ?? 0,
  };
}

export const characters = {
  /**
   * The library, in name order.
   *
   * By name alone rather than by kind first: the cards carry a badge saying which
   * is which, so grouping them only made a character harder to find by the one
   * thing the reader knows about it.
   *
   * Ordered here rather than in the `SELECT`, which is the one place in this file
   * that sorts outside SQL. The rule is `compareNames` — a name files under its
   * first real word, so "The Crimson Fist" goes with the Cs — and `bun:sqlite`
   * offers no way to register a collation, so an `ORDER BY` could only be a
   * second copy of it in a language that cannot be made to agree. A library is a
   * campaign's cast; there is no page of them to sort a piece at a time.
   */
  listForGm(gmId: string, campaignId?: string): CharacterRow[] {
    const rows = campaignId
      ? db.query<CharacterRow, { gmId: string; campaignId: string }>(`
          SELECT c.* FROM characters c
          JOIN campaigns cp ON cp.id = c.campaign_id
          WHERE cp.gm_id = $gmId AND c.campaign_id = $campaignId
        `).all({ gmId, campaignId })
      : db.query<CharacterRow, { gmId: string }>(`
          SELECT c.* FROM characters c
          JOIN campaigns cp ON cp.id = c.campaign_id
          WHERE cp.gm_id = $gmId
        `).all({ gmId });
    return rows.sort((a, b) => compareNames(a.name, b.name));
  },

  byId(id: string): CharacterRow | null {
    return db.query<CharacterRow, { id: string }>("SELECT * FROM characters WHERE id = $id")
      .get({ id });
  },

  create(input: {
    campaignId: string;
    kind: CharacterKind;
    name: string;
    sheetUploadId: string;
    cardUploadId: string | null;
    /** The HERO characteristics, each defaulting to the zero the column carries. */
    stats?: Partial<HeroStats>;
  }): CharacterRow {
    const id = newId();
    const timestamp = now();
    const { stats, ...rest } = input;
    db.query(`
      INSERT INTO characters
        (id, campaign_id, kind, name, sheet_upload_id, card_upload_id,
         speed, dexterity, initiative, constitution, recovery, endurance, stun, body,
         created_at, updated_at)
      VALUES ($id, $campaignId, $kind, $name, $sheetUploadId, $cardUploadId,
         $speed, $dexterity, $initiative, $constitution, $recovery, $endurance, $stun, $body,
         $timestamp, $timestamp)
    `).run({ ...rest, ...zeroedStats(stats), id, timestamp });
    return characters.byId(id)!;
  },

  update(
    id: string,
    changes: {
      campaignId?: string;
      kind?: CharacterKind;
      name?: string;
      sheetUploadId?: string;
      cardUploadId?: string | null;
    } & Partial<HeroStats>,
  ): CharacterRow | null {
    // One fixed statement per column, rather than assembling a SET clause. It is
    // more lines, but it keeps the invariant for this whole file simple enough to
    // check at a glance: no SQL here is ever built by string concatenation.
    const ts = now();
    if (changes.campaignId !== undefined) {
      db.query("UPDATE characters SET campaign_id = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.campaignId });
    }
    if (changes.kind !== undefined) {
      db.query("UPDATE characters SET kind = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.kind });
    }
    if (changes.name !== undefined) {
      db.query("UPDATE characters SET name = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.name });
    }
    if (changes.sheetUploadId !== undefined) {
      db.query("UPDATE characters SET sheet_upload_id = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.sheetUploadId });
    }
    if (changes.cardUploadId !== undefined) {
      db.query("UPDATE characters SET card_upload_id = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.cardUploadId });
    }
    // The characteristics take the same one-statement-per-column shape, written
    // out rather than looped so the SQL above stays literal top to bottom.
    if (changes.speed !== undefined) {
      db.query("UPDATE characters SET speed = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.speed });
    }
    if (changes.dexterity !== undefined) {
      db.query("UPDATE characters SET dexterity = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.dexterity });
    }
    if (changes.initiative !== undefined) {
      db.query("UPDATE characters SET initiative = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.initiative });
    }
    if (changes.constitution !== undefined) {
      db.query("UPDATE characters SET constitution = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.constitution });
    }
    if (changes.recovery !== undefined) {
      db.query("UPDATE characters SET recovery = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.recovery });
    }
    if (changes.endurance !== undefined) {
      db.query("UPDATE characters SET endurance = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.endurance });
    }
    if (changes.stun !== undefined) {
      db.query("UPDATE characters SET stun = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.stun });
    }
    if (changes.body !== undefined) {
      db.query("UPDATE characters SET body = $value, updated_at = $ts WHERE id = $id")
        .run({ id, ts, value: changes.body });
    }
    return characters.byId(id);
  },

  remove(id: string): void {
    db.query("DELETE FROM characters WHERE id = $id").run({ id });
  },

  nameTaken(campaignId: string, name: string, exceptId?: string): boolean {
    const row = db.query<{ id: string }, { campaignId: string; name: string; exceptId: string }>(`
      SELECT id FROM characters
      WHERE campaign_id = $campaignId AND name = $name AND id != $exceptId
    `).get({ campaignId, name, exceptId: exceptId ?? "" });
    return row !== null;
  },
};

/* -------------------------------------------------------------- game sessions */

export const gameSessions = {
  byId(id: string): GameSessionRow | null {
    return db.query<GameSessionRow, { id: string }>("SELECT * FROM game_sessions WHERE id = $id")
      .get({ id });
  },

  /** Only an active session resolves from a code; ending one revokes it. */
  activeByCode(code: string): GameSessionRow | null {
    return db.query<GameSessionRow, { code: string }>(
      "SELECT * FROM game_sessions WHERE code = $code AND status = 'active'",
    ).get({ code });
  },

  /**
   * The campaign's running session, if it has one.
   *
   * A campaign runs one session at a time — enforced by a partial unique index,
   * so this can never be the first of several.
   */
  activeForCampaign(campaignId: string): GameSessionRow | null {
    return db.query<GameSessionRow, { campaignId: string }>(
      "SELECT * FROM game_sessions WHERE campaign_id = $campaignId AND status = 'active'",
    ).get({ campaignId });
  },

  /**
   * The game master's sessions, by campaign name.
   *
   * A session is only ever named after its campaign on screen, so that is what
   * the reader scans for; ordering by age instead made a list of them shuffle
   * itself every time one was started. Campaign names are unique per game
   * master, and a campaign runs one session at a time, so the name settles the
   * order on its own — `created_at` only breaks the tie between an ended session
   * and a later one on the same campaign.
   */
  listForGm(gmId: string): GameSessionRow[] {
    return db.query<GameSessionRow, { gmId: string }>(`
      SELECT s.* FROM game_sessions s
      JOIN campaigns cp ON cp.id = s.campaign_id
      WHERE s.gm_id = $gmId
      ORDER BY cp.name COLLATE NOCASE, s.created_at DESC
    `).all({ gmId });
  },

  create(input: { campaignId: string; gmId: string; code: string }): GameSessionRow {
    const id = newId();
    db.query(`
      INSERT INTO game_sessions (id, campaign_id, gm_id, code, status, turn, segment, created_at)
      VALUES ($id, $campaignId, $gmId, $code, 'active', 1, 12, $ts)
    `).run({ ...input, id, ts: now() });
    return gameSessions.byId(id)!;
  },

  end(id: string): void {
    db.query(
      "UPDATE game_sessions SET status = 'ended', ended_at = $ts WHERE id = $id AND status = 'active'",
    ).run({ id, ts: now() });
  },

  /**
   * Points the turn marker at a stage slot, or nowhere, and says where on the
   * clock that is.
   *
   * The three move together because they are one position: a slot without the
   * turn and segment it was reached on is not a place in the fight, and writing
   * them separately would let a broadcast catch the pair half updated.
   */
  setTurn(id: string, slotId: string | null, turn: number, segment: number): void {
    db.query(
      "UPDATE game_sessions SET active_slot_id = $slotId, turn = $turn, segment = $segment WHERE id = $id",
    ).run({ id, slotId, turn, segment });
  },

  /**
   * Whose phase a held action cut into, for the clock to hand back to. Null
   * clears it.
   *
   * Written apart from `setTurn` rather than with it, because the two change
   * independently: releasing a hold sets both, and the step that spends this
   * moves the marker while clearing it.
   */
  setResume(id: string, slotId: string | null): void {
    db.query("UPDATE game_sessions SET resume_slot_id = $slotId WHERE id = $id")
      .run({ id, slotId });
  },
};

/* --------------------------------------------------------- session membership */

/**
 * A Recovery, as SQL: RECOVERY back into both ENDURANCE and STUN.
 *
 * Written once because it is taken two ways — by one slot catching its breath,
 * and by the whole stage after Segment 12 — and the two must agree about what a
 * Recovery is. Neither total is exceeded and neither number goes down, so a slot
 * already above its total by some temporary boost keeps what it has. The
 * arithmetic is done in the statement rather than read out and written back, so
 * two Recoveries arriving at once cannot lose one of them.
 *
 * Bound with `$sessionId`; a caller wanting one slot appends `AND id = $slotId`.
 */
const RECOVERY_UPDATE = `
  UPDATE session_characters SET
    cur_endurance = MAX(
      cur_endurance,
      MIN(
        (SELECT endurance FROM characters WHERE id = character_id),
        cur_endurance + (SELECT recovery FROM characters WHERE id = character_id)
      )
    ),
    cur_stun = MAX(
      cur_stun,
      MIN(
        (SELECT stun FROM characters WHERE id = character_id),
        cur_stun + (SELECT recovery FROM characters WHERE id = character_id)
      )
    )
  WHERE game_session_id = $sessionId
`;

export const sessionCharacters = {
  /**
   * How many monsters borrowed from another campaign are standing in one of this
   * game master's running fights.
   *
   * The question `Show All NPCs` has to ask before it can be switched off: the
   * setting is what puts a foreign monster within reach, and turning it off while
   * one is on a stage would leave a slot whose character the library no longer
   * lists — no count beside it, no sheet to open from there, no second copy to
   * add. Rather than tidy that up behind the reader's back, the setting stays on
   * until the stages are clear.
   *
   * Active sessions only. An ended fight is a record of what happened, not a
   * thing anybody is looking at a library against.
   */
  borrowedNpcsForGm(gmId: string): number {
    return db.query<{ count: number }, { gmId: string }>(`
      SELECT COUNT(*) AS count
      FROM session_characters sc
      JOIN game_sessions gs ON gs.id = sc.game_session_id
      JOIN characters c     ON c.id  = sc.character_id
      WHERE gs.gm_id = $gmId
        AND gs.status = 'active'
        AND c.kind = 'npc'
        AND c.campaign_id <> gs.campaign_id
    `).get({ gmId })!.count;
  },

  /**
   * The stage in initiative order, each slot joined with the character in it.
   *
   * The order is derived rather than stored: HERO runs a segment in DEX order,
   * plus whatever INITIATIVE bonus the sheet carries, highest first. Sorting
   * here rather than writing positions when a character walks on means the list
   * is right the moment a DEX is edited, and there is nowhere for a stored order
   * to drift out of agreement with the characteristics it was built from.
   *
   * `position` survives only as the tiebreak: two characters on the same DEX+INIT
   * go in the order they came on stage, which is stable and is at least a reason.
   */
  list(sessionId: string): SessionCharacterRow[] {
    return db.query<SessionCharacterRow, { sessionId: string }>(`
      SELECT c.*, sc.id AS slot_id, sc.copy_number, sc.position,
             sc.cur_endurance AS cur_endurance, sc.cur_stun AS cur_stun, sc.cur_body AS cur_body,
             sc.held AS held
      FROM session_characters sc
      JOIN characters c ON c.id = sc.character_id
      WHERE sc.game_session_id = $sessionId
      ORDER BY (c.dexterity + c.initiative) DESC, sc.position
    `).all({ sessionId });
  },

  /**
   * Whether this character is on the stage at all, in any number of copies.
   *
   * The question the claim paths ask, since a player claims a character rather
   * than one of its slots — and only PCs can be claimed, which never have more
   * than one. Turn-setting asks `slotExists` instead.
   */
  isMember(sessionId: string, characterId: string): boolean {
    const row = db.query<{ character_id: string }, { sessionId: string; characterId: string }>(`
      SELECT character_id FROM session_characters
      WHERE game_session_id = $sessionId AND character_id = $characterId
    `).get({ sessionId, characterId });
    return row !== null;
  },

  /** Whether this slot is one of the session's. */
  slotExists(sessionId: string, slotId: string): boolean {
    const row = db.query<{ id: string }, { sessionId: string; slotId: string }>(
      "SELECT id FROM session_characters WHERE game_session_id = $sessionId AND id = $slotId",
    ).get({ sessionId, slotId });
    return row !== null;
  },

  /**
   * Which character is standing in a slot.
   *
   * What a player's edit is checked against: they may spend their own
   * character's ENDURANCE and take their own STUN, and nobody else's.
   */
  characterInSlot(sessionId: string, slotId: string): string | null {
    const row = db.query<{ character_id: string }, { sessionId: string; slotId: string }>(
      "SELECT character_id FROM session_characters WHERE game_session_id = $sessionId AND id = $slotId",
    ).get({ sessionId, slotId });
    return row?.character_id ?? null;
  },

  /**
   * A Recovery: the character catches their breath, and gets their RECOVERY back
   * in both ENDURANCE and STUN. What that means exactly is `RECOVERY_UPDATE`.
   */
  takeRecovery(sessionId: string, slotId: string): void {
    db.query(`${RECOVERY_UPDATE} AND id = $slotId`).run({ sessionId, slotId });
  },

  /**
   * The same Recovery, taken by everyone on the stage at once.
   *
   * This is the Post-Segment 12 Recovery, which HERO gives to every character in
   * the fight rather than to one of them, so it is one statement over the stage
   * rather than a loop of the statement above: the whole stage recovers or none
   * of it does, and the snapshot that follows cannot catch it half applied.
   */
  takeRecoveryAll(sessionId: string): void {
    db.query(RECOVERY_UPDATE).run({ sessionId });
  },

  /**
   * A rest: back to full ENDURANCE and STUN.
   *
   * Set to the character's totals rather than raised towards them — a night's
   * sleep is the end of the bookkeeping for a fight, so a slot left above its
   * total by some temporary boost comes back to what the character actually is.
   * BODY is untouched: in HERO that heals over days, not overnight, and putting
   * it here would quietly undo a wound the game master is still tracking.
   */
  takeRest(sessionId: string, slotId: string): void {
    db.query(`
      UPDATE session_characters SET
        cur_endurance = (SELECT endurance FROM characters WHERE id = character_id),
        cur_stun = (SELECT stun FROM characters WHERE id = character_id)
      WHERE game_session_id = $sessionId AND id = $slotId
    `).run({ sessionId, slotId });
  },

  /**
   * A hit: this much STUN off what the slot has left.
   *
   * The subtraction is done in the statement rather than read out and written
   * back, for `RECOVERY_UPDATE`'s reason turned the other way round — two hits
   * landing at once must both land, and a total computed by whichever screen
   * pressed first would swallow the other. It is also what lets the caller be
   * told how big the hit was, which is the one thing a rule about hits needs and
   * a new total cannot say.
   *
   * The floor is the one the API takes anyway (`schemas.setVitals`), so a run of
   * presses on a character already well past nought cannot walk the number off
   * the end of what can be saved. Nothing else is bounded: a HERO character at
   * -8 STUN is unconscious, not invalid.
   */
  takeStun(sessionId: string, slotId: string, amount: number): void {
    db.query(`
      UPDATE session_characters SET cur_stun = MAX(cur_stun - $amount, -999)
      WHERE game_session_id = $sessionId AND id = $slotId
    `).run({ sessionId, slotId, amount });
  },

  /**
   * Writes what a slot has left. Absent values are left as they were, so a
   * screen that edits one box does not have to send the other two.
   *
   * One fixed statement per column, as everywhere else in this file.
   */
  setVitals(
    sessionId: string,
    slotId: string,
    values: { endurance?: number; stun?: number; body?: number },
  ): void {
    if (values.endurance !== undefined) {
      db.query(`
        UPDATE session_characters SET cur_endurance = $value
        WHERE game_session_id = $sessionId AND id = $slotId
      `).run({ sessionId, slotId, value: values.endurance });
    }
    if (values.stun !== undefined) {
      db.query(`
        UPDATE session_characters SET cur_stun = $value
        WHERE game_session_id = $sessionId AND id = $slotId
      `).run({ sessionId, slotId, value: values.stun });
    }
    if (values.body !== undefined) {
      db.query(`
        UPDATE session_characters SET cur_body = $value
        WHERE game_session_id = $sessionId AND id = $slotId
      `).run({ sessionId, slotId, value: values.body });
    }
  },

  /* ------------------------------------------------------------ status tags */

  /**
   * Every tag on every slot in a session, as slot id to tags.
   *
   * Read in one go rather than a query per row: the snapshot wants the whole
   * stage anyway, and this is the shape `buildSnapshot` can hand each row from
   * without asking again. `players.countsForGm` is the same idea.
   *
   * The lists come back sorted for display (`sortTags`), so nothing downstream
   * has to know that the known conditions lead and typed ones follow.
   *
   * `remove` says nothing about tags on purpose: they hang off the slot with
   * ON DELETE CASCADE, so a copy leaving the stage takes them with it.
   */
  tags(sessionId: string): Map<string, string[]> {
    const rows = db.query<{ slot_id: string; tag: string }, { sessionId: string }>(`
      SELECT t.session_character_id AS slot_id, t.tag
      FROM session_character_tags t
      JOIN session_characters sc ON sc.id = t.session_character_id
      WHERE sc.game_session_id = $sessionId
    `).all({ sessionId });

    const bySlot = new Map<string, string[]>();
    for (const row of rows) {
      const existing = bySlot.get(row.slot_id);
      if (existing) existing.push(row.tag);
      else bySlot.set(row.slot_id, [row.tag]);
    }
    for (const [slotId, list] of bySlot) bySlot.set(slotId, sortTags(list));
    return bySlot;
  },

  /**
   * Puts a tag on a slot or takes it off, according to `active`.
   *
   * The desired state rather than a flip, so saying it twice says the same thing
   * — a retried request, a double-tapped button, or two people reaching for
   * Prone at once all leave one prone character. `INSERT OR IGNORE` is what
   * makes the second one quiet rather than a constraint violation.
   *
   * Both statements reach the row through `session_characters`, so a slot id
   * belonging to another session writes nothing at all rather than writing a row
   * the foreign key happens to accept.
   */
  setTag(sessionId: string, slotId: string, tag: string, active: boolean): void {
    if (active) {
      db.query(`
        INSERT OR IGNORE INTO session_character_tags (session_character_id, tag, added_at)
        SELECT id, $tag, $ts FROM session_characters
        WHERE game_session_id = $sessionId AND id = $slotId
      `).run({ sessionId, slotId, tag, ts: now() });
      return;
    }
    db.query(`
      DELETE FROM session_character_tags
      WHERE tag = $tag AND session_character_id IN (
        SELECT id FROM session_characters
        WHERE game_session_id = $sessionId AND id = $slotId
      )
    `).run({ sessionId, slotId, tag });
  },

  /** Whether a slot currently carries a tag. */
  hasTag(sessionId: string, slotId: string, tag: string): boolean {
    const row = db.query<
      { tag: string },
      { sessionId: string; slotId: string; tag: string }
    >(`
      SELECT t.tag FROM session_character_tags t
      JOIN session_characters sc ON sc.id = t.session_character_id
      WHERE sc.game_session_id = $sessionId AND sc.id = $slotId AND t.tag = $tag
    `).get({ sessionId, slotId, tag });
    return row !== null;
  },

  /* ----------------------------------------------------------- held actions */

  /**
   * Holds this slot's action, or takes the hold off it.
   *
   * The desired state rather than a flip, for the same reason `setTag` takes
   * one, and through `session_characters` for the same reason too: a slot id
   * belonging to another session writes nothing at all.
   */
  setHeld(sessionId: string, slotId: string, held: boolean): void {
    db.query(`
      UPDATE session_characters SET held = $held
      WHERE game_session_id = $sessionId AND id = $slotId
    `).run({ sessionId, slotId, held: held ? 1 : 0 });
  },

  /** Whether a slot is holding its action. */
  isHeld(sessionId: string, slotId: string): boolean {
    const row = db.query<{ held: number }, { sessionId: string; slotId: string }>(`
      SELECT held FROM session_characters
      WHERE game_session_id = $sessionId AND id = $slotId
    `).get({ sessionId, slotId });
    return row?.held === 1;
  },

  /** Takes every hold off the stage, for a fight starting over. */
  clearHeld(sessionId: string): void {
    db.query("UPDATE session_characters SET held = 0 WHERE game_session_id = $sessionId")
      .run({ sessionId });
  },

  /**
   * Puts every player character in the campaign into the session at once.
   *
   * A session all but always opens with the whole party present, so the game
   * master shouldn't have to add them one at a time before the first turn. NPCs
   * stay out — they arrive when the scene calls for them. Ordered by name and
   * appended after anything already in the session: the initiative order is
   * derived from SPD and DEX+INIT by `list`, so `position` is only the tiebreak
   * between equal characters, and by name is a defensible way to settle it.
   * Anyone already there is filtered out rather than left to
   * `ON CONFLICT`, because a skipped row would leave a hole in the positions,
   * which the rest of the code takes to be dense.
   *
   * The name order is `compareNames`, the app's own, so two characters on the
   * same DEX+INIT stand in the order the library lists them. It costs the window
   * function this used to do the numbering with: SQLite cannot be taught that
   * rule from here (see `listForGm`), so the party is read out, ordered, and
   * written back in a transaction — which is what keeps the positions dense if
   * anything fails partway.
   */
  addCampaignPcs: db.transaction((sessionId: string, campaignId: string): void => {
    const party = db.query<
      { id: string; name: string; endurance: number; stun: number; body: number },
      { sessionId: string; campaignId: string }
    >(`
      SELECT c.id, c.name, c.endurance, c.stun, c.body FROM characters c
      WHERE c.campaign_id = $campaignId
        AND c.kind = 'pc'
        AND c.id NOT IN (
          SELECT character_id FROM session_characters WHERE game_session_id = $sessionId
        )
    `).all({ sessionId, campaignId });
    if (party.length === 0) return;

    const next = db.query<{ position: number }, { sessionId: string }>(`
      SELECT COALESCE(MAX(position) + 1, 0) AS position
      FROM session_characters WHERE game_session_id = $sessionId
    `).get({ sessionId })!.position;

    const ts = now();
    party.sort((a, b) => compareNames(a.name, b.name));
    party.forEach((character, index) => {
      db.query(`
        INSERT INTO session_characters
          (id, game_session_id, character_id, copy_number, position, added_at,
           cur_endurance, cur_stun, cur_body)
        VALUES ($id, $sessionId, $characterId, 1, $position, $ts, $end, $stun, $body)
      `).run({
        id: newId(),
        sessionId,
        characterId: character.id,
        position: next + index,
        ts,
        end: character.endurance,
        stun: character.stun,
        body: character.body,
      });
    });
  }),

  /**
   * Brings a copy of a character on stage.
   *
   * It takes the next `position`, which is not where it lands in the initiative
   * order — `list` derives that from SPD and DEX+INIT — but only its place in
   * the queue of arrivals, used to break a tie with someone on the same DEX+INIT.
   *
   * An NPC can be added over and over — that is the point, a fight has more than
   * one goblin — and each add is a slot of its own with its own turn. A PC is
   * added at most once: a second copy would give one player two seats and break
   * the one-claim-per-character rule the players table enforces, and there is no
   * reading of a party where two of the same hero turn up.
   *
   * The copy number is one more than the highest this session has ever used for
   * that character, not one more than the count. Removing Goblin 2 leaves 1 and
   * 3, and the next add is 4 — so a number, once given, keeps naming the same
   * monster for the whole fight, which is what someone tracking its wounds on
   * paper needs.
   *
   * Returns the new slot, or `null` when a PC was already there.
   */
  add(sessionId: string, characterId: string, kind: CharacterKind): string | null {
    if (kind === "pc" && sessionCharacters.isMember(sessionId, characterId)) return null;

    const id = newId();
    db.query(`
      INSERT INTO session_characters
        (id, game_session_id, character_id, copy_number, position, added_at,
         cur_endurance, cur_stun, cur_body)
      VALUES (
        $id,
        $sessionId,
        $characterId,
        COALESCE((
          SELECT MAX(copy_number) + 1 FROM session_characters
          WHERE game_session_id = $sessionId AND character_id = $characterId
        ), 1),
        COALESCE((SELECT MAX(position) + 1 FROM session_characters WHERE game_session_id = $sessionId), 0),
        $ts,
        (SELECT endurance FROM characters WHERE id = $characterId),
        (SELECT stun FROM characters WHERE id = $characterId),
        (SELECT body FROM characters WHERE id = $characterId)
      )
    `).run({ id, sessionId, characterId, ts: now() });
    return id;
  },

  /**
   * Takes one slot off the stage and closes the gap it leaves in the order, so
   * positions stay dense. Also clears the turn marker if it was pointing here,
   * and releases any player claim on the character that was standing in it.
   *
   * Everything is keyed on the slot rather than the character: removing one
   * goblin must not take its twin with it. The claim release is the exception —
   * it stays character-keyed, which is still right because only PCs are
   * claimable and a PC never has a second slot to go on holding the claim.
   */
  remove: db.transaction((sessionId: string, slotId: string) => {
    const removed = db.query<
      { position: number; character_id: string },
      { sessionId: string; slotId: string }
    >(`
      SELECT position, character_id FROM session_characters
      WHERE game_session_id = $sessionId AND id = $slotId
    `).get({ sessionId, slotId });
    if (!removed) return;

    db.query(
      "DELETE FROM session_characters WHERE game_session_id = $sessionId AND id = $slotId",
    ).run({ sessionId, slotId });

    db.query(`
      UPDATE session_characters SET position = position - 1
      WHERE game_session_id = $sessionId AND position > $position
    `).run({ sessionId, position: removed.position });

    db.query(`
      UPDATE players SET claimed_character_id = NULL
      WHERE game_session_id = $sessionId AND claimed_character_id = $characterId
    `).run({ sessionId, characterId: removed.character_id });

    db.query(
      "UPDATE game_sessions SET active_slot_id = NULL WHERE id = $sessionId AND active_slot_id = $slotId",
    ).run({ sessionId, slotId });

    // And the place the clock was told to carry on from, if it was this one: a
    // resume point naming a slot that has left the stage would send the next
    // step back to the start of the segment.
    db.query(
      "UPDATE game_sessions SET resume_slot_id = NULL WHERE id = $sessionId AND resume_slot_id = $slotId",
    ).run({ sessionId, slotId });
  }),
};

/* ------------------------------------------------------------- session log */

/**
 * How much of a session's log a snapshot carries.
 *
 * The log is unbounded in the database and bounded on the way out, because the
 * two want different things: a table may want to scroll back over a long night,
 * but every snapshot is republished on every mutation, and a fight that has run
 * for hours should not be sending hours of history down the wire each time
 * somebody presses a button. Two hundred lines is far more than the drawer can
 * show and small enough not to notice.
 */
const LOG_LIMIT = 200;

export const sessionEvents = {
  /**
   * Writes one line of the log.
   *
   * Takes the sentence rather than building it: what an event says is the
   * business of whoever caused it, and this file only knows how to store it.
   */
  record(sessionId: string, message: string): void {
    db.query(`
      INSERT INTO session_events (id, game_session_id, message, created_at)
      VALUES ($id, $sessionId, $message, $ts)
    `).run({ id: newId(), sessionId, message, ts: now() });
  },

  /**
   * The tail of a session's log, oldest first.
   *
   * Read newest-first so the LIMIT keeps the *recent* end, then reversed, because
   * that is the order it is drawn in — new events at the bottom. `id` breaks a
   * same-second tie: ids are time-ordered, so two events recorded inside one
   * second still come back in the order they happened.
   */
  list(sessionId: string, limit: number = LOG_LIMIT): SessionEventRow[] {
    return db.query<SessionEventRow, { sessionId: string; limit: number }>(`
      SELECT * FROM session_events
      WHERE game_session_id = $sessionId
      ORDER BY created_at DESC, id DESC
      LIMIT $limit
    `).all({ sessionId, limit }).reverse();
  },

  /**
   * Throws a session's log away.
   *
   * All of it, rather than the two hundred lines a snapshot carries: what the
   * drawer shows is the tail of the log, and clearing what somebody can see
   * while leaving the rest behind would be a lie the next scroll uncovers.
   */
  clear(sessionId: string): void {
    db.query("DELETE FROM session_events WHERE game_session_id = $sessionId")
      .run({ sessionId });
  },
};

/* ------------------------------------------------------------------- players */

export const players = {
  list(sessionId: string): PlayerRow[] {
    return db.query<PlayerRow, { sessionId: string }>(
      "SELECT * FROM players WHERE game_session_id = $sessionId ORDER BY joined_at",
    ).all({ sessionId });
  },

  /**
   * How many players are in each of a game master's sessions.
   *
   * One grouped query rather than a count per row, so the library page costs the
   * same whether the game master has two sessions behind them or two hundred.
   * Sessions nobody has joined are absent, so read a missing key as zero.
   */
  countsForGm(gmId: string): Map<string, number> {
    const rows = db.query<{ sessionId: string; total: number }, { gmId: string }>(`
      SELECT p.game_session_id AS sessionId, COUNT(*) AS total
      FROM players p
      JOIN game_sessions s ON s.id = p.game_session_id
      WHERE s.gm_id = $gmId
      GROUP BY p.game_session_id
    `).all({ gmId });
    return new Map(rows.map((row) => [row.sessionId, row.total]));
  },

  byId(id: string): PlayerRow | null {
    return db.query<PlayerRow, { id: string }>("SELECT * FROM players WHERE id = $id").get({ id });
  },

  byTokenHash(tokenHash: string): PlayerRow | null {
    return db.query<PlayerRow, { tokenHash: string }>(
      "SELECT * FROM players WHERE token_hash = $tokenHash",
    ).get({ tokenHash });
  },

  nameTaken(sessionId: string, name: string): boolean {
    const row = db.query<{ id: string }, { sessionId: string; name: string }>(
      "SELECT id FROM players WHERE game_session_id = $sessionId AND name = $name",
    ).get({ sessionId, name });
    return row !== null;
  },

  create(input: { sessionId: string; name: string; tokenHash: string }): PlayerRow {
    const id = newId();
    db.query(`
      INSERT INTO players (id, game_session_id, name, token_hash, joined_at)
      VALUES ($id, $sessionId, $name, $tokenHash, $ts)
    `).run({ ...input, id, ts: now() });
    return players.byId(id)!;
  },

  setClaim(id: string, characterId: string | null): void {
    db.query("UPDATE players SET claimed_character_id = $characterId WHERE id = $id")
      .run({ id, characterId });
  },

  remove(id: string): void {
    db.query("DELETE FROM players WHERE id = $id").run({ id });
  },

  /** The player holding a character in a session, if any. */
  holderOf(sessionId: string, characterId: string): PlayerRow | null {
    return db.query<PlayerRow, { sessionId: string; characterId: string }>(`
      SELECT * FROM players
      WHERE game_session_id = $sessionId AND claimed_character_id = $characterId
    `).get({ sessionId, characterId });
  },
};
