/** Fixtures for the database-backed tests. */

import {
  campaigns,
  characters,
  gameSessions,
  gms,
  players,
  sessionCharacters,
  uploads,
} from "../src/db/queries.ts";
import type { HeroStats } from "../src/db/queries.ts";
import { join } from "node:path";
import { generateSessionCode, generateToken, hashToken } from "../src/lib/ids.ts";
import { config } from "../src/lib/config.ts";
import { HDC_MIME } from "../src/server/hero-sheet.ts";

/**
 * Whether the HERO rules data is available to this run.
 *
 * It is Hero Games' copyrighted material, extracted by an operator from their
 * own copy of HERO Designer, so it is not in this repository and cannot be in
 * CI. Everything that needs it — anything that works out a characteristic or
 * renders a sheet — is skipped without it rather than failing, and everything
 * that only needs a file to be read and stored runs regardless.
 */
export const rulesAvailable = await Bun.file(
  join(config.heroRulesDir, "manifest.json"),
).exists();

/**
 * A HERO Designer character file, built to order.
 *
 * The real thing is UTF-16 big endian with a byte-order mark, and getting that
 * wrong is silent rather than loud — so the fixtures are written the same way
 * the application has to read them, rather than as convenient UTF-8 that would
 * let a decoding bug through.
 *
 * Only `<CHARACTER TEMPLATE=…>` is structurally required; everything else here
 * is what makes a character worth asserting about. Characteristics are given as
 * *levels bought*, which is what the file stores — the value a sheet prints is
 * that plus the game system's base.
 */
