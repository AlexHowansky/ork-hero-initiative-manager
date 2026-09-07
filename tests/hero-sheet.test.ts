/**
 * Reading a HERO Designer character file, and drawing a sheet from one.
 *
 * The fixtures are a real export — `Redshift.hdc`, the character these numbers
 * were checked against by hand — and files this suite builds, so both the shape
 * HERO Designer actually writes and the edges a built one can reach are covered.
 *
 * Everything that computes a characteristic or renders a sheet needs the game
 * system's rules, which are Hero Games' own and are not in this repository. Those
 * tests skip without them; the ones that only read a file do not.
 */

import { describe, expect, test } from "bun:test";
import { imageFromHdc, parseHdc, renderSheet, statsFromHdc, withoutImage } from "../src/server/hero-sheet.ts";
import { builtInSource } from "../src/server/templates.ts";
import { hdcBytes, hdeSource, rulesAvailable } from "./helpers.ts";
import type { UploadRow } from "../src/db/types.ts";

const REDSHIFT = "./fixtures/Redshift.hdc";

const redshift = async () => new Uint8Array(await Bun.file(REDSHIFT).arrayBuffer());

/** Only the two fields `renderSheet` reads, which is all a sheet says about a file. */
const upload = (originalName = "Redshift.hdc") =>
  ({ original_name: originalName, created_at: "2026-04-05T12:00:00.000Z" } as UploadRow);

