/**
 * Taking a character file apart in the browser.
 *
 * This is the code that runs before an upload, and none of it is load-bearing:
 * the server does all of it again for a file that reaches it whole. What these
 * tests are for is the difference between a saving and a silent loss — a split
 * that drops the picture costs a character its card, and looks exactly like a
 * file that never had one.
 *
 * It runs here rather than only in a browser because everything but the scaling
 * is plain text work. Where there is no canvas — as here — the picture comes
 * back at the size it was extracted, which is one of the fallbacks this module
 * is built around.
 */

import { describe, expect, test } from "bun:test";
import { splitCharacterFile } from "../src/client/hdc.ts";
import { imageFromHdc, parseHdc } from "../src/server/hero-sheet.ts";
import { hdcBytes } from "./helpers.ts";

const REDSHIFT = "./fixtures/Redshift.hdc";

/** A believable image: real magic bytes, padded past what counts as furniture. */
function image(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < bytes; i += 1) data[i] = (i * 7) % 251;
  return data;
}

const asFile = (bytes: Uint8Array, name = "Hero.hdc") =>
  new File([bytes as BlobPart], name);

const bytesOf = async (file: File) => new Uint8Array(await file.arrayBuffer());

describe("splitting a character file before it is uploaded", () => {
  test("separates a real export into a small file and its picture", async () => {
    const original = await Bun.file(REDSHIFT).arrayBuffer();
    const { hdc, portrait } = await splitCharacterFile(
      new File([original], "Redshift.hdc"),
    );

    // The picture is nearly the whole of what the file weighs.
    expect(original.byteLength).toBe(3719550);
    expect(hdc.size).toBeLessThan(100_000);

    // And it came out whole. HERO Designer wraps it in a CDATA section, across
    // thousands of indented lines; feeding any of that to a base64 decoder is an
    // error rather than a few stray bytes, and the failure is silent — a
    // character with no card, indistinguishable from one that never had a
    // picture.
    expect(portrait).not.toBeNull();
    const picture = await bytesOf(portrait!);
    expect(picture.byteLength).toBe(1342398);
    expect([...picture.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("what is left is still a character file the server can read", async () => {
    const { hdc } = await splitCharacterFile(
      new File([await Bun.file(REDSHIFT).arrayBuffer()], "Redshift.hdc"),
    );

    // Re-encoded UTF-16 big endian with its mark, which is what keeps it a
    // `.hdc` rather than something only this app could read back.
    const stored = await bytesOf(hdc);
    expect([...stored.slice(0, 2)]).toEqual([0xfe, 0xff]);

    const character = parseHdc(stored, "Redshift.hdc");
    expect(character.info.characterName).toBe("Redshift");
    expect(character.image).toBeUndefined();
    expect(character.characteristics.length).toBeGreaterThan(0);
  });

  test("the picture is byte for byte the one the file carried", async () => {
    const original = image(6000);
    const { portrait } = await splitCharacterFile(asFile(hdcBytes({ image: original })));

    // No canvas here, so nothing is scaled and the comparison is exact. What the
    // browser does with it afterwards is the server's business too: it re-fits
    // whatever arrives.
    expect([...(await bytesOf(portrait!))]).toEqual([...original]);
  });

  test("the picture keeps the name the file gave it", async () => {
    const { portrait } = await splitCharacterFile(
      asFile(hdcBytes({ image: image(4096), imageName: "redshift small.png" })),
    );
    expect(portrait!.name).toBe("redshift small.png");
  });

  test("a file with no picture is handed over untouched", async () => {
    const bytes = hdcBytes({ name: "Bare" });
    const { hdc, portrait } = await splitCharacterFile(asFile(bytes));

    expect(portrait).toBeNull();
    expect([...(await bytesOf(hdc))]).toEqual([...bytes]);
  });

  test("a file this cannot make sense of is handed over as it arrived", async () => {
    // Not an error: the upload is about to be refused by the server, which is
    // the one place that decides what a character file is.
    const file = new File(["not a character file at all"], "hero.hdc");
    const { hdc, portrait } = await splitCharacterFile(file);

    expect(hdc).toBe(file);
    expect(portrait).toBeNull();
  });

  test("a picture that will not decode still leaves a filable character", async () => {
    // The character is readable and the picture is not, so the character is what
    // survives — and the server finds nothing where the picture was, which is
    // where it would have been anyway.
    const broken = hdcBytes({ image: image(4096) });
    const text = new TextDecoder("utf-16be").decode(broken).replace("<![CDATA[", "<![CDATA[!!!");
    const bytes = new Uint8Array((text.length + 1) * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff);
    for (let i = 0; i < text.length; i += 1) view.setUint16((i + 1) * 2, text.charCodeAt(i));

    const { hdc, portrait } = await splitCharacterFile(asFile(bytes));
    expect(portrait).toBeNull();
    expect(parseHdc(await bytesOf(hdc)).info.characterName).toBe("Hero");
  });

  test("agrees with the server about what the picture is", async () => {
    // Two readers of the same element — this one by hand, the server's through
    // the renderer's parser. They must not disagree about a character's face.
    const bytes = hdcBytes({ image: image(8000) });
    const { portrait } = await splitCharacterFile(asFile(bytes));

    expect([...(await bytesOf(portrait!))]).toEqual([...imageFromHdc(parseHdc(bytes))!]);
  });
});