export function hdcBytes(
  options: {
    name?: string;
    /** Levels bought, by characteristic: `{ SPD: 2 }` is a SPD of 4. */
    characteristics?: Readonly<Record<string, number>>;
    /** Levels of Lightning Reflexes for all actions, which is what INIT reads. */
    lightningReflexes?: number;
    image?: Uint8Array;
    imageName?: string;
  } = {},
): Uint8Array {
  const characteristics = Object.entries(options.characteristics ?? {})
    .map(([id, levels]) =>
      `    <${id} XMLID="${id}" ID="${id}1" BASECOST="0.0" LEVELS="${levels}" ` +
      `ALIAS="${id}" POSITION="1" MULTIPLIER="1.0" AFFECTS_PRIMARY="Yes" ` +
      `AFFECTS_TOTAL="Yes"><NOTES /></${id}>`
    )
    .join("\n");

  const reflexes = options.lightningReflexes === undefined ? "" : `
    <TALENT XMLID="LIGHTNING_REFLEXES_ALL" ID="LR1" BASECOST="0.0" LEVELS="${options.lightningReflexes}" ALIAS="Lightning Reflexes: +${options.lightningReflexes} DEX to act first with All Actions" POSITION="1" OPTION="ALL" OPTIONID="ALL"><NOTES /></TALENT>`;

  // In a CDATA section, wrapped across lines, the way HERO Designer writes it —
  // so anything reading the picture has to cope with the real shape rather than
  // a convenient one. Feeding those markers to a base64 decoder is an error, not
  // a few stray bytes, and it is exactly what a fixture without them hides.
  const image = options.image === undefined ? "" : `
  <IMAGE FileName="${options.imageName ?? "portrait.png"}" FilePath="C:\\pictures\\${
    options.imageName ?? "portrait.png"
  }"><![CDATA[${
    (Buffer.from(options.image).toString("base64").match(/.{1,76}/g) ?? []).join("\n")
  }]]></IMAGE>`;

  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<CHARACTER version="6.0" TEMPLATE="builtIn.Superheroic.hdt">
  <BASIC_CONFIGURATION BASE_POINTS="250" DISAD_POINTS="150" EXPERIENCE="0" RULES="Default" />
  <CHARACTER_INFO CHARACTER_NAME="${options.name ?? "Hero"}" PLAYER_NAME="Tester">
    <BACKGROUND />
  </CHARACTER_INFO>
  <CHARACTERISTICS>
${characteristics}
  </CHARACTERISTICS>
  <SKILLS />
  <PERKS />
  <TALENTS>${reflexes}
  </TALENTS>
  <MARTIALARTS />
  <POWERS />
  <DISADVANTAGES />
  <EQUIPMENT />${image}
</CHARACTER>`;

  // UTF-16 big endian, byte-order mark first — what HERO Designer writes, and
  // what the XML declaration above does *not* say.
  const bytes = new Uint8Array((xml.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff);
  for (let index = 0; index < xml.length; index += 1) {
    view.setUint16((index + 1) * 2, xml.charCodeAt(index));
  }
  return bytes;
}

/**
 * A HERO Designer export template, built to order.
 *
 * Plain UTF-8 with no byte-order mark — which is what an `.hde` is, and
 * deliberately not what `hdcBytes` writes: a character file is UTF-16 big endian
 * with a mark. The two look alike and are not, and a test that got them the wrong
 * way round would be testing the decoder rather than the template.
 *
 * `marker` is a string that appears in the rendered page and nowhere else, which
 * is how a test tells *which* template a sheet came out of. `directives: false`
 * builds the one thing an upload has to refuse: a file that parses but would put
 * none of the character on the page.
 */
export function hdeSource(
  options: { name?: string; marker?: string; directives?: boolean } = {},
): string {
  const name = options.name ?? "Test Template";
  const marker = options.marker ?? "";
  const body = options.directives === false
    ? `<p>${marker}</p>`
    : `<h1><!--CHARACTER_NAME--></h1>\n<p>${marker}</p>\n<p><!--CHARACTER_FILE--></p>`;
  return `<!--TEMPLATE_NAME-->${
    options.directives === false ? "" : name
  }<!--/TEMPLATE_NAME-->\n<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** The same, as the `File` an upload arrives as. */
export function hdeFile(
  fileName = "Template.hde",
  options: Parameters<typeof hdeSource>[0] = {},
): File {
  return new File([hdeSource(options)], fileName);
}

/** The same, as the `File` an upload arrives as. */
export function hdcFile(
  name = "Hero.hdc",
  options: Parameters<typeof hdcBytes>[0] = {},
): File {
  return new File([hdcBytes(options) as BlobPart], name);
}

let counter = 0;
/** Unique across a run, so tests sharing one database can't collide on names. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeGm() {
  return gms.create(`${unique("gm")}@example.com`, "not-a-real-hash");
}

export function makeCampaign(gmId?: string) {
  const gm = gmId ?? makeGm().id;
  return campaigns.create({ gmId: gm, name: unique("Campaign"), cardUploadId: null });
}

export function makeCharacter(
  campaignId: string,
  kind: "pc" | "npc" = "pc",
  name?: string,
  stats?: Partial<HeroStats>,
) {
  // Characters need an upload row to point at; the file itself is irrelevant here.
  const uploadId = makeUpload();
  return characters.create({
    campaignId,
    kind,
    name: name ?? unique(kind === "pc" ? "Hero" : "Villain"),
    sheetUploadId: uploadId,
    cardUploadId: null,
    stats,
  });
}

function makeUpload(): string {
  return uploads.create({
    kind: "sheet",
    diskPath: `/dev/null/${unique("sheet")}`,
    mime: HDC_MIME,
    byteSize: 10,
    sha256: "0".repeat(64),
    originalName: "Hero.hdc",
  }).id;
}

/** A session with `count` characters already in it, in a known order. */
export function makeSession(count = 3) {
  const gm = makeGm();
  const campaign = makeCampaign(gm.id);
  const session = gameSessions.create({
    campaignId: campaign.id,
    gmId: gm.id,
    code: generateSessionCode(),
  });
  const members = Array.from({ length: count }, (_, index) =>
    makeCharacter(campaign.id, index === count - 1 && count > 1 ? "npc" : "pc"),
  );
  for (const member of members) sessionCharacters.add(session.id, member.id, member.kind);
  return { gm, campaign, session, characters: members };
}

export function makePlayer(sessionId: string, name?: string) {
  return players.create({
    sessionId,
    name: name ?? unique("Player"),
    tokenHash: hashToken(generateToken()),
  });
}

/** The stage in the order it is drawn, as names, for readable assertions. */
export function orderOf(sessionId: string): string[] {
  return sessionCharacters.list(sessionId).map((character) => character.name);
}

/** The stage as slot ids, which is what the turn marker names. */
export function slotsOf(sessionId: string): string[] {
  return sessionCharacters.list(sessionId).map((row) => row.slot_id);
}

/** The copy number of each slot, in the order the stage is drawn. */
export function copiesOf(sessionId: string): number[] {
  return sessionCharacters.list(sessionId).map((row) => row.copy_number);
}

/** What each slot has left, in the order the stage is drawn. */
export function vitalsOf(sessionId: string): { end: number; stun: number; body: number }[] {
  return sessionCharacters.list(sessionId).map((row) => ({
    end: row.cur_endurance,
    stun: row.cur_stun,
    body: row.cur_body,
  }));
}

/** The tags on each slot, in the order the stage is drawn. */
export function tagsOf(sessionId: string): string[][] {
  const tags = sessionCharacters.tags(sessionId);
  return slotsOf(sessionId).map((slotId) => tags.get(slotId) ?? []);
}

/** The stored positions — the DEX+INIT tiebreak — to assert they stay dense. */
export function positionsOf(sessionId: string): number[] {
  return sessionCharacters.list(sessionId).map((character) => character.position);
}
