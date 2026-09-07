/**
 * Everything this app knows about HERO Designer character files.
 *
 * A `.hdc` is the character as HERO Designer stores it: structure, not
 * presentation. A skill is `XMLID="ACTING" LEVELS="1" BASECOST="3.0"`, and both
 * the printed sheet and the characteristics this app puts on a card are computed
 * from it against the game system's own rules. `ork-hero-export-renderer` does
 * that computation and reproduces HERO Designer's own export byte for byte; this
 * module is the whole of this app's contact with it.
 *
 * Server-only, for two reasons that are really one: the rules data is megabytes
 * of JSON read off the filesystem, and the library's decoder uses `Buffer`. The
 * browser's own needs — splitting the portrait out before an upload — are small
 * enough to be written directly, and are in `client/hdc.ts`.
 *
 * Nothing here caches a rendered sheet. The rules and the export template are
 * read once and held, because they are the same for every character and cost
 * hundreds of milliseconds to parse; the HTML they produce is built fresh on
 * every request, so a re-uploaded character is never shown from a stale copy.
 */

import { resolve } from "node:path";
import {
  buildSheet,
  decodeCharacterFile,
  HeroError,
  parseCharacterFile,
  render,
  RulesLibrary,
  type CharacterFile,
  type DetectedEncoding,
  type Logger,
} from "ork-hero-export-renderer";
import { config } from "../lib/config.ts";
import { errors } from "../lib/errors.ts";
import { log } from "../lib/log.ts";
import type { HeroStatField } from "../lib/hero.ts";
import type { UploadRow } from "../db/types.ts";

/** The type this app stores a character file under, and serves nothing as. */
export const HDC_MIME = "application/x-hero-designer-character";

/**
 * The export template every sheet is rendered through.
 *
 * One template for the whole deployment, hardcoded: it is this project's own
 * (see the `ork-hero-templates` repository), and it is what the cards, the
 * player screen and the sheet overlay were all designed around. Letting a game
 * master upload their own is a later piece of work, and it is why this is a
 * single named constant rather than a path spread through the module.
 */
const TEMPLATE_PATH = resolve(import.meta.dir, "../../assets/Ork-16x9.hde");

/**
 * The talent that grants an initiative bonus, and the only form of it that
 * counts.
 *
 * Lightning Reflexes can be bought for one kind of action — "+3 DEX to act first
 * with Ranged attacks" — and that is not an initiative bonus a fight can be
 * ordered by. The rules data gives the two forms different ids, so unlike the
 * HTML sheet this replaces, telling them apart is an exact match rather than a
 * phrase in a printed string.
 */
const LIGHTNING_REFLEXES = "LIGHTNING_REFLEXES_ALL";

/** The characteristic each stored field is computed from. INIT is not one. */
const CHARACTERISTIC_BY_FIELD: Partial<Record<HeroStatField, string>> = {
  speed: "SPD",
  dexterity: "DEX",
  constitution: "CON",
  recovery: "REC",
  endurance: "END",
  stun: "STUN",
  body: "BODY",
};

/** The library's logger, writing where the rest of the server writes. */
const logger: Logger = {
  debug: (message) => log.debug("renderer", { detail: message }),
  info: (message) => log.debug("renderer", { detail: message }),
  warn: (message) => log.warn("renderer", { detail: message }),
  error: (message) => log.warn("renderer", { detail: message }),
};

/**
 * The rules and the template, read once.
 *
 * Both are the same for every character in the deployment and neither is small —
 * the rules are megabytes of JSON, nine of whose seventeen systems extend a
 * shared megabyte. Held as the promises rather than the values so that two
 * requests arriving together do the work once between them.
 */
let rules: Promise<RulesLibrary> | null = null;
let template: Promise<string> | null = null;

function rulesLibrary(): Promise<RulesLibrary> {
  rules ??= RulesLibrary.load(config.heroRulesDir, logger);
  return rules;
}

function templateSource(): Promise<string> {
  template ??= Bun.file(TEMPLATE_PATH).text();
  return template;
}

/**
 * Turns anything the renderer throws into something a game master can act on.
 *
 * The library's own messages are written for a person rather than a programmer —
 * "this file is empty", "the rules file was written in format version 3" — so
 * they are passed through as they are. Anything else is not the uploaded file's
 * fault and must not be described as though it were.
 */
function asAppError(error: unknown, fallback: string): Error {
  if (error instanceof HeroError) return errors.badRequest(error.message);
  log.warn("could not read a character file", { error });
  return errors.badRequest(fallback);
}

/** The parsed character, or a 400 explaining why this is not one. */
export function parseHdc(bytes: Uint8Array, source?: string): CharacterFile {
  try {
    return parseCharacterFile(bytes, source);
  } catch (error) {
    throw asAppError(
      error,
      "We couldn't read that character file. It should be a .hdc saved by HERO Designer.",
    );
  }
}