describe("reading a character file", () => {
  test("reads a real export, big-endian byte-order mark and all", async () => {
    const character = parseHdc(await redshift(), "Redshift.hdc");

    // Getting the encoding wrong is silent rather than loud — the file is UTF-16
    // *big* endian while the declaration inside says only "UTF-16" — so this is
    // as much a check on the decoding as on the parse.
    expect(character.info.characterName).toBe("Redshift");
    expect(character.templateId).toBe("Superheroic");
    expect(character.info.playerName).toBe("Alex");
  });

  test("refuses a file that is not one, and says why", () => {
    expect(() => parseHdc(new TextEncoder().encode("<html><body>hello</body></html>")))
      .toThrow(/CHARACTER/i);
    expect(() => parseHdc(new Uint8Array(0))).toThrow(/empty/i);
  });

  test("finds the picture inside, whatever the base64 is wrapped in", async () => {
    const picture = imageFromHdc(parseHdc(await redshift()))!;

    // A real export wraps and indents its base64 across thousands of lines.
    expect(picture.byteLength).toBe(1342398);
    expect([...picture.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("finds no picture where there is none", () => {
    expect(imageFromHdc(parseHdc(hdcBytes({ name: "Bare" })))).toBeNull();
  });
});

describe("taking the picture out", () => {
  test("leaves a smaller file that is still the same character", async () => {
    const before = await redshift();
    const after = withoutImage(before);

    // The picture is nearly the whole of what one of these files weighs: base64
    // in UTF-16 costs about three bytes for every one of the picture's.
    expect(before.byteLength).toBe(3719550);
    expect(after.byteLength).toBeLessThan(100_000);

    const character = parseHdc(after, "stripped.hdc");
    expect(character.image).toBeUndefined();
    expect(character.info.characterName).toBe("Redshift");
    expect(character.info.background).toContain("Elias");
  });

  test("keeps the file in the encoding it arrived in", async () => {
    const after = withoutImage(await redshift());

    // Still UTF-16 big endian with its mark, which is what makes what is stored
    // a `.hdc` rather than something only this app could read back.
    expect([...after.slice(0, 2)]).toEqual([0xfe, 0xff]);
    expect(after.byteLength % 2).toBe(0);
  });

  test("leaves a file with no picture exactly as it was", () => {
    const bytes = hdcBytes({ name: "Bare" });
    expect([...withoutImage(bytes)]).toEqual([...bytes]);
  });
});

describe.skipIf(!rulesAvailable)("what a character file says about its character", () => {
  test("the characteristics this app stores, as the character has them", async () => {
    // Checked by hand against the sheet HERO Designer exports for this file.
    expect(await statsFromHdc(await redshift(), "Redshift.hdc")).toEqual({
      speed: 5,
      dexterity: 26,
      constitution: 16,
      recovery: 15,
      endurance: 35,
      stun: 35,
      body: 12,
      initiative: 4,
    });
  });

  test("the same answers once the picture has gone", async () => {
    // What is actually stored is the stripped file, so this is the reading that
    // matters — the picture must not have been carrying any of it.
    const stripped = withoutImage(await redshift());
    expect(await statsFromHdc(stripped)).toEqual(await statsFromHdc(await redshift()));
  });

  test("an initiative bonus only from Lightning Reflexes for all actions", async () => {
    // Bought for one kind of action it is not an initiative bonus a fight can be
    // ordered by, and the rules data gives that form its own id.
    const all = await statsFromHdc(hdcBytes({ lightningReflexes: 3 }));
    expect(all.initiative).toBe(3);

    // No such talent is an answer rather than a gap.
    expect((await statsFromHdc(hdcBytes({ name: "Slow" }))).initiative).toBe(0);
  });

  test("says nothing about a characteristic the file does not carry", async () => {
    const stats = await statsFromHdc(hdcBytes({ characteristics: { SPD: 2 } }));

    // A field left out is one a caller leaves alone, rather than one it zeroes.
    // SPD's base is one plus a tenth of DEX, and DEX defaults to its own base of
    // 10 even where the file does not list it — so two levels print as four.
    expect(stats.speed).toBe(4);
    expect(stats.stun).toBeUndefined();
    expect(stats.dexterity).toBeUndefined();
  });
});

describe.skipIf(!rulesAvailable)("rendering the sheet", () => {
  test("draws the character, through the template this app ships", async () => {
    const html = await renderSheet(
      withoutImage(await redshift()),
      upload(),
      await builtInSource(),
    );

    // The marker the template stamps on everything it writes — which used to be
    // this app's licence to read somebody else's markup, and is now simply proof
    // that the sheet came from the template it ships.
    expect(html).toStartWith("<!--\n\nGenerated by Ork HERO Templates");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Redshift");
    // The characteristics table the sheet is built around.
    expect(html).toContain("STUN");
    expect(html).toContain("Lightning Reflexes");
  });

  test("draws the character through whatever template it is handed", async () => {
    const marker = "a-template-of-my-own";
    const html = await renderSheet(
      withoutImage(await redshift()),
      upload(),
      hdeSource({ marker }),
    );

    // The same character, out of a different template: what is on the page is
    // the template's, and the character in it is the file's.
    expect(html).toContain(marker);
    expect(html).toContain("Redshift");
    // And nothing of the one this app ships, which is the whole point of the
    // setting this serves.
    expect(html).not.toContain("Generated by Ork HERO Templates");
  });

  test("prints what the file is called and when it was saved, from the upload row", async () => {
    const html = await renderSheet(
      withoutImage(await redshift()),
      upload("Redshift v4.hdc"),
      await builtInSource(),
    );

    // The file on disk is named after its row and its modification time is
    // whenever this app last rewrote it, so the row is the only record of either.
    expect(html).toContain("Redshift v4.hdc");
  });

  test("carries no portrait, since the picture is the character's card now", async () => {
    const html = await renderSheet(
      withoutImage(await redshift()),
      upload(),
      await builtInSource(),
    );
    const withPicture = await renderSheet(await redshift(), upload(), await builtInSource());

    // The same sheet either way, minus a megabyte and a half of base64.
    expect(html.length).toBeLessThan(withPicture.length / 10);
  });

  test("does not stop over a character it cannot fully work out", async () => {
    // Strict mode is off deliberately: a blank where one line should be is
    // recoverable mid-fight, and a blank page is not.
    const html = await renderSheet(
      hdcBytes({ name: "Sparse" }),
      upload("Sparse.hdc"),
      await builtInSource(),
    );
    expect(html).toContain("Sparse");
  });
});
