/**
 * Taking a HERO Designer character file apart before it is uploaded.
 *
 * A `.hdc` carries the character's portrait inside it, as base64 in UTF-16 —
 * which costs nearly three bytes for every one of the picture's. It is almost
 * the whole of what one of these files weighs: a 1.3 MB portrait makes a 3.7 MB
 * character file, of which 92 KB is the character.
 *
 * The server can take that apart perfectly well, and still does for a file that
 * reaches it whole. Doing it here first is about what crosses the wire: the same
 * upload becomes tens of kilobytes rather than several megabytes, twice over
 * (the dialog reads the characteristics off a file as it is chosen, and then
 * uploads it), and a character whose portrait would have pushed the file past
 * `UPLOAD_LIMIT_BYTES` can be filed at all.
 *
 * Nothing here is load-bearing. Every step falls back to handing the file over
 * as it arrived, because the server does all of this anyway — this is a saving,
 * never a correctness step, and it must never be the reason a character cannot
 * be filed.
 *
 * The renderer library is not imported. Its decoder uses `Buffer`, and what is
 * needed here — a byte-order mark, one element, and a canvas — is smaller than
 * the shim would be.
 */

import { fitToCard } from "./images.ts";

/** The whole `IMAGE` element, in both the forms an XML writer may produce. */
const IMAGE_ELEMENT = /[ \t]*<IMAGE\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/IMAGE>)\r?\n?/;

/** Its contents and its `FileName`, for the picture and for what to call it. */
const IMAGE_BODY = /<IMAGE\b([^>]*)>([\s\S]*?)<\/IMAGE>/;
const IMAGE_NAME = /FileName="([^"]*)"/;

/** The character's own name, as HERO Designer records it. */
const CHARACTER_NAME = /<CHARACTER_INFO\b[^>]*\bCHARACTER_NAME="([^"]*)"/;

/**
 * The five entities XML defines, which is all an attribute may carry.
 *
 * A name with a quotation mark in it — HERO Designer allows them, and characters
 * with a nickname in their name have them — arrives as `&quot;`, and filing a
 * character under a name with `&quot;` in it is worse than filing it under its
 * filename.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The CDATA section HERO Designer wraps the picture in.
 *
 * Base64 needs no escaping, so the wrapper carries no information — but it is
 * there, and feeding its markers to `atob` is an error rather than a few stray
 * bytes.
 */
const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

export interface SplitCharacter {
  /** The character file with its picture removed. */
  readonly hdc: File;
  /** The picture, sized for a card — null when the file carried none. */
  readonly portrait: File | null;
  /**
   * The name the character gives itself, or null when the file gives none.
   *
   * Null is the answer for an unnamed character and for a file that could not be
   * read at all, because they mean the same thing to a caller: there is nothing
   * here better than the filename.
   */
  readonly name: string | null;
}

/**
 * Decodes a character file, whatever HERO Designer wrote it as.
 *
 * The byte-order mark is the authority and the XML declaration is not: these
 * files are UTF-16 **big** endian with a mark, while the declaration inside says
 * only `encoding="UTF-16"`, so trusting it — or assuming the little-endian
 * default most tools use — gives mojibake for every character in the file.
 *
 * A file with no mark still gives itself away, because XML must begin with `<`:
 * one half of the first code unit is then a zero byte.
 */
function decode(bytes: Uint8Array): { text: string; label: string } {
  const label = bytes[0] === 0xfe && bytes[1] === 0xff
    ? "utf-16be"
    : bytes[0] === 0xff && bytes[1] === 0xfe
    ? "utf-16le"
    : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? "utf-8"
    : bytes[0] === 0x00 && bytes[1] !== 0x00
    ? "utf-16be"
    : bytes[1] === 0x00 && bytes[0] !== 0x00
    ? "utf-16le"
    : "utf-8";
  // `ignoreBOM` defaults to false, which strips the mark rather than leaving it
  // as a zero-width space at the front of the document.
  return { text: new TextDecoder(label).decode(bytes), label };
}

/** Text back to bytes, carrying the mark the file is identified by. */
function encode(text: string, label: string): Uint8Array {
  if (label === "utf-8") {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.byteLength + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }

  const bigEndian = label !== "utf-16le";
  // One code unit per character: `text` is UTF-16 already, so a surrogate pair
  // is two units and copies across unchanged.
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, !bigEndian);
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16((index + 1) * 2, text.charCodeAt(index), !bigEndian);
  }
  return out;
}

/**
 * The portrait out of a character file, sized for the card it is about to
 * become.
 *
 * The picture arrives as bytes rather than as a file — it was never one, it was
 * base64 inside the XML — so the fallback is built here: the bytes as they were
 * extracted, under the name the file gave them. `images.ts` does the rest, and
 * does it identically for a picture the game master chose by hand.
 */
async function fitPortrait(bytes: Uint8Array, name: string): Promise<File> {
  const picture = new Blob([bytes as BlobPart]);
  return await fitToCard(picture, name, new File([picture], name));
}

/**
 * An XML attribute's value as the text it stands for.
 *
 * Numeric references are decoded as well as the named ones. HERO Designer does
 * not write them, but a name that has been through another tool may carry them,
 * and a character called `Ork&#39;s Bane` should be filed under its name.
 */
function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * What the character calls itself, from the text of a character file.
 *
 * A character file is nearly always saved under its character's name, so the
 * filename is usually the same answer — but not always, and it is the file that
 * knows: a character renamed since it was last exported, or one saved as
 * `Redshift (v3 final).hdc`, is filed under the name on the sheet.
 */
function characterName(text: string): string | null {
  const found = CHARACTER_NAME.exec(text)?.[1];
  const name = found === undefined ? "" : unescapeXml(found).trim();
  return name === "" ? null : name;
}

/**
 * A character file separated into the character and its picture.
 *
 * A file with no picture in it comes back with `portrait: null` and its own
 * bytes unchanged — there is nothing to save and nothing to send.
 *
 * The character file is re-encoded in the encoding it arrived in rather than in
 * whatever is cheapest, so what the server stores is still a `.hdc`: a file
 * whose declaration says UTF-16 over UTF-8 bytes is one this app would read and
 * HERO Designer would not.
 */
export async function splitCharacterFile(file: File): Promise<SplitCharacter> {
  const unchanged: SplitCharacter = { hdc: file, portrait: null, name: null };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, label } = decode(bytes);
    // Read before anything can go wrong with the picture, and carried through
    // every path below: a file this cannot take apart is still a file that says
    // what its character is called.
    const named = { ...unchanged, name: characterName(text) };

    const found = IMAGE_BODY.exec(text);
    if (!found) return named;

    const stripped = text.replace(IMAGE_ELEMENT, "");
    if (stripped === text) return named;

    const hdc = new File([encode(stripped, label) as BlobPart], file.name, { type: file.type });

    // Base64 in these files sits inside a CDATA section, wrapped and indented,
    // and `atob` will have neither the markers nor the whitespace.
    const body = found[2]!;
    const encoded = (CDATA.exec(body)?.[1] ?? body).replace(/\s+/g, "");
    let picture: Uint8Array;
    try {
      picture = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    } catch {
      // The picture is unreadable but the character is not, so file the
      // character and let the server find nothing where the picture was.
      return { ...named, hdc, portrait: null };
    }

    const name = IMAGE_NAME.exec(found[1] ?? "")?.[1] ?? "portrait.png";
    return {
      ...named,
      hdc,
      portrait: await fitPortrait(picture, name.replace(/[^\w.\- ]/g, "_")),
    };
  } catch {
    return unchanged;
  }
}
