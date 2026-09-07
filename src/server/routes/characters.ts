/**
 * Character library. Game master only.
 *
 * A character is a name plus an uploaded HERO Designer character file (`.hdc`),
 * filed under exactly one campaign. The sheet a game master looks at is rendered
 * from that file on demand by routes/files.ts; nothing stores it.
 */

import type { BunRequest } from "bun";
import { handler, json, noContent, type RequestContext } from "../http.ts";
import { parse, schemas } from "../../lib/validate.ts";
import { errors } from "../../lib/errors.ts";
import { requireGm } from "../middleware/auth.ts";
import { campaigns, characters } from "../../db/queries.ts";
import { HERO_STAT_FIELDS, type HeroStatField } from "../../lib/hero.ts";
import {
  collectOrphanedUploads,
  fileField,
  portraitFromSheet,
  readUploadedFile,
  requireTotalWithinLimit,
  statsFromSheet,
  storeImage,
  storeSheet,
} from "../uploads.ts";
import { statsFromHdc } from "../hero-sheet.ts";
import type { CharacterRow, GmRow, UploadRow } from "../../db/types.ts";
import { presentCharacter } from "../presenters.ts";
import { sessionIdsWith } from "../session-state.ts";
import { broadcastSession } from "../ws.ts";

/** Loads a character and confirms it belongs to a campaign this GM owns. */
function requireOwnedCharacter(gm: GmRow, characterId: string): CharacterRow {
  const character = characters.byId(characterId);
  if (!character) throw errors.notFound("We couldn't find that character.");
  const campaign = campaigns.byId(character.campaign_id);
  if (!campaign || campaign.gm_id !== gm.id) {
    throw errors.notFound("We couldn't find that character.");
  }
  return character;
}

function requireOwnedCampaignId(gm: GmRow, campaignId: string): void {
  const campaign = campaigns.byId(campaignId);
  if (!campaign || campaign.gm_id !== gm.id) {
    throw errors.badRequest("Please choose one of your own campaigns for this character.");
  }
}

/**
 * The portrait that came with a freshly uploaded character file, if there is
 * one.
 *
 * Two ways it arrives, and they mean the same thing. Ordinarily the browser has
 * already taken the picture out of the file and sized it (`client/hdc.ts`), so
 * it comes as its own part and this simply stores it. Otherwise the file reached
 * the server whole — through the API, or from a browser where the split failed —
 * and the picture is still inside it.
 *
 * Either way it is a picture the game master did not ask for, so it is a
 * convenience and never a reason to fail: anything that goes wrong leaves the
 * character without one, which is exactly where it would have been anyway.
 */
async function portraitOrNone(
  sheet: UploadRow,
  sent: File | null,
  logger: RequestContext["logger"],
): Promise<UploadRow | null> {
  try {
    return sent ? await storeImage(sent) : await portraitFromSheet(sheet);
  } catch (error) {
    logger.warn("could not take a portrait from the character file", {
      uploadId: sheet.id,
      error,
    });
    return null;
  }
}

/**
 * The HERO characteristics a character form carries.
 *
 * A field the form left out is left out of the result, so a PATCH that never
 * mentions SPEED does not reset it; a field sent empty reads as zero, which is
 * what clearing the box means. Each is parsed with its own schema, because the
 * bounded ones — SPEED runs 0 to 12 — are bounded here rather than only in the
 * browser, where an `max` attribute is a courtesy and not a guarantee.
 */
function statsFromForm(form: FormData): Partial<Record<HeroStatField, number>> {
  const stats: Partial<Record<HeroStatField, number>> = {};
  for (const field of HERO_STAT_FIELDS) {
    const raw = form.get(field);
    if (typeof raw === "string") stats[field] = parse(schemas.heroStat[field], raw);
  }
  return stats;
}

/**
 * The characteristics from a character file that this app could actually store.
 *
 * A typed number is bounded by `schemas.heroStat` on the way in — SPD runs 0 to
 * 12 — and a number computed from a file has to clear the same bar, or an odd
 * export would put a character on the stage that no form could have produced.
 *
 * What it does with a number that fails is where it parts company with the form:
 * a game master who types 40 into the SPD box is told so and can fix it, but
 * nobody typed this one. Failing the upload over it would refuse a character for a
 * characteristic the game master may not even use, so the field is simply
 * dropped, and it stays at the zero every unfilled characteristic starts at.
 */
