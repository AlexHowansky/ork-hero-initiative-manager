/**
 * Shared input schemas and parsing helpers.
 *
 * Every value that arrives from a client is parsed through one of these before it
 * reaches the database. Failures are converted into `AppError`s carrying a message
 * that is safe and useful to show the person who typed it.
 */

import { z } from "zod";
import { CARD_IMAGE_PX } from "./cards.ts";
import { limits } from "./config.ts";
import { errors } from "./errors.ts";
import {
  HERO_STAT_FIELDS,
  HERO_STAT_LABELS,
  HERO_STAT_RANGES,
  normalizeTag,
  STATUS_TAG_MAX_LENGTH,
} from "./hero.ts";
import type { HeroStatField } from "./hero.ts";

/** Collapses runs of whitespace and trims — display names shouldn't carry layout. */
const displayName = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(
    z.string()
      .min(1, "Please enter a name.")
      .max(limits.nameMaxLength, `Names can be at most ${limits.nameMaxLength} characters.`),
  );

/**
 * The HERO characteristics, one schema each, as they arrive from a form.
 *
 * Always a string on the way in, and an empty box means zero rather than an
 * error: a character nobody has filled in yet is a normal thing to save.
 *
 * A characteristic the rules bound takes its bounds from `HERO_STAT_RANGES`,
 * which is the same map the editor draws its `min` and `max` from — so the
 * browser and the server cannot come to different views about what SPD 13 is,
 * and the one that actually protects the database is this one. The rest get a
 * range that is deliberately signed — a HERO character at -8 STUN is
 * unconscious, not invalid — and merely wide enough to catch a typed accident.
 */
function heroStatSchemas(): Record<HeroStatField, z.ZodType<number>> {
  const schemasByField = {} as Record<HeroStatField, z.ZodType<number>>;
  for (const field of HERO_STAT_FIELDS) {
    const range = HERO_STAT_RANGES[field];
    // The same sentence at both ends: "SPD must be between 0 and 12."
    const message = range
      ? `${HERO_STAT_LABELS[field]} must be between ${range.min} and ${range.max}.`
      : "";
    const bounded = range
      ? z.coerce.number().int().min(range.min, message).max(range.max, message)
      : z.coerce.number().int().min(-999).max(999);
    schemasByField[field] = z.preprocess(
      (value) => (value === "" || value === null || value === undefined ? 0 : value),
      bounded,
    );
  }
  return schemasByField;
}

export const schemas = {
  displayName,

  email: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.email("Please enter a valid email address.").max(254)),

  password: z
    .string()
    .min(
      limits.passwordMinLength,
      `Passwords must be at least ${limits.passwordMinLength} characters.`,
    )
    .max(1024, "That password is too long."),

  id: z.string().min(1).max(64),

  gmLogin: z.object({
    // Not `schemas.password` — an existing password shouldn't be re-validated
    // against the current policy at sign-in time.
    email: z.string().max(254),
    password: z.string().max(1024),
  }),

  campaignInput: z.object({
    name: displayName,
  }),

  characterInput: z.object({
    campaignId: z.string().min(1).max(64),
    kind: z.enum(["pc", "npc"]),
    name: displayName,
  }),

  heroStat: heroStatSchemas(),

  /**
   * What a stage slot has left. Every field is optional: a screen that edits one
   * box sends one box.
   *
   * `stunTaken` is the one field that is not a total. It is the size of a single
   * hit, and it is here rather than in the browser's arithmetic because a rule
   * turns on it: a hit bigger than the character's CON stuns them, and a total
   * cannot say whether it arrived as one hit or as three. The server does the
   * subtraction, so two screens cannot lose a hit between them.
   *
   * Which is also why the two may not arrive together: `stun` says where the
   * number ends up and `stunTaken` says what happened to it, and a body carrying
   * both is asking for two different things at once.
   */
  setVitals: z.object({
    endurance: z.number().int().min(-999).max(999).optional(),
    stun: z.number().int().min(-999).max(999).optional(),
    stunTaken: z.number().int().min(1).max(999).optional(),
    body: z.number().int().min(-999).max(999).optional(),
  }).refine(
    (values) => values.stun === undefined || values.stunTaken === undefined,
    { message: "Send either a new STUN total or the STUN taken, not both." },
  ),

  /**
   * A game master's own settings. Every field is optional, as on `setVitals`: a
   * panel that changes one control sends one control.
   *
   * The bounds are the slider's own (`lib/cards.ts`), so a value this refuses is
   * one no control in the app could have produced.
   */
  gmSettings: z.object({
    cardImagePx: z.coerce
      .number()
      .int()
      .min(CARD_IMAGE_PX.min)
      .max(CARD_IMAGE_PX.max)
      .optional(),
    showAllNpcs: z.boolean().optional(),
    /**
     * Which export template their sheets are drawn through, as an id the browser
     * can put in a `<select>` — the built-in travels under its own sentinel
     * rather than as a null. That it names one of *their* templates is the
     * route's to check, not the schema's.
     */
    templateId: z.string().min(1).max(64).optional(),
  }),

  /**
   * One status tag on a stage slot, and whether it should be on or off.
   *
   * The desired state rather than a flip, so the same request twice means the
   * same thing. `normalizeTag` folds a typed "Prone" onto the button's `prone`
   * before it is stored, and the length bound is the only thing between the
   * table — which deliberately carries no `CHECK` — and a tag too wide to draw.
   */
  setStatusTag: z.object({
    tag: z
      .string()
      .max(STATUS_TAG_MAX_LENGTH, `A tag can be at most ${STATUS_TAG_MAX_LENGTH} characters.`)
      .transform(normalizeTag)
      .pipe(z.string().min(1, "Please enter a tag.")),
    active: z.boolean(),
  }),

  /** The state the hold should end in, not an instruction to flip it. */
  setHold: z.object({ held: z.boolean() }),

  sessionStart: z.object({
    campaignId: z.string().min(1).max(64),
  }),

  sessionJoin: z.object({
    code: z.string().min(1).max(64),
    name: displayName,
  }),

  claim: z.object({
    characterId: z.string().min(1).max(64),
  }),

  /** Which character to put on the stage; a repeat is another copy, not an error. */
  stageAdd: z.object({
    characterId: z.string().min(1).max(64),
  }),

  setTurn: z.object({
    slotId: z.string().min(1).max(64).nullable(),
  }),

  advanceTurn: z.object({
    direction: z.enum(["next", "prev"]),
  }),

  /** GM edit of a player: release a claim, or hand it to another character. */
  playerUpdate: z.object({
    claimedCharacterId: z.string().min(1).max(64).nullable(),
  }),
};

/**
 * Parses a value, converting a schema failure into a 400 whose message is the
 * first problem the schema reported.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw errors.badRequest(first?.message ?? "That request wasn't valid.", {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

/** Parses a JSON request body, rejecting malformed JSON with a friendly message. */
export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw errors.badRequest("We couldn't read that request. Please try again.");
  }
  return parse(schema, body);
}