/**
 * The characteristics this app stores, as the character actually has them.
 *
 * `total` rather than `value`, so a power or a talent that raises a
 * characteristic counts — which the HTML sheet this replaces got for free, by
 * reading the number already printed on it.
 *
 * INIT is not a characteristic at all. It is the Lightning Reflexes talent, and
 * a character without it has an initiative bonus of zero — which is an answer,
 * not a gap, so it is always reported.
 */
export async function statsFromHdc(
  bytes: Uint8Array,
  source?: string,
): Promise<Partial<Record<HeroStatField, number>>> {
  const character = parseHdc(bytes, source);
  const library = await rulesLibrary();

  let sheet;
  try {
    sheet = buildSheet(character, library.system(character.templateId));
  } catch (error) {
    throw asAppError(
      error,
      `We couldn't work out this character's characteristics. They use the ` +
        `“${character.templateId}” game system.`,
    );
  }

  const stats: Partial<Record<HeroStatField, number>> = {};
  for (const [field, id] of Object.entries(CHARACTERISTIC_BY_FIELD)) {
    const characteristic = sheet.characteristics.byId.get(id);
    if (characteristic) stats[field as HeroStatField] = characteristic.total;
  }

  stats.initiative = character.talents
    .filter((talent) => talent.xmlId === LIGHTNING_REFLEXES)
    .reduce((most, talent) => Math.max(most, talent.levels), 0);

  return stats;
}

/**
 * The picture a character file carries, if it carries one.
 *
 * HERO Designer stores it as base64 inside a single `IMAGE` element, so unlike
 * the HTML sheets this replaces — where the portrait had to be found by scanning
 * for long runs that decoded to something with image magic bytes — there is
 * exactly one place to look and no guessing about which image is the portrait.
 */
export function imageFromHdc(character: CharacterFile): Uint8Array | null {
  if (!character.image) return null;
  try {
    return Uint8Array.from(atob(character.image.base64), (c) => c.charCodeAt(0));
  } catch (error) {
    log.warn("a character file's picture would not decode", { error });
    return null;
  }
}

/**
 * The same file with its picture taken out.
 *
 * Once the portrait is a card of its own, the copy inside the character file is
 * the same image stored twice — and much the larger copy, since base64 in UTF-16
 * costs nearly three bytes for every one of the picture's. It is almost the
 * whole of what one of these files weighs: the fixture is 3,719,550 bytes, of
 * which all but 92,454 is a 1.3 MB portrait.
 *
 * Re-encoded in the encoding it arrived in rather than in whatever is cheapest,
 * so what is stored stays a `.hdc` — a file whose XML declaration says UTF-16
 * over UTF-8 bytes is one this library would still read (the byte-order mark is
 * the authority) and HERO Designer would not.
 *
 * Which means a rendered sheet no longer shows a portrait. That is the same
 * trade the HTML sheets made: the picture is on the card, which is where this
 * app shows it.
 */
export function withoutImage(bytes: Uint8Array): Uint8Array {
  const { text, encoding } = decodeCharacterFile(bytes);
  const stripped = text.replace(/[ \t]*<IMAGE\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/IMAGE>)\r?\n?/, "");
  return encode(stripped, encoding);
}

/** Text back to bytes, with the byte-order mark the file is identified by. */
function encode(text: string, encoding: DetectedEncoding): Uint8Array {
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.byteLength + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }

  const bigEndian = encoding !== "utf-16le";
  // The mark, then one code unit per character. `text` is UTF-16 already, so
  // surrogate pairs are two units and copy across unchanged.
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, !bigEndian);
  for (let i = 0; i < text.length; i += 1) {
    view.setUint16((i + 1) * 2, text.charCodeAt(i), !bigEndian);
  }
  return out;
}

/**
 * The character sheet, rendered now.
 *
 * Never written to disk and never cached: the stored file is the character, and
 * the sheet is what that character looks like today, through today's template
 * and today's rules. A re-export dropped on a character changes the sheet the
 * next time anyone opens it, with nothing to invalidate.
 *
 * `strict: false` deliberately. In strict mode anything the renderer cannot work
 * out stops the render with an explanation, which is right for a command line
 * and wrong for a game master who has just clicked a character's name mid-fight:
 * a blank where one line should be is recoverable, a blank page is not.
 */
export async function renderSheet(bytes: Uint8Array, upload: UploadRow): Promise<string> {
  const [source] = await Promise.all([templateSource(), rulesLibrary()]);
  return await render(bytes, source, {
    strict: false,
    logger,
    rulesDirectory: config.heroRulesDir,
    // What the sheet prints about the file it came from. The upload row is the
    // only record of either: the file on disk is named after its row and its
    // modification time is whenever this app last rewrote it.
    characterFileName: upload.original_name,
    saveTimestamp: new Date(upload.created_at),
  });
}