function withinBounds(
  stats: Partial<Record<HeroStatField, number>>,
): Partial<Record<HeroStatField, number>> {
  const kept: Partial<Record<HeroStatField, number>> = {};
  for (const field of HERO_STAT_FIELDS) {
    const value = stats[field];
    if (value === undefined) continue;
    const checked = schemas.heroStat[field].safeParse(value);
    if (checked.success) kept[field] = checked.data;
  }
  return kept;
}

export const characterRoutes = {
  "/api/characters": {
    GET: handler((request: BunRequest) => {
      const gm = requireGm(request);
      const campaignId = new URL(request.url).searchParams.get("campaignId") ?? undefined;
      return json({
        characters: characters.listForGm(gm.id, campaignId).map(presentCharacter),
      });
    }),

    POST: handler(async (request: BunRequest, { logger }: RequestContext) => {
      const gm = requireGm(request);
      const form = await request.formData();

      const input = parse(schemas.characterInput, {
        campaignId: form.get("campaignId"),
        kind: form.get("kind"),
        name: form.get("name"),
      });
      requireOwnedCampaignId(gm, input.campaignId);

      if (characters.nameTaken(input.campaignId, input.name)) {
        throw errors.conflict(`This campaign already has a character called “${input.name}”.`);
      }

      const sheetFile = fileField(form, "sheet");
      if (!sheetFile) {
        throw errors.badRequest("Please choose a HERO Designer character file to upload.");
      }
      // An image the game master chose wins; otherwise the character file's own
      // portrait stands, whether it arrives beside the file or still inside it.
      const imageFile = fileField(form, "card");
      const portraitFile = fileField(form, "sheetPortrait");
      requireTotalWithinLimit(sheetFile, imageFile, portraitFile);

      const sheet = await storeSheet(sheetFile);
      const card = imageFile
        ? await storeImage(imageFile)
        : await portraitOrNone(sheet, portraitFile, logger);

      // What the form said, over what the character file says about itself.
      //
      // The dialog sends all eight boxes, so for that path this changes nothing:
      // it has already asked what the file says and filled them in, and what
      // arrives here is what the game master saw and could have corrected.
      //
      // The path this is for is a folder of files dropped on a campaign, which
      // sends a name and a file and nothing else. Those characters were filed at
      // zero across the board until now, and every number needed typing in
      // afterwards — from the same file that was already on disk.
      const typed = statsFromForm(form);
      const stats = { ...withinBounds(await statsFromSheet(sheet)), ...typed };
      const character = characters.create({
        campaignId: input.campaignId,
        kind: input.kind,
        name: input.name,
        sheetUploadId: sheet.id,
        cardUploadId: card?.id ?? null,
        stats,
      });
      logger.info("character created", {
        characterId: character.id,
        kind: character.kind,
        portraitFromSheet: !imageFile && card !== null,
        statsFromSheet: Object.keys(stats).length - Object.keys(typed).length,
      });

      return json({ character: presentCharacter(character) }, { status: 201 });
    }),
  },

  /**
   * What a character file says its character's characteristics are.
   *
   * The add and edit dialogs fill their boxes in as a file is chosen, so a game
   * master sees the numbers and can correct them before saving. Working them out
   * needs the game system's rules — megabytes of JSON the browser has no business
   * holding — so the browser asks instead.
   *
   * Nothing is stored. The file is read, answered about, and dropped; the upload
   * that files the character is a separate request, and the browser has already
   * taken the portrait out of what it sends here, so this is tens of kilobytes
   * rather than the megabytes the file weighs on disk.
   */
  "/api/characters/stats": {
    POST: handler(async (request: BunRequest) => {
      requireGm(request);
      const form = await request.formData();
      const file = fileField(form, "hdc");
      if (!file) throw errors.badRequest("Please choose a HERO Designer character file.");
      const bytes = await readUploadedFile(file, "character file");
      return json({ stats: withinBounds(await statsFromHdc(bytes, file.name)) });
    }),
  },

  "/api/characters/:id": {
    PATCH: handler(
      async (request: BunRequest<"/api/characters/:id">, { logger }: RequestContext) => {
        const gm = requireGm(request);
        const character = requireOwnedCharacter(gm, request.params.id);
        const form = await request.formData();

        const changes: Parameters<typeof characters.update>[1] = {};

        const rawCampaign = form.get("campaignId");
        if (typeof rawCampaign === "string" && rawCampaign !== character.campaign_id) {
          requireOwnedCampaignId(gm, rawCampaign);
          changes.campaignId = rawCampaign;
        }

        // Refiling a character out of a campaign it is currently playing in would
        // leave it in that campaign's running session, which is neither what the
        // game master asked for nor something the players could make sense of.
        if (changes.campaignId && sessionIdsWith(character.id).length > 0) {
          throw errors.conflict(
            "This character is playing in a session that is still running. End that " +
              "session before moving them to another campaign.",
          );
        }

        const rawKind = form.get("kind");
        if (rawKind === "pc" || rawKind === "npc") changes.kind = rawKind;

        const rawName = form.get("name");
        if (typeof rawName === "string") changes.name = parse(schemas.displayName, rawName);

        const typed = statsFromForm(form);

        // Names are unique within a campaign, so the question is about the name and
        // the campaign this character is going to end up with — not about which of
        // the two the form happened to carry. A move alone can collide just as a
        // rename can, and a drop sends nothing but the campaign.
        if (changes.name !== undefined || changes.campaignId !== undefined) {
          const name = changes.name ?? character.name;
          const targetCampaign = changes.campaignId ?? character.campaign_id;
          if (characters.nameTaken(targetCampaign, name, character.id)) {
            throw errors.conflict(`This campaign already has a character called “${name}”.`);
          }
        }

        const sheetFile = fileField(form, "sheet");
        const imageFile = fileField(form, "card");
        const portraitFile = fileField(form, "sheetPortrait");
        requireTotalWithinLimit(sheetFile, imageFile, portraitFile);

        const sheet = sheetFile ? await storeSheet(sheetFile) : null;
        if (sheet) changes.sheetUploadId = sheet.id;

        // What the form said, over what the new file says about itself — the
        // same order the create route uses, and for the same reason.
        //
        // The edit dialog sends all eight boxes, having asked what the file says
        // as it was chosen, so nothing here changes that path. This is for a
        // file dropped on the character panel over a character that already
        // exists: that sends the file and nothing else, and without this it
        // would replace the file and leave the numbers as they were — stale
        // against the very file that had just been dropped to update them.
        const fromSheet = sheet ? withinBounds(await statsFromSheet(sheet)) : {};
        for (const [field, value] of Object.entries({ ...fromSheet, ...typed })) {
          changes[field as keyof ReturnType<typeof statsFromForm>] = value;
        }

        // Whether the file's own portrait may displace a picture the character
        // already has. Off by default, and the dialog leaves it off: it carries a
        // card-image field and a remove box, so a game master editing there has
        // chosen the picture and a file must not overrule that choice.
        //
        // A sheet dropped on the panel turns it on, because that gesture means
        // something else. There is nothing in it to say "keep the old picture" —
        // the file is the whole of the intent, and the character it lands on
        // should end up looking like the export that just arrived.
        const portraitWins = form.get("portraitFromSheet") === "true";

        if (imageFile) {
          changes.cardUploadId = (await storeImage(imageFile)).id;
        } else if (form.get("removeCard") === "true") {
          changes.cardUploadId = null;
        } else if (sheet && (portraitWins || !character.card_upload_id)) {
          const portrait = await portraitOrNone(sheet, portraitFile, logger);
          if (portrait) changes.cardUploadId = portrait.id;
        }

        const updated = characters.update(character.id, changes);
        if (changes.sheetUploadId || changes.cardUploadId !== undefined) {
          await collectOrphanedUploads();
        }
        logger.info("character updated", { characterId: character.id });

        // A rename or a new portrait changes what players are looking at, so any
        // session this character is active in needs to hear about it.
        for (const sessionId of sessionIdsWith(character.id)) broadcastSession(sessionId);

        return json({ character: presentCharacter(updated!) });
      },
    ),

    DELETE: handler(
      async (request: BunRequest<"/api/characters/:id">, { logger }: RequestContext) => {
        const gm = requireGm(request);
        const character = requireOwnedCharacter(gm, request.params.id);

        // Deleting would cascade through `session_characters` and take this
        // character off the stage of a running session mid-fight, with the players
        // watching them vanish and no way to put them back. The same rule as
        // refiling above, and for the same reason — with one more way out, since
        // taking them off the stage is enough where a move needs the whole session
        // ended.
        if (sessionIdsWith(character.id).length > 0) {
          throw errors.conflict(
            "This character is playing in a session that is still running. Take them " +
              "off the stage, or end that session, before deleting them.",
          );
        }

        characters.remove(character.id);
        await collectOrphanedUploads();
        logger.info("character deleted", { characterId: character.id });

        return noContent();
      },
    ),
  },
};
